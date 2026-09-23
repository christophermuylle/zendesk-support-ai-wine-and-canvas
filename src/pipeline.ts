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
  PRIVATE_EVENT_QUOTES_LIVE,
  PRIVATE_EVENT_QUOTE_SENT_TAG,
  PRIVATE_EVENT_LOCATION_TAG_PREFIX,
  PRIVATE_EVENT_INTERNAL_SENDER_PREFIX,
} from "./config.js";
import type { DraftResult, RuleDecision, TicketContext } from "./types.js";
import { extractOrderTotal, isInternalBrandSender } from "./util.js";
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
    | "order_confirmation_solved"
    | "order_confirmation_left_open"
    | "newsletter_signup_solved_and_closed"
    | "private_event_needs_location"
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

  // "order_confirmation" is a purely mechanical rule for automated "New
  // order" notification tickets from the storefront - it's not a real
  // support question, so no AI draft and no reply/comment of any kind, in
  // draft mode or auto mode alike. We just categorize the ticket (which
  // also auto-applies Zendesk's "order_confirmation" tag via the tagger
  // field) and close it - UNLESS the order total is $0 or unparseable, in
  // which case it's left Open for a human to check by hand.
  if (ruleDecision.action === "order_confirmation") {
    const total = extractOrderTotal(ctx.ticket.description ?? "");
    const status: ZendeskStatus = total !== null && total > 0 ? "solved" : "open";
    await deps.zendesk.updateTicket(ticketId, {
      status,
      addTags: ruleDecision.addTags,
      fields: [{ id: ORDER_CONFIRMATION_FIELD_ID, value: ORDER_CONFIRMATION_FIELD_VALUE }],
    });
    return {
      ticketId,
      ruleDecision,
      matchedLocation: null,
      finalAction: status === "solved" ? "order_confirmation_solved" : "order_confirmation_left_open",
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
    if (isInternalBrandSender(ctx.requester?.email, PRIVATE_EVENT_INTERNAL_SENDER_PREFIX)) {
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

    const location = deps.locations.resolve(ctx);
    const locationKey = location ? resolvePrivateEventLocationKey(ctx, location.slug) : null;

    if (!location || !locationKey) {
      const note = [
        `[PRIVATE EVENT QUOTE - needs human]`,
        `Matched rule: ${ruleDecision.matchedRule}`,
        ``,
        `Could not determine which city this private-event inquiry is for` +
          (location ? ` (matched "${location.displayName}", but that location isn't in the private-event pricing table yet)` : "") +
          `, so no quote was generated. A human needs to confirm the location before sending pricing.`,
      ].join("\n");
      await deps.zendesk.postComment(ticketId, note, {
        isPublic: false,
        addTags: [...(ruleDecision.addTags ?? []), "private_event_needs_location"],
      });
      return {
        ticketId,
        ruleDecision,
        matchedLocation: location?.displayName ?? null,
        finalAction: "private_event_needs_location",
        mode: deps.mode,
      };
    }

    const category: PrivateEventCategory = classifyPrivateEvent(ctx);
    const quote: RenderedQuote = renderPrivateEventQuote(ctx, category, locationKey);

    if (!PRIVATE_EVENT_QUOTES_LIVE) {
      const note = formatPrivateEventInternalNote(ruleDecision, category, location.displayName, quote);
      await deps.zendesk.postComment(ticketId, note, {
        isPublic: false,
        addTags: [...(ruleDecision.addTags ?? []), "ai_draft_pending_review", `private_event_${category}`],
      });
      return { ticketId, ruleDecision, matchedLocation: location.displayName, finalAction: "posted_internal_note", mode: deps.mode };
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
    return { ticketId, ruleDecision, matchedLocation: location.displayName, finalAction: "posted_public_reply", mode: deps.mode };
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
