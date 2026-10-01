// Daily private-event digest for Christopher and Jessica.
//
// Christopher, 2026-09-30: "Let Jess and I know how many Private Event
// Inquiries came in, what territory they are for, basic event details and
// where in the process are they. Have they responded? Did they receive
// follow up emails yet? Are they ready to book?"
//
// Delivered as a Zendesk ticket addressed to them and created already
// solved: the service already holds Zendesk credentials, so this needs no
// mail server, no SMTP secret and no new integration, and every digest
// stays searchable in Zendesk afterwards.

import type { IZendeskClient } from "./zendesk.js";
import type { ZendeskTicket } from "./types.js";
import { extractFormContactNameFromText } from "./util.js";
import {
  PRIVATE_EVENT_FIELD_VALUE,
  PRIVATE_EVENT_LOCATION_TAG_PREFIX,
  PRIVATE_EVENT_QUOTE_SENT_TAG,
  FOLLOW_UP_1_SENT_TAG,
  FOLLOW_UP_2_SENT_TAG,
  FOLLOW_UP_3_SENT_TAG,
} from "./config.js";

export const DIGEST_TAG = "private_event_digest";

export interface DigestConfig {
  brandLabel: string;
  to: string;
  cc: string[];
}

interface Row {
  id: number;
  who: string;
  territory: string;
  focus: string;
  guests: string;
  date: string;
  stage: string;
}

function tagValue(tags: string[], prefix: string): string | null {
  const t = tags.find((x) => x.startsWith(prefix));
  return t ? t.slice(prefix.length) : null;
}

function prettify(slug: string | null): string {
  if (!slug) return "unknown";
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Pulls "Guests: 12" / "Number of Expected Guests 12" and a date out of the form body. */
function field(text: string, patterns: RegExp[]): string {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) return m[1].trim();
  }
  return "—";
}

function followUpsSent(tags: string[]): string {
  const stages = [FOLLOW_UP_1_SENT_TAG, FOLLOW_UP_2_SENT_TAG, FOLLOW_UP_3_SENT_TAG].filter((t) => tags.includes(t)).length;
  if (!stages) return "no follow-ups yet";
  return `${stages} of 3 follow-ups sent`;
}

function toRow(t: ZendeskTicket, stage: string): Row {
  const body = t.description ?? "";
  return {
    id: t.id,
    // The customer's name from the form body, NOT the subject: both
    // brands' forms use one fixed subject on every ticket ("New Private
    // Event Inquiry"), so a subject-keyed digest is a wall of identical
    // rows. Subject is the fallback for anything that did not come through
    // the form.
    who:
      extractFormContactNameFromText(body) ??
      ((t.subject ?? "").replace(/^(re:|fwd:)\s*/i, "").slice(0, 46) || `#${t.id}`),
    territory: prettify(tagValue(t.tags, PRIVATE_EVENT_LOCATION_TAG_PREFIX)),
    focus: prettify(tagValue(t.tags, `${PRIVATE_EVENT_QUOTE_SENT_TAG}_`)),
    guests: field(body, [/guests?:?\s*\**\s*(\d{1,4})/i, /number of expected guests\s*\**\s*(\d{1,4})/i]),
    date: field(body, [/preferred date:?\s*\**\s*([0-9/\-]{6,12})/i, /date of event\s*\**\s*([0-9/\-]{6,12})/i]),
    stage,
  };
}

function section(title: string, rows: Row[], emptyNote: string): string {
  const lines = [title, "-".repeat(title.length)];
  if (!rows.length) {
    lines.push(emptyNote, "");
    return lines.join("\n");
  }
  for (const r of rows) {
    lines.push(`#${r.id}  ${r.who}`);
    lines.push(`    territory: ${r.territory}   focus: ${r.focus}   guests: ${r.guests}   date: ${r.date}`);
    lines.push(`    ${r.stage}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function buildDigest(zendesk: IZendeskClient, cfg: DigestConfig, now = new Date()): Promise<string> {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [held, fresh, waiting, quiet, ready] = await Promise.all([
    zendesk.searchTickets(`type:ticket tags:private_event_not_form_submission status<solved`),
    // PRIVATE_EVENT_FIELD_VALUE, not a literal: "Reason for Customer
    // Contacting Us" is a Zendesk tagger field, and a tagger stamps its
    // value on the ticket as a tag. So the tag for "this is a private
    // event inquiry" is private_events on Wine and Canvas but
    // private_event_inquiry on Painting and Vino. Hardcoding either one
    // leaves the other brand's "new in the last 24 hours" permanently
    // empty - caught on a live preview 2026-10-01 before this ever ran.
    zendesk.searchTickets(`type:ticket tags:${PRIVATE_EVENT_FIELD_VALUE} created>${yesterday}`),
    zendesk.searchTickets(`type:ticket tags:${PRIVATE_EVENT_QUOTE_SENT_TAG} status:pending`),
    zendesk.searchTickets(`type:ticket tags:${FOLLOW_UP_3_SENT_TAG} status:pending`),
    zendesk.searchTickets(`type:ticket tags:private_event_reply_after_quote status<solved`),
  ]);

  const quietIds = new Set(quiet.map((t) => t.id));
  const readyIds = new Set(ready.map((t) => t.id));

  const heldRows = held.map((t) => toRow(t, "waiting on a human - did not come through the form, nothing sent"));
  const freshRows = fresh.map((t) =>
    toRow(t, t.tags.includes(PRIVATE_EVENT_QUOTE_SENT_TAG) ? "quote sent automatically" : "no quote sent yet")
  );
  const waitingRows = waiting
    .filter((t) => !quietIds.has(t.id) && !readyIds.has(t.id))
    .map((t) => toRow(t, `quoted, no reply yet - ${followUpsSent(t.tags)}`));
  const quietRows = quiet.map((t) => toRow(t, "all 3 follow-ups sent, still no reply"));
  const readyRows = ready.map((t) => toRow(t, "customer replied after the quote - needs a human to close"));

  const header = [
    `${cfg.brandLabel} - private event inquiries`,
    new Date(now).toDateString(),
    "",
    `${freshRows.length} new in the last 24 hours | ${heldRows.length} waiting on a human | ${waitingRows.length} quoted and waiting | ${readyRows.length} ready to book`,
    "",
  ].join("\n");

  return [
    header,
    section("NEEDS A HUMAN", heldRows, "Nothing waiting - everything that came in was handled automatically."),
    section("READY TO BOOK", readyRows, "No one has replied to a quote since the last digest."),
    section("NEW IN THE LAST 24 HOURS", freshRows, "No new private event inquiries."),
    section("QUOTED, WAITING ON THE CUSTOMER", waitingRows, "Nothing outstanding."),
    section("GONE QUIET", quietRows, "No one has gone through the whole follow-up sequence without replying."),
    "Sent automatically each morning. Reply to this ticket if something looks wrong.",
  ].join("\n");
}

/** True when a digest has already been created today, so a restart can't send a second one. */
export async function alreadySentToday(zendesk: IZendeskClient, now = new Date()): Promise<boolean> {
  const today = now.toISOString().slice(0, 10);
  const found = await zendesk.searchTickets(`type:ticket tags:${DIGEST_TAG} created>=${today}`);
  return found.length > 0;
}

export async function sendDigest(zendesk: IZendeskClient, cfg: DigestConfig, now = new Date()): Promise<number | null> {
  if (await alreadySentToday(zendesk, now)) return null;
  const body = await buildDigest(zendesk, cfg, now);
  return zendesk.createTicket({
    subject: `${cfg.brandLabel} private event digest - ${now.toISOString().slice(0, 10)}`,
    body,
    requesterEmail: cfg.to,
    ccEmails: cfg.cc,
    tags: [DIGEST_TAG],
    status: "solved",
  });
}
