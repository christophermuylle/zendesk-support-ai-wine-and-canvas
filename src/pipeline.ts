// The core pipeline: fetch ticket -> run rules -> draft with AI -> act.
// Shared by the live webhook server (src/index.ts) and the local mock test
// (scripts/test-local.ts) so both exercise identical logic.

import fs from "node:fs";
import path from "node:path";
import type { IAiDrafter } from "./ai.js";
import type { RulesEngine } from "./rules.js";
import type { LocationResolver } from "./locations.js";
import type { IZendeskClient, ZendeskStatus } from "./zendesk.js";
import type { Mode } from "./config.js";
import {
  ORDER_CONFIRMATION_FIELD_ID,
  ORDER_CONFIRMATION_FIELD_VALUE,
  NEWSLETTER_SIGNUP_FIELD_VALUE,
  PRIVATE_EVENT_DEPOSIT_FIELD_VALUE,
  PRIVATE_EVENT_FINAL_BALANCE_FIELD_VALUE,
  PRIVATE_EVENT_QUOTES_LIVE,
  PRIVATE_EVENT_QUOTE_SENT_TAG,
  PRIVATE_EVENT_FORM_MARKERS,
  PRIVATE_EVENT_CLARIFICATION_SENT_TAG,
  PRIVATE_EVENT_FIELD_VALUE,
  PRIVATE_EVENT_LOCATION_TAG_PREFIX,
  PRIVATE_EVENT_INTERNAL_SENDER_PREFIX,
  PRIVATE_EVENT_INTERNAL_SENDER_DOMAINS,
  PRIVATE_EVENT_INTERNAL_SENDER_ADDRESSES,
} from "./config.js";
import type { DraftResult, RuleDecision, TicketContext } from "./types.js";
import { findDepositLineItem, extractOrderTotal, looksLikePrivateEventFormSubmission, isInternalBrandSender } from "./util.js";
import {
  classifyPrivateEvent,
  resolvePrivateEventLocationKey,
  renderPrivateEventQuote,
  embedImages,
  ASSET_DIR,
  type RenderedQuote,
  type PrivateEventCategory,
  type PrivateEventLocationKey,
} from "./private-event-quotes.js";
import { renderClarifier, type ClarifierKind } from "./private-event-clarifiers.js";

export interface PipelineResult {
  ticketId: number;
  ruleDecision: RuleDecision;
  matchedLocation: string | null;
  // Absent when the rules engine short-circuited to "no_action" or
  // "order_confirmation" (e.g. an out-of-scope-location ticket, or an
  // automated new-order notification) - the AI is never called for those,
  // so there's nothing to draft and no cost incurred.
  draft?: DraftResult;
  finalAction:
    | "posted_public_reply"
    | "posted_internal_note"
    | "skipped_out_of_scope"
    | "order_confirmation_solved_and_closed"
    | "order_confirmation_left_open"
    | "private_event_deposit_pending"
    | "private_event_final_balance_pending"
    | "newsletter_signup_solved_and_closed"
    | "private_event_needs_location"
    | "private_event_clarification_sent"
    | "private_event_held_not_form"
    | "no_op";
  mode: Mode;
}

export interface PipelineDeps {
  zendesk: IZendeskClient;
  rules: RulesEngine;
  locations: LocationResolver;
  ai: IAiDrafter;
  sharedKnowledgeBase: string;
  loadLocationSnippet: (file: string) => string | null;
  mode: Mode;
}

/**
 * Combines the shared knowledge base with the matched location's snippet
 * (if any), so the AI gets location-specific pricing/booking/venue info
 * instead of a generic answer. If no location was identified, the shared
 * doc already instructs the AI to ask rather than guess.
 */
function buildKnowledgeBase(deps: PipelineDeps, ctx: TicketContext): { text: string; locationDisplayName: string | null } {
  const match = deps.locations.resolve(ctx);
  if (!match) {
    return { text: deps.sharedKnowledgeBase, locationDisplayName: null };
  }
  const snippet = deps.loadLocationSnippet(match.file);
  if (!snippet) {
    // Location matched but has no file yet (e.g. Adrian/Cadillac MI) - fall
    // back to shared-only rather than erroring the whole ticket.
    return { text: deps.sharedKnowledgeBase, locationDisplayName: match.displayName };
  }
  const text = `${deps.sharedKnowledgeBase}\n\n---\n\n# Matched location: ${match.displayName}\n\n${snippet}`;
  return { text, locationDisplayName: match.displayName };
}

/**
 * True when an EARLIER "New order" ticket already exists for this event -
 * i.e. this order is a follow-up payment (the final balance) rather than
 * the first one (the deposit). See the order_confirmation branch below for
 * why ticket id ordering stands in for "earlier".
 *
 * Fails safe: if the search errors out we treat the order as the deposit,
 * because wrongly filing a first payment as a "Final Balance" would tell
 * Bonnie an event is fully paid when it isn't.
 */
async function hasEarlierOrderForEvent(
  deps: PipelineDeps,
  ticketId: number,
  eventId: string
): Promise<boolean> {
  try {
    const ids = await deps.zendesk.searchTicketIds(`type:ticket "New order" "${eventId}"`);
    return ids.some((id) => id < ticketId);
  } catch {
    return false;
  }
}

/**
 * A view of the ticket whose "latest customer message" is the customer's
 * WHOLE side of the thread - the original inquiry plus every reply they
 * have sent - used only once a clarifying question has gone out.
 *
 * getTicketMatchText deliberately looks at the latest customer message
 * alone, which is right for a fresh inquiry. It is wrong for an answer to
 * a clarifying question: on ticket #29509 (Taylor Rosand, 2026-09-29) the
 * contact form supplied "Location: Fort Lauderdale, FL" and we asked what
 * the occasion was. She answered "It's a team building, self care evening
 * for my team of therapists" - which names the focus but of course does
 * NOT repeat her location. Matching on that reply alone, the focus was
 * suddenly clear and the LOCATION had gone missing, so she was told her
 * event was still unclear. Every detail the customer has given us has to
 * stay in view.
 */
function withFullCustomerHistory(ctx: TicketContext): TicketContext {
  const customerComments = ctx.comments.filter((c) => c.author_id === ctx.ticket.requester_id);
  const latest = customerComments[customerComments.length - 1];
  if (!latest) return ctx;
  const merged = [ctx.ticket.description ?? "", ...customerComments.map((c) => c.body)].join(String.fromCharCode(10));
  return { ...ctx, comments: ctx.comments.map((c) => (c === latest ? { ...c, body: merged } : c)) };
}

export async function processTicket(deps: PipelineDeps, ticketId: number): Promise<PipelineResult> {
  const ctx: TicketContext = await deps.zendesk.getTicketContext(ticketId);

  const ruleDecision = deps.rules.evaluate(ctx);

  // "no_action" means this ticket is out of scope entirely (e.g. a location
  // we don't provide support for) - never reply to it or answer on its
  // behalf. No AI call, no comment. Only tags are applied.
  //
  // Status: a brand-new ticket gets moved from "new" to "open" so it
  // surfaces in the queue for Bonnie/Amber to notice and forward to
  // whoever actually owns it. It must NOT force status on every reprocess,
  // though - this webhook re-fires on ANY ticket update, including an
  // agent marking the ticket Solved themselves, which re-matches the same
  // rule. Forcing status:"open" unconditionally here was silently
  // reopening tickets agents had just solved seconds earlier - confirmed
  // as the cause of Wine and Canvas (and Painting and Vino) tickets
  // refusing to stay Solved, 2026-09-13. Once a human has moved it off
  // "new" (solved it, left it pending, whatever), leave status alone from
  // then on.
  if (ruleDecision.action === "no_action") {
    const statusUpdate: { status?: ZendeskStatus } = ctx.ticket.status === "new" ? { status: "open" } : {};
    await deps.zendesk.updateTicket(ticketId, { ...statusUpdate, addTags: ruleDecision.addTags });
    return { ticketId, ruleDecision, matchedLocation: null, finalAction: "skipped_out_of_scope", mode: deps.mode };
  }

  // "order_confirmation" - automated "New order" notification tickets from
  // the storefront. Not a real support question, so no AI draft and no
  // reply/comment of any kind, in draft mode or auto mode alike. Three
  // outcomes, per Christopher 2026-09-24 ("None are out of scope"):
  //
  //   total $0 / unparseable -> left Open for a human to check by hand
  //   ordinary seat purchase -> Order Confirmation, Solved, then Closed
  //   private-event deposit  -> Private Event Deposit OR Private Event
  //                             Final Balance, and left Pending
  //
  // "Private" as a keyword is deliberately NOT what picks the private
  // branch - see findDepositLineItem in src/util.ts for the live-data
  // reason (it both over-matches ordinary seat sales and misses the real
  // deposits). The product line naming a Deposit is the signal.
  if (ruleDecision.action === "order_confirmation") {
    const description = ctx.ticket.description ?? "";
    const total = extractOrderTotal(description);

    // $0 or unparseable: something is off with the order, so a human looks
    // at it. Unchanged from the original behaviour.
    if (total === null || total <= 0) {
      await deps.zendesk.updateTicket(ticketId, {
        status: "open",
        addTags: ruleDecision.addTags,
        fields: [{ id: ORDER_CONFIRMATION_FIELD_ID, value: ORDER_CONFIRMATION_FIELD_VALUE }],
      });
      return {
        ticketId,
        ruleDecision,
        matchedLocation: null,
        finalAction: "order_confirmation_left_open",
        mode: deps.mode,
      };
    }

    const deposit = findDepositLineItem(description);

    // Ordinary order: file it and shut it. Solved and Closed are applied
    // as two sequential updates so the ticket passes through Solved on the
    // way to Closed, matching Zendesk's normal status flow (same approach
    // as the newsletter_signup branch below).
    if (!deposit) {
      await deps.zendesk.updateTicket(ticketId, {
        status: "solved",
        addTags: ruleDecision.addTags,
        fields: [{ id: ORDER_CONFIRMATION_FIELD_ID, value: ORDER_CONFIRMATION_FIELD_VALUE }],
      });
      await deps.zendesk.updateTicket(ticketId, { status: "closed" });
      return {
        ticketId,
        ruleDecision,
        matchedLocation: null,
        finalAction: "order_confirmation_solved_and_closed",
        mode: deps.mode,
      };
    }

    // Private-event money. Christopher's rule for telling the two apart
    // (2026-09-24): the FIRST order for a given event is the deposit, any
    // later one is the final balance. "Same event" is the WooCommerce
    // event id embedded in the product's SKU, which is stable across both
    // payments; Zendesk ticket ids increase over time, so an existing
    // order ticket for this event with a LOWER id means a payment already
    // came in before this one.
    //
    // Left Pending, not Solved: money is still outstanding on a deposit,
    // and Pending is what tells Bonnie the ticket is waiting on the
    // customer. Nothing here closes the ticket.
    const alreadyPaidOnce = await hasEarlierOrderForEvent(deps, ticketId, deposit.eventId);
    const fieldValue = alreadyPaidOnce
      ? PRIVATE_EVENT_FINAL_BALANCE_FIELD_VALUE
      : PRIVATE_EVENT_DEPOSIT_FIELD_VALUE;
    await deps.zendesk.updateTicket(ticketId, {
      status: "pending",
      addTags: ruleDecision.addTags,
      fields: [{ id: ORDER_CONFIRMATION_FIELD_ID, value: fieldValue }],
    });
    return {
      ticketId,
      ruleDecision,
      matchedLocation: null,
      finalAction: alreadyPaidOnce ? "private_event_final_balance_pending" : "private_event_deposit_pending",
      mode: deps.mode,
    };
  }

  // "newsletter_signup" - same shape as order_confirmation just above: not
  // a real support question, so no AI call and no reply/comment of any
  // kind, draft or auto mode alike. Sets the "Reason for Customer
  // Contacting Us" field to Newsletter Sign up, then Solves the ticket and
  // immediately Closes it (Christopher, 2026-09-20: "set status to solved
  // and then close it" - applied as two sequential ticket updates so it
  // goes through Solved on the way to Closed, matching Zendesk's normal
  // status flow rather than trying to jump straight to Closed).
  //
  // Matches every city's "<Brand> - <City> Newsletter Sign Up" ticket, not
  // just Indianapolis (Christopher, 2026-09-20: "Every city") - see the
  // newsletter_signup_ticket rule in config/rules.yaml.
  if (ruleDecision.action === "newsletter_signup") {
    await deps.zendesk.updateTicket(ticketId, {
      status: "solved",
      addTags: ruleDecision.addTags,
      fields: [{ id: ORDER_CONFIRMATION_FIELD_ID, value: NEWSLETTER_SIGNUP_FIELD_VALUE }],
    });
    await deps.zendesk.updateTicket(ticketId, { status: "closed" });
    return {
      ticketId,
      ruleDecision,
      matchedLocation: null,
      finalAction: "newsletter_signup_solved_and_closed",
      mode: deps.mode,
    };
  }

  // "private_event_quote" - a private-event inquiry (event_booking_question
  // rule) gets a mechanical, keyword-classified literal template instead of
  // an AI draft - see src/private-event-quotes.ts. No AI call. Christopher,
  // 2026-09-21: "You classify it as keywords in the inquiry form." /
  // "Only show pricing for the location they are asking for and take out
  // the rest" - so if we can't tell which city the inquiry is about, we
  // do NOT guess or show every city's pricing; we hold it for a human to
  // ask instead.
  //
  // Stays held for human review (never auto-sent), regardless of the
  // global MODE, until PRIVATE_EVENT_QUOTES_LIVE=true is explicitly set -
  // Christopher's pacing instruction: "Until we load all templates, keep
  // it to draft mode. Once I have everything sent to you, I will let you
  // know to go live."
  // ---------------------------------------------------------------------
  // One guard for the whole conversational half of the pipeline: never act
  // on a ticket whose newest message is OUR OWN.
  //
  // This webhook fires on every ticket update, including the ones we cause.
  // Five separate incidents in September 2026 were all this same shape,
  // found one ticket at a time:
  //
  //   #29107  a hand-sent quote left no tag, so when the agent replied
  //           later we read her message as a new inquiry and sent the
  //           customer a SECOND copy of the quote
  //   #29490  an agent's reply produced an internal note claiming the
  //           customer had replied, plus a spurious needs_human
  //   #29229  our own 120h follow-up did the same to itself
  //   #29509  our own clarifying question was declared "still unclear
  //           after asking" two seconds after we posted it
  //   #81443  (related) staff mail read as a customer inquiry
  //
  // Each was patched in the branch where it surfaced, which is why the
  // next one kept appearing somewhere else. The rule belongs here instead:
  // if the last person to speak was not the customer, there is nothing for
  // the conversational branches to respond to.
  //
  // Deliberately placed AFTER the mechanical branches above
  // (order_confirmation, newsletter_signup, paypal_receipt and friends):
  // those file an automated notification rather than answer a person, and
  // must still run whoever commented last.
  const newestCommentOnTicket = ctx.comments[ctx.comments.length - 1];
  if (newestCommentOnTicket && newestCommentOnTicket.author_id !== ctx.ticket.requester_id) {
    return {
      ticketId,
      ruleDecision,
      matchedLocation: null,
      finalAction: "no_op",
      mode: deps.mode,
    };
  }

  if (ruleDecision.action === "private_event_quote") {
    // Idempotency guard: send the automated quote once per ticket, never
    // again. Without this, ANY later webhook call for this ticket -
    // including the customer's own reply, since this branch re-runs on
    // every ticket update, not just the first message - can re-match
    // event_booking_question's broad keyword list (people keep saying
    // "party"/"event"/"birthday" while confirming details) and re-send the
    // exact same quote email. Reported by Bonnie 2026-09-22 (ticket
    // #29199 on Painting and Vino - same architecture here, so this brand
    // has the identical exposure): "the same email is sending out over
    // and over." Once PRIVATE_EVENT_QUOTE_SENT_TAG is already on the
    // ticket, any further message is a real reply that needs a human, not
    // another copy of the template.
    if (ctx.ticket.tags.includes(PRIVATE_EVENT_QUOTE_SENT_TAG)) {

      const note = [
        `[PRIVATE EVENT - customer replied after the quote was already sent]`,
        `Matched rule: ${ruleDecision.matchedRule}`,
        ``,
        `A private-event quote was already sent on this ticket, so this looks like the customer's reply rather than a fresh inquiry - needs a human, not another copy of the same quote.`,
      ].join("\n");
      await deps.zendesk.postComment(ticketId, note, {
        isPublic: false,
        addTags: ["needs_human", "private_event_reply_after_quote"],
        fields: [{ id: ORDER_CONFIRMATION_FIELD_ID, value: PRIVATE_EVENT_FIELD_VALUE }],
      });
      return {
        ticketId,
        ruleDecision,
        matchedLocation: null,
        finalAction: "posted_internal_note",
        mode: deps.mode,
      };
    }

    // Internal-sender guard: skip the automatic quote when the requester
    // is one of Wine and Canvas's own internal/licensee mailboxes, not a
    // real customer - see PRIVATE_EVENT_INTERNAL_SENDER_PREFIX in
    // src/config.ts for the two real tickets (#29225 Kiara Kelly, #29206
    // Amanda Winden) that motivated this. Checked before location
    // resolution since there's no point resolving a location for a
    // message that was never a real inquiry in the first place.
    if (isInternalBrandSender(ctx.requester?.email, PRIVATE_EVENT_INTERNAL_SENDER_PREFIX, PRIVATE_EVENT_INTERNAL_SENDER_DOMAINS, PRIVATE_EVENT_INTERNAL_SENDER_ADDRESSES)) {
      const note = [
        `[PRIVATE EVENT - sender looks internal, not a customer]`,
        `Matched rule: ${ruleDecision.matchedRule}`,
        ``,
        `Requester email (${ctx.requester?.email ?? "unknown"}) matches this brand's own internal/licensee mailbox pattern, not a real customer's address - skipping the automatic quote so a human can check who this is actually from and reply appropriately.`,
      ].join("\n");
      await deps.zendesk.postComment(ticketId, note, {
        isPublic: false,
        addTags: ["needs_human", "private_event_internal_sender"],
      });
      return {
        ticketId,
        ruleDecision,
        matchedLocation: null,
        finalAction: "posted_internal_note",
        mode: deps.mode,
      };
    }

    // Once we have asked a clarifying question, judge the focus and the
    // location against everything the customer has told us, not just their
    // newest sentence - see withFullCustomerHistory above (#29509).
    const privateEventCtx = ctx.ticket.tags.includes(PRIVATE_EVENT_CLARIFICATION_SENT_TAG)
      ? withFullCustomerHistory(ctx)
      : ctx;
    const location = deps.locations.resolve(privateEventCtx);
    const locationKey = location ? resolvePrivateEventLocationKey(ctx, location.slug) : null;
    const category = classifyPrivateEvent(privateEventCtx);

    // A location we matched but have no private-event pricing for is NOT
    // something the customer can clear up - they already told us where
    // they are. That still goes straight to a human.
    if (location && !locationKey) {
      const note = [
        `[PRIVATE EVENT QUOTE - needs human]`,
        `Matched rule: ${ruleDecision.matchedRule}`,
        ``,
        `Matched "${location.displayName}", but that location isn't in the private-event pricing table yet, so no quote was generated. A human needs to confirm the location before sending pricing.`,
      ].join("\n");
      await deps.zendesk.postComment(ticketId, note, {
        isPublic: false,
        addTags: [...(ruleDecision.addTags ?? []), "private_event_needs_location"],
        fields: [{ id: ORDER_CONFIRMATION_FIELD_ID, value: PRIVATE_EVENT_FIELD_VALUE }],
      });
      return {
        ticketId,
        ruleDecision,
        matchedLocation: location.displayName,
        finalAction: "private_event_needs_location",
        mode: deps.mode,
      };
    }

    // THE GATE. Nothing goes out to a customer from this branch unless the
    // ticket began as a real private-event form submission.
    //
    // Christopher, 2026-09-30: "Only auto-quote what came through the
    // private-event form. If not a private event form it should be made a
    // draft if it isn't 100% sure."
    //
    // This is the safeguard the narrower fixes could not be. Keyword
    // matching on free-form email is open-ended - our own marketing copy
    // quoted back to us was enough to trigger a send (#81500) - so instead
    // of trying to enumerate what must not match, this enumerates the one
    // thing that may: a structured submission from the form itself.
    // Everything else becomes a draft for a human.
    //
    // Every misfire this month came in as free-form email: #81443 (staff
    // mailbox), #81500 (a booked customer's quoted confirmation), #81301
    // and #81302 (agent threads). None would pass this gate.
    if (!looksLikePrivateEventFormSubmission(ctx, PRIVATE_EVENT_FORM_MARKERS)) {
      const detail =
        locationKey && category
          ? `A quote for ${location?.displayName ?? locationKey} (${category}) would be the obvious reply - please review it and send by hand if it fits.`
          : `We could not confidently tell the focus${locationKey ? "" : " or the location"} of this event either.`;
      const note = [
        `[PRIVATE EVENT - not a form submission, held for review]`,
        `Matched rule: ${ruleDecision.matchedRule}`,
        `This did not arrive through the private-event form, so nothing has been sent automatically. ${detail}`,
      ].join(String.fromCharCode(10));
      await deps.zendesk.postComment(ticketId, note, {
        isPublic: false,
        addTags: [...(ruleDecision.addTags ?? []), "needs_human", "private_event_not_form_submission"],
        fields: [{ id: ORDER_CONFIRMATION_FIELD_ID, value: PRIVATE_EVENT_FIELD_VALUE }],
      });
      return {
        ticketId,
        ruleDecision,
        matchedLocation: location?.displayName ?? null,
        finalAction: "private_event_held_not_form",
        mode: deps.mode,
      };
    }

    // Christopher, 2026-09-25: when we can't tell the event's FOCUS or its
    // LOCATION, ask instead of guessing. On this brand that is the common
    // case, because the contact form has no occasion field - see
    // src/private-event-clarifiers.ts.
    const needsFocus = category === null;
    const needsLocation = !locationKey;

    if (needsFocus || needsLocation) {
      // Ask once and only once. If they answered and it's STILL not clear,
      // a second round of questions would read as badgering - hand it to a
      // human instead.
      if (ctx.ticket.tags.includes(PRIVATE_EVENT_CLARIFICATION_SENT_TAG)) {

        const missing = [needsFocus ? "focus" : null, needsLocation ? "location" : null].filter(Boolean).join(" and ");
        const note = [
          `[PRIVATE EVENT - still unclear after asking]`,
          `Matched rule: ${ruleDecision.matchedRule}`,
          ``,
          `We already asked this customer to confirm the ${missing} of their event and their reply still doesn't make it clear, so no quote has been sent. Please read the thread and reply by hand rather than sending another round of questions.`,
        ].join("\n");
        await deps.zendesk.postComment(ticketId, note, {
          isPublic: false,
          addTags: ["needs_human", "private_event_still_unclear"],
        fields: [{ id: ORDER_CONFIRMATION_FIELD_ID, value: PRIVATE_EVENT_FIELD_VALUE }],
        });
        return {
          ticketId,
          ruleDecision,
          matchedLocation: location?.displayName ?? null,
          finalAction: "posted_internal_note",
          mode: deps.mode,
        };
      }

      const kind: ClarifierKind = needsFocus && needsLocation ? "both" : needsFocus ? "focus" : "location";
      const clarifier = renderClarifier(ctx, kind);

      // Same pacing gate as the quote itself (Christopher, 2026-09-21:
      // "Until we load all templates, keep it to draft mode. Once I have
      // everything sent to you, I will let you know to go live."). A
      // clarifying question is still an email to a customer, so it must
      // not slip out while the private-event system is in draft.
      if (!PRIVATE_EVENT_QUOTES_LIVE) {
        const note = [
          `[PRIVATE EVENT - clarifying question needed, NOT sent]`,
          `Matched rule: ${ruleDecision.matchedRule}`,
          `Unclear: ${[needsFocus ? "focus" : null, needsLocation ? "location" : null].filter(Boolean).join(" and ")}`,
          `PRIVATE_EVENT_QUOTES_LIVE is off, so this was not sent - a human should review and send it manually.`,
          ``,
          clarifier.plainBody,
        ].join("\n");
        await deps.zendesk.postComment(ticketId, note, {
          isPublic: false,
          addTags: [...(ruleDecision.addTags ?? []), "ai_draft_pending_review", "private_event_clarification_pending"],
          fields: [{ id: ORDER_CONFIRMATION_FIELD_ID, value: PRIVATE_EVENT_FIELD_VALUE }],
        });
        return {
          ticketId,
          ruleDecision,
          matchedLocation: location?.displayName ?? null,
          finalAction: "posted_internal_note",
          mode: deps.mode,
        };
      }

      await deps.zendesk.postComment(ticketId, clarifier.plainBody, {
        isPublic: true,
        // Pending, not solved - we're waiting on the customer's answer.
        // Deliberately does NOT get PRIVATE_EVENT_QUOTE_SENT_TAG: no quote
        // has gone out, so the 24h/72h/120h follow-up sequence must not
        // start yet.
        status: "pending",
        htmlBody: clarifier.htmlBody,
        addTags: [...(ruleDecision.addTags ?? []), PRIVATE_EVENT_CLARIFICATION_SENT_TAG],
        fields: [{ id: ORDER_CONFIRMATION_FIELD_ID, value: PRIVATE_EVENT_FIELD_VALUE }],
      });
      return {
        ticketId,
        ruleDecision,
        matchedLocation: location?.displayName ?? null,
        finalAction: "private_event_clarification_sent",
        mode: deps.mode,
      };
    }

    const quote: RenderedQuote = renderPrivateEventQuote(ctx, category, locationKey);

    if (!PRIVATE_EVENT_QUOTES_LIVE) {
      const note = formatPrivateEventInternalNote(ruleDecision, category, location!.displayName, quote);
      await deps.zendesk.postComment(ticketId, note, {
        isPublic: false,
        addTags: [...(ruleDecision.addTags ?? []), "ai_draft_pending_review", `private_event_${category}`],
        fields: [{ id: ORDER_CONFIRMATION_FIELD_ID, value: PRIVATE_EVENT_FIELD_VALUE }],
      });
      return { ticketId, ruleDecision, matchedLocation: location!.displayName, finalAction: "posted_internal_note", mode: deps.mode };
    }

    // Live: upload each embedded photo (see quote.imageAssets), splice the
    // resulting content_urls into the HTML body, and send publicly.
    const uploadTokens: string[] = [];
    const uploadedImages: Array<{ key: string; contentUrl: string }> = [];
    for (const asset of quote.imageAssets) {
      const data = fs.readFileSync(path.join(process.cwd(), ASSET_DIR, asset.filename));
      const { token, contentUrl } = await deps.zendesk.uploadFile(asset.filename, asset.contentType, data);
      uploadTokens.push(token);
      uploadedImages.push({ key: asset.key, contentUrl });
    }
    const htmlBody = embedImages(quote.htmlBody, uploadedImages);

    await deps.zendesk.postComment(ticketId, quote.plainBody, {
      isPublic: true,
      status: "pending", // waiting on the customer to confirm a date, not "solved" - lets the follow-up sequence pick it up
      htmlBody,
      uploadTokens,
      // Christopher, 2026-09-25: "Reason for contacting us should be
      // Private Event for Wine and Canvas."
      fields: [{ id: ORDER_CONFIRMATION_FIELD_ID, value: PRIVATE_EVENT_FIELD_VALUE }],
      addTags: [
        ...(ruleDecision.addTags ?? []),
        `private_event_${category}`,
        // Added 2026-09-22 alongside the follow-up sequence (src/followups.ts):
        // PRIVATE_EVENT_QUOTE_SENT_TAG is the poller's entry-point tag, the
        // category-suffixed one lets it pick the right email 2 variant
        // without re-deriving it from ticket text, and the location tag
        // (using this brand's fine-grained PrivateEventLocationKey, e.g.
        // "private_event_location_naples" - NOT the coarser locations.yaml
        // slug, which doesn't distinguish Naples from Fort Myers) lets it
        // pick the right calendar link and promo code pool at email 3.
        PRIVATE_EVENT_QUOTE_SENT_TAG,
        `${PRIVATE_EVENT_QUOTE_SENT_TAG}_${category}`,
        `${PRIVATE_EVENT_LOCATION_TAG_PREFIX}${locationKey}`,
      ],
    });
    return { ticketId, ruleDecision, matchedLocation: location!.displayName, finalAction: "posted_public_reply", mode: deps.mode };
  }

  const { text: knowledgeBase, locationDisplayName } = buildKnowledgeBase(deps, ctx);
  const draft = await deps.ai.draftReply(ctx, knowledgeBase, ruleDecision);

  // The rules engine can force human review (e.g. refunds, angry customers)
  // regardless of MODE. Otherwise MODE=draft always holds for review too.
  const mustHoldForHuman = ruleDecision.forceHumanReview || deps.mode === "draft";

  let finalAction: PipelineResult["finalAction"] = "no_op";

  if (mustHoldForHuman) {
    const note = formatInternalNote(ruleDecision, draft);
    await deps.zendesk.postComment(ticketId, note, {
      isPublic: false,
      addTags: [...(ruleDecision.addTags ?? []), "ai_draft_pending_review"],
    });
    finalAction = "posted_internal_note";
  } else {
    await deps.zendesk.postComment(ticketId, draft.replyBody, {
      isPublic: true,
      status: draft.suggestedAction,
      addTags: ruleDecision.addTags,
    });
    finalAction = "posted_public_reply";
  }

  return { ticketId, ruleDecision, matchedLocation: locationDisplayName, draft, finalAction, mode: deps.mode };
}

function formatInternalNote(rule: RuleDecision, draft: DraftResult): string {
  return [
    `[AI DRAFT - awaiting human review]`,
    `Matched rule: ${rule.matchedRule} | Suggested action: ${draft.suggestedAction} | Confidence: ${draft.confidence}`,
    ``,
    `Suggested reply:`,
    draft.replyBody,
    ``,
    `Reasoning: ${draft.reasoning}`,
  ].join("\n");
}

function formatPrivateEventInternalNote(
  rule: RuleDecision,
  category: PrivateEventCategory,
  locationDisplayName: string,
  quote: RenderedQuote
): string {
  return [
    `[PRIVATE EVENT QUOTE - awaiting human review]`,
    `Matched rule: ${rule.matchedRule} | Category: ${category} | Location: ${locationDisplayName}`,
    `PRIVATE_EVENT_QUOTES_LIVE is off, so this will never auto-send - a human must review and send it manually.`,
    ``,
    `Quote that would be sent:`,
    quote.plainBody,
    quote.imageAssets.length
      ? `\n(Images that would be attached: ${quote.imageAssets.map((a) => a.filename).join(", ")})`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
