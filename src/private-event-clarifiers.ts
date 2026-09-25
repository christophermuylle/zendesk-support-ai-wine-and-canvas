// Clarifying first responses for private-event inquiries whose FOCUS or
// LOCATION we can't determine from the inquiry itself.
//
// Christopher, 2026-09-25: "When someone sends the inquiry, but you are
// unsure what the focus of the event is (Corporate team building,
// Birthday, Community, etc) you should send a followup asking what the
// focus of the event is. Same with location."
//
// This brand needs it more than Painting and Vino does: the Wine and
// Canvas contact form collects Name, Email, Phone, Preferred Date/Time,
// Guests and Location, but has NO occasion field at all. Checked against
// real tickets 2026-09-25 - #29383 (18 guests, requester at
// americanveterinarygroup.com) and #29310 (6 guests) both went out with
// the general quote because nothing in the body said what the event was,
// and #29391 came in with the literal dropdown value "Location: unsure".
// Until an occasion field exists on the form, a clarifying question is the
// usual first response here rather than the exception.
//
// Copy approved verbatim by Christopher, 2026-09-25 - do not reword
// without asking.

import { getFirstName } from "./private-event-quotes.js";
import type { TicketContext } from "./types.js";

export type ClarifierKind = "focus" | "location" | "both";

// Only the cities this brand actually hosts private events in. Deliberately
// excludes Lansing, Kalamazoo, Columbus, Toledo, South Bend, Bloomington,
// Minneapolis, Rochester, Las Vegas and Henderson - those run their own
// local support (see out_of_scope_location in config/rules.yaml).
const SERVED_CITIES = [
  "Indianapolis, IN",
  "Greenwood, IN",
  "Grand Rapids, MI",
  "Cadillac, MI",
  "Fort Myers, FL",
  "Cape Coral, FL",
  "Naples, FL",
  "Tampa, FL",
  "Orlando, FL",
  "Fort Lauderdale, FL",
  "Miami, FL",
].join(" \u00b7 ");

const FOCUS_OPTIONS = [
  "Corporate or team building \u2014 staff, office, or company event",
  "Birthday or celebration \u2014 bachelorette, bridal shower, anniversary, or a get-together",
  "Cookies & Canvas \u2014 our kids' party, for painters 16 and under",
  "Fundraiser \u2014 school, nonprofit, or charity",
];

const SIGN_OFF = ["Cheers,", "", "Bonnie \u2014 Private Event Coordinator", "", "The Wine & Canvas Team"];

const OPENING = (first: string) => [
  `Hi ${first},`,
  "",
  "Thanks so much for reaching out about a private party with Wine and Canvas \u2014 we'd love to paint with your group!",
  "",
];

const LOCATION_TAIL = [
  SERVED_CITIES,
  "",
  "If your desired location sits a little outside one of those, just tell me the city and I'll check what we can do.",
  "",
];

export interface RenderedClarifier {
  kind: ClarifierKind;
  plainBody: string;
  htmlBody: string;
}

function focusLines(): string[] {
  return [
    "Before I put your quote together, one quick question: what's the occasion? We set the event up a little differently depending on the focus, so it helps to know whether you're thinking:",
    "",
    ...FOCUS_OPTIONS.map((o) => `- ${o}`),
    "",
    "Just reply with whichever fits best, along with anything else you'd like us to know, and I'll send over exact pricing and next steps right away.",
    "",
  ];
}

function locationLines(): string[] {
  return [
    "One quick thing before I send your quote: which area will your event be in? Pricing and artist availability vary by location, so I want to be sure I send you the right numbers. We currently host private events in:",
    "",
    ...LOCATION_TAIL,
    "Reply with the city (and the venue if you have one in mind) and I'll get your quote right over.",
    "",
  ];
}

function bothLines(): string[] {
  return [
    "Before I put your quote together, two quick questions:",
    "",
    "1. What's the occasion? We set the event up a little differently depending on the focus:",
    "",
    ...FOCUS_OPTIONS.map((o) => `- ${o}`),
    "",
    "2. Which area will your event be in? We currently host private events in:",
    "",
    ...LOCATION_TAIL,
    "Reply with both, along with anything else you'd like us to know, and I'll send over exact pricing and next steps right away.",
    "",
  ];
}

/** Renders the clarifying first response. No links, so the plain and HTML bodies carry the same words. */
export function renderClarifier(ctx: TicketContext, kind: ClarifierKind): RenderedClarifier {
  const first = getFirstName(ctx);
  const body = kind === "focus" ? focusLines() : kind === "location" ? locationLines() : bothLines();
  const lines = [...OPENING(first), ...body, ...SIGN_OFF];
  return { kind, plainBody: lines.join("\n"), htmlBody: toHtml(lines) };
}

/** Bullet runs become a <ul>; everything else becomes a <p>. Blank lines are separators. */
function toHtml(lines: string[]): string {
  const out: string[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      out.push(`<ul>${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`);
      bullets = [];
    }
  };
  for (const line of lines) {
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2));
      continue;
    }
    flush();
    if (line.trim() !== "") out.push(`<p>${escapeHtml(line)}</p>`);
  }
  flush();
  return out.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
