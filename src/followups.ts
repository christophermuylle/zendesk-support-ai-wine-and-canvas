// Private event "no response" follow-up sequence (Christopher, 2026-09-22,
// sent alongside Painting and Vino's own copy on the same cadence): three
// emails, all counted from the SAME anchor - when the original quote went
// out - not from each other:
//   - Email 1 at 24h, if still pending with no customer reply.
//   - Email 2 at 72h (Corporate or Standard variant), same condition.
//   - Email 3 at 120h: includes a one-time $10 promo code. Leaves the
//     ticket PENDING, like the other two.
//
// Christopher, 2026-09-24: "You should never close Private Event tickets
// as closed. Only pending. Let the human solve and close them." Email 3
// used to Solve the ticket as the sequence's end, which is why a batch of
// private-event tickets ended up Solved with no human ever having looked
// at them. Nothing in this file sets any status other than "pending" now;
// the FOLLOW_UP_3_SENT_TAG is what ends the sequence, not the status, so
// a ticket sitting in pending after email 3 is picked up by the sweep,
// matched by nextStage() as all-sent, and skipped without re-sending.
//
// This runs as a periodic sweep (see index.ts's setInterval), NOT off the
// Zendesk ticket-update webhook - unlike every other rule in this codebase,
// "24 hours have now passed" isn't a ticket update Zendesk can notify us
// about, so this has to poll instead. Architecture mirrors Painting and
// Vino's src/followups.ts, adapted for this brand's finer-grained
// 9-location private-event system (fort-myers/naples/tampa/orlando/
// fort-lauderdale/miami/indianapolis/grand-rapids/cadillac - see
// src/private-event-quotes.ts) and its THREE regional promo code pools
// instead of one shared pool.
//
// ANCHOR TIMESTAMP: the "quote sent" moment is taken to be the first PUBLIC
// comment on the ticket authored by someone other than the requester (i.e.
// our own reply, not the customer's original inbound message) - this is a
// reasonable proxy given this rule's architecture (the quote is normally
// the very first agent reply on a fresh ticket) but isn't literally tracked
// as its own field. If an agent ever posts an earlier unrelated public
// reply on a ticket before the quote, this would anchor to the wrong
// comment - worth a dedicated Zendesk custom field storing the actual send
// time if that turns out to matter in practice.

import type { IZendeskClient } from "./zendesk.js";
import {
  PRIVATE_EVENT_QUOTE_SENT_TAG,
  PRIVATE_EVENT_LOCATION_TAG_PREFIX,
  FOLLOW_UP_1_SENT_TAG,
  FOLLOW_UP_2_SENT_TAG,
  FOLLOW_UP_3_SENT_TAG,
} from "./config.js";
import type { PrivateEventCategory, PrivateEventLocationKey } from "./private-event-quotes.js";
import { getLocationInfo } from "./private-event-quotes.js";
import { renderEmail1, renderEmail2, renderEmail3 } from "./followup-templates.js";
import { loadPromoCodeConfig, claimNextCode, type PromoPool } from "./promo-codes.js";

const HOURS_STAGE_1 = 24;
const HOURS_STAGE_2 = 72;
const HOURS_STAGE_3 = 120;

/**
 * Minimum hours between two automated messages on the same ticket,
 * regardless of what the stage thresholds say. See the guard in
 * processCandidate for the incident this exists to prevent.
 */
const MIN_HOURS_BETWEEN_SENDS = 24;

// ---------------------------------------------------------------------------
// Per-location calendar link (email 3's "browse upcoming events" link) and
// promo code pool - both confirmed by Christopher 2026-09-22.
//
// CALENDAR LINKS: sourced from each location's own "Direct link" line in
// config/knowledge-base/locations/*.md wherever that file exists. Naples
// and Miami have no dedicated public event page of their own (they're
// pricing-only sub-keys of Fort Myers and Fort Lauderdale respectively -
// see private-event-quotes.ts's resolvePrivateEventLocationKey), so they
// fall back to sharing their parent location's link, same as browsing the
// actual site would show. Indianapolis's link here
// (wineandcanvas.com/indianapolis/events/) intentionally differs from
// indianapolis.md's own "Direct link" (wineandcanvas.com/indianapolis/,
// no /events/) - Christopher specifically confirmed the /events/ version
// for this follow-up email when asked about the discrepancy, so this map
// does NOT reuse getLocationInfo/indianapolis.md's link. Cadillac has no
// page at all (confirmed in cadillac.md) - null here, which
// renderEmail3 in followup-templates.ts renders as a phone/email fallback
// line instead of guessing a link.
const PRIVATE_EVENT_LOCATION_CALENDAR_LINKS: Record<PrivateEventLocationKey, string | null> = {
  "fort-myers": "https://wineandcanvas.com/florida/fort-myers/",
  naples: "https://wineandcanvas.com/florida/fort-myers/",
  tampa: "https://wineandcanvas.com/florida/tampa/",
  orlando: "https://wineandcanvas.com/florida/orlando/",
  "fort-lauderdale": "https://wineandcanvas.com/florida/fort-lauderdale/",
  miami: "https://wineandcanvas.com/florida/fort-lauderdale/",
  indianapolis: "https://wineandcanvas.com/indianapolis/events/",
  "grand-rapids": "https://wineandcanvas.com/michigan/grand-rapids/",
  cadillac: null,
};

// PROMO POOL: matches how Christopher split the three code sheets he sent
// 2026-09-22 (Indianapolis / Michigan / florida $10 One Time Codes) - see
// src/promo-codes.ts's file header for the sheet IDs. Kalamazoo and
// Lansing are never reached here at all (out_of_scope_location excludes
// them before event_booking_question, per Christopher: "You don't answer
// Lansing or Kalamazoo private event requests anyway"), so they don't
// appear in this map.
const PRIVATE_EVENT_LOCATION_PROMO_POOL: Record<PrivateEventLocationKey, PromoPool> = {
  "fort-myers": "florida",
  naples: "florida",
  tampa: "florida",
  orlando: "florida",
  "fort-lauderdale": "florida",
  miami: "florida",
  indianapolis: "indianapolis",
  "grand-rapids": "michigan",
  cadillac: "michigan",
};

export interface FollowUpDeps {
  zendesk: IZendeskClient;
}

export interface FollowUpSweepResult {
  checked: number;
  sent: { stage: 1 | 2 | 3; ticketId: number }[];
  errors: { ticketId: number; error: string }[];
}

function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60);
}

function firstName(name: string | null | undefined): string {
  if (!name) return "there";
  return name.trim().split(/\s+/)[0] || "there";
}

function eventCategoryFromTags(tags: string[]): PrivateEventCategory | null {
  for (const cat of ["fundraiser", "kids", "standard", "corporate"] as const) {
    if (tags.includes(`${PRIVATE_EVENT_QUOTE_SENT_TAG}_${cat}`)) return cat;
  }
  return null;
}

function locationKeyFromTags(tags: string[]): PrivateEventLocationKey | null {
  const t = tags.find((tag) => tag.startsWith(PRIVATE_EVENT_LOCATION_TAG_PREFIX));
  if (!t) return null;
  const key = t.slice(PRIVATE_EVENT_LOCATION_TAG_PREFIX.length);
  return key in PRIVATE_EVENT_LOCATION_CALENDAR_LINKS ? (key as PrivateEventLocationKey) : null;
}

/** Which stage (1, 2, or 3) is next for this ticket, or null if all three have already been sent. */
function nextStage(tags: string[]): 1 | 2 | 3 | null {
  if (!tags.includes(FOLLOW_UP_1_SENT_TAG)) return 1;
  if (!tags.includes(FOLLOW_UP_2_SENT_TAG)) return 2;
  if (!tags.includes(FOLLOW_UP_3_SENT_TAG)) return 3;
  return null;
}

type CandidateOutcome = "sent" | "skipped_not_due" | "skipped_not_eligible" | "skipped_all_sent";

async function processCandidate(
  deps: FollowUpDeps,
  ticketId: number
): Promise<{ outcome: CandidateOutcome; stage?: 1 | 2 | 3 }> {
  const ctx = await deps.zendesk.getTicketContext(ticketId);

  // Re-check eligibility for real, even though the search query already
  // filtered on tag+status - a customer reply (which flips status off
  // "pending") or a human editing tags between the search and this fetch
  // should never result in a follow-up firing anyway.
  if (ctx.ticket.status !== "pending") return { outcome: "skipped_not_eligible" };
  const tags = ctx.ticket.tags;
  if (!tags.includes(PRIVATE_EVENT_QUOTE_SENT_TAG)) return { outcome: "skipped_not_eligible" };

  const stage = nextStage(tags);
  if (stage === null) return { outcome: "skipped_all_sent" };

  // The quote itself - see file header note on why "first public comment
  // NOT from the requester" is used as the anchor.
  const outbound = ctx.comments.filter((c) => c.public && c.author_id !== ctx.ticket.requester_id);
  const quoteComment = outbound[0];
  if (!quoteComment) return { outcome: "skipped_not_eligible" }; // shouldn't happen - we only tag after posting one

  const threshold = stage === 1 ? HOURS_STAGE_1 : stage === 2 ? HOURS_STAGE_2 : HOURS_STAGE_3;
  if (hoursSince(quoteComment.created_at) < threshold) return { outcome: "skipped_not_due" };

  // Minimum gap between anything we send. All three thresholds are measured
  // from the SAME anchor, so a ticket that only becomes eligible after the
  // anchor is already old has every stage "due" at once - and the sweep
  // would then fire stages 1, 2 and 3 on consecutive ticks, minutes apart.
  //
  // That is not hypothetical: on 2026-09-24 tickets #29001 (Nigel
  // Fernandez) and #29107 each received three to four automated emails
  // inside half an hour, because they had been quoted BY HAND on 2026-09-18
  // and only got tagged days later - 150h since the anchor, so all three
  // thresholds were long past. Every redeploy made it worse by running an
  // extra sweep on startup (fixed separately in src/index.ts).
  //
  // The narrowest gap the cadence ever intends is 24h (quote -> email 1;
  // the later gaps are 48h each), so nothing automated may go out within
  // 24h of our own last outbound message on the ticket. A ticket with a
  // stale anchor now walks through the sequence a day at a time instead of
  // emptying it in one afternoon.
  const lastOutbound = outbound[outbound.length - 1];
  if (hoursSince(lastOutbound.created_at) < MIN_HOURS_BETWEEN_SENDS) return { outcome: "skipped_not_due" };

  const stageTag = stage === 1 ? FOLLOW_UP_1_SENT_TAG : stage === 2 ? FOLLOW_UP_2_SENT_TAG : FOLLOW_UP_3_SENT_TAG;
  const first = firstName(ctx.requester?.name);

  if (stage === 1) {
    await deps.zendesk.postComment(ticketId, renderEmail1(), {
      isPublic: true,
      status: "pending",
      addTags: [stageTag],
    });
    return { outcome: "sent", stage };
  }

  if (stage === 2) {
    const category = eventCategoryFromTags(tags) ?? "standard";
    await deps.zendesk.postComment(ticketId, "", {
      isPublic: true,
      status: "pending",
      addTags: [stageTag],
      htmlBody: renderEmail2(first, category),
    });
    return { outcome: "sent", stage };
  }

  // Stage 3 - needs a promo code from the right regional Google Sheet
  // before it can send.
  const locationKey = locationKeyFromTags(tags);
  const promoCfg = loadPromoCodeConfig();
  if (!promoCfg) {
    console.error(
      `[followups] ticket ${ticketId}: email 3 is due but the Google Sheets promo code integration isn't configured yet ` +
        `(missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY - see src/promo-codes.ts). ` +
        `Tagging for a human to send it manually instead of blocking the whole sweep.`
    );
    await deps.zendesk.updateTicket(ticketId, { addTags: ["needs_human", `${stageTag}_needs_manual_code`] });
    return { outcome: "skipped_not_eligible" };
  }
  if (!locationKey) {
    console.error(
      `[followups] ticket ${ticketId}: email 3 is due but no private-event location tag was found, so the right ` +
        `promo code pool can't be determined. Tagging for a human instead of guessing a pool.`
    );
    await deps.zendesk.updateTicket(ticketId, { addTags: ["needs_human", `${stageTag}_needs_manual_code`] });
    return { outcome: "skipped_not_eligible" };
  }

  const pool = PRIVATE_EVENT_LOCATION_PROMO_POOL[locationKey];
  const code = await claimNextCode(promoCfg, pool);
  if (!code) {
    console.error(
      `[followups] ticket ${ticketId}: email 3 is due but the "${pool}" promo code pool is EMPTY. Tagging for a human - ` +
        `Christopher needs to add more codes to that sheet.`
    );
    await deps.zendesk.updateTicket(ticketId, { addTags: ["needs_human", `${stageTag}_needs_manual_code`] });
    return { outcome: "skipped_not_eligible" };
  }

  const displayName = getLocationInfo(locationKey).displayName;
  const calendarLink = PRIVATE_EVENT_LOCATION_CALENDAR_LINKS[locationKey];

  await deps.zendesk.postComment(ticketId, "", {
    isPublic: true,
    // Pending, never "solve" - see the Christopher 2026-09-24 note in this
    // file's header. A human solves and closes private-event tickets.
    status: "pending",
    addTags: [stageTag],
    htmlBody: renderEmail3(code, displayName, calendarLink),
  });
  return { outcome: "sent", stage };
}

/**
 * Runs one sweep: finds every still-pending, quoted private-event ticket
 * and sends whichever follow-up (if any) is now due. Safe to call
 * repeatedly/concurrently-in-spirit (each stage's tag is the idempotency
 * guard - a ticket already at stage N never re-sends stage N).
 */
export async function runFollowUpSweep(deps: FollowUpDeps): Promise<FollowUpSweepResult> {
  const candidateIds = await deps.zendesk.searchTicketIds(
    `type:ticket status:pending tags:${PRIVATE_EVENT_QUOTE_SENT_TAG}`
  );

  const result: FollowUpSweepResult = { checked: candidateIds.length, sent: [], errors: [] };
  for (const ticketId of candidateIds) {
    try {
      const { outcome, stage } = await processCandidate({ zendesk: deps.zendesk }, ticketId);
      if (outcome === "sent" && stage) result.sent.push({ ticketId, stage });
    } catch (err) {
      result.errors.push({ ticketId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
