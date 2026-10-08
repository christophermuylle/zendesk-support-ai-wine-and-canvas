import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}

export const CONFIG_DIR = path.resolve(process.cwd(), "config");
export const RULES_PATH = path.join(CONFIG_DIR, "rules.yaml");
export const LOCATIONS_PATH = path.join(CONFIG_DIR, "locations.yaml");
export const KNOWLEDGE_BASE_DIR = path.join(CONFIG_DIR, "knowledge-base");
export const SHARED_KNOWLEDGE_BASE_PATH = path.join(KNOWLEDGE_BASE_DIR, "shared.md");
export const LOCATION_KNOWLEDGE_BASE_DIR = path.join(KNOWLEDGE_BASE_DIR, "locations");

export function loadSharedKnowledgeBase(): string {
  return fs.readFileSync(SHARED_KNOWLEDGE_BASE_PATH, "utf-8");
}

/** Returns the location-specific snippet, or null if that location has no file (yet). */
export function loadLocationSnippet(file: string): string | null {
  const p = path.join(LOCATION_KNOWLEDGE_BASE_DIR, file);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf-8");
}

export type Mode = "draft" | "auto";

// Zendesk custom field used by the "order_confirmation" rule action (see
// src/pipeline.ts): the "Reason for Customer Contacting Us" tagger field.
// Setting it to this option's value also auto-applies the matching
// "order_confirmation" Zendesk tag. Configurable via env in case the field
// or option ever gets rebuilt with a new ID, but these defaults are the
// real IDs confirmed against Wine and Canvas's Zendesk (tickets #28637,
// #28636, #28625).
export const ORDER_CONFIRMATION_FIELD_ID = Number(process.env.ORDER_CONFIRMATION_FIELD_ID ?? 24492007664795);
export const ORDER_CONFIRMATION_FIELD_VALUE = process.env.ORDER_CONFIRMATION_FIELD_VALUE ?? "order_confirmation";

// Zendesk custom field option used by the "newsletter_signup" rule action
// (see src/pipeline.ts) - the SAME "Reason for Customer Contacting Us"
// field as order_confirmation above (field ID 24492007664795), just a
// different option: "Newsletter Sign up". Value confirmed directly against
// a real ticket (Wine and Canvas #29078, Christopher, 2026-09-20) - the
// tag Zendesk applies for that option is "newsletter_sign_up" (three
// words), NOT "newsletter_signup" as the option's display name might
// suggest, so don't "clean up" this spelling.
export const NEWSLETTER_SIGNUP_FIELD_VALUE = process.env.NEWSLETTER_SIGNUP_FIELD_VALUE ?? "newsletter_sign_up";

// "Reason for Customer Contacting Us" options for private-event money
// (Christopher, 2026-09-24). Confirmed against the live field's option
// list, not guessed: the field offers "Private Event Deposit"
// (private_event_deposit) and "Private Event Final Balance"
// (private_event_final_balance). There is no option literally called
// "Final Payment" - final_balance is that option.
export const PRIVATE_EVENT_DEPOSIT_FIELD_VALUE =
  process.env.PRIVATE_EVENT_DEPOSIT_FIELD_VALUE ?? "private_event_deposit";
export const PRIVATE_EVENT_FINAL_BALANCE_FIELD_VALUE =
  process.env.PRIVATE_EVENT_FINAL_BALANCE_FIELD_VALUE ?? "private_event_final_balance";

// Independent go-live lever for the private-event quote templates
// (corporate/standard/fundraiser/kids - see src/private-event-quotes.ts and
// the "private_event_quote" branch in src/pipeline.ts), separate from the
// global MODE env var. Christopher, 2026-09-21: "Until we load all
// templates, keep it to draft mode. Once I have everything sent to you, I
// will let you know to go live." Defaults to false (draft/internal-note
// only) no matter what MODE is set to - this must be explicitly flipped to
// "true" in Railway once Christopher gives the go-ahead, so a later
// unrelated MODE=auto change for the rest of the app can never
// accidentally start auto-sending these before he's reviewed the final
// copy.
export const PRIVATE_EVENT_QUOTES_LIVE = process.env.PRIVATE_EVENT_QUOTES_LIVE === "true";

// Guards the "private_event_quote" pipeline branch against auto-quoting a
// message that only LOOKS like a private-event inquiry because it came
// from one of Wine and Canvas's own internal/licensee mailboxes, not a
// real customer. Confirmed on two real tickets, both misfired 2026-09-2x:
// #29225 (Kiara Kelly, requester wineandcanvas.gw@gmail.com, chatting with
// Bonnie about a booking) and #29206 (Amanda Winden, requester
// wineandcanvas.gr@gmail.com, CC'ing St. Julian Winery on an unrelated
// website-bug thread that happened to mention "Wine and canvas Events").
// Both licensees email FROM an address that is itself named after the
// brand ("wineandcanvas.<location>@gmail.com") rather than a personal
// address - see isInternalBrandSender in src/util.ts. A real customer's
// email is essentially never going to start with the company's own name.
export const PRIVATE_EVENT_INTERNAL_SENDER_PREFIX = "wineandcanvas";

// The brand's own mail domains. Anything arriving FROM one of these is
// staff, never a customer - see isInternalBrandSender in src/util.ts and
// ticket #81443 (2026-09-29) for the incident that added this.
// Individual staff addresses that neither the brand-name prefix nor the
// brand domain would catch. Bonnie coordinates private events for BOTH
// brands from wineandcanvas.events@gmail.com - so on Wine and Canvas the
// "wineandcanvas" prefix catches her, and on Painting and Vino nothing
// would have. Christopher supplied the address 2026-09-30; adding it here
// closes the same gap #81443 opened, one brand over.
export const PRIVATE_EVENT_INTERNAL_SENDER_ADDRESSES = (
  process.env.PRIVATE_EVENT_INTERNAL_SENDER_ADDRESSES ?? "wineandcanvas.events@gmail.com"
)
  .split(",")
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);

export const PRIVATE_EVENT_INTERNAL_SENDER_DOMAINS = (
  process.env.PRIVATE_EVENT_INTERNAL_SENDER_DOMAINS ?? "wineandcanvas.com"
)
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// Tag scheme for the private-event follow-up sequence (src/followups.ts) -
// added 2026-09-22 alongside the follow-up templates themselves. Same
// naming convention Painting and Vino's config.ts uses for its own
// (single-pool) version of this sequence.
// Text that only a real private-event FORM submission carries. Anything
// reaching the private-event branch WITHOUT all of these is free-form
// email, and free-form email is where every misfire has come from -
// Christopher, 2026-09-30: "Only auto-quote what came through the
// private-event form. If not a private event form it should be made a
// draft if it isn't 100% sure."
//
// Checked against live tickets before being chosen: every genuine form
// submission carries them, and none of the tickets that misfired
// (#81443 staff mail, #81500 a booked customer's quoted confirmation,
// #81301/#81302 agent threads) carry any.
export const PRIVATE_EVENT_FORM_MARKERS = (
  process.env.PRIVATE_EVENT_FORM_MARKERS ?? "party request from wine & canvas"
)
  .split("|")
  .map((m) => m.trim().toLowerCase())
  .filter(Boolean);

export const PRIVATE_EVENT_QUOTE_SENT_TAG = "private_event_quote_sent";
/** Stamped by the pipeline when the customer replies after a quote went out. The
 * follow-up sweep treats it as a hard stop: a ticket with a live conversation on
 * it never gets an automated "did you get my quote?" nudge, whatever its status. */
export const PRIVATE_EVENT_REPLY_AFTER_QUOTE_TAG = "private_event_reply_after_quote";

// Stamped when we send a clarifying first response (focus and/or location
// unknown). Its only job is to make sure we ask ONCE: if the customer's
// reply still doesn't tell us, the ticket goes to a human rather than
// getting a second round of questions. Christopher, 2026-09-25.
export const PRIVATE_EVENT_CLARIFICATION_SENT_TAG = "private_event_clarification_sent";

// "Reason for Customer Contacting Us" option for private-event inquiries.
// Christopher, 2026-09-25: "Reason for contacting us should be Private
// Event for Wine and Canvas. Painting and Vino is already set up." Value
// confirmed against the live field's option list ("Private Events") and
// against ticket #29001, where it was set by hand.
export const PRIVATE_EVENT_FIELD_VALUE = process.env.PRIVATE_EVENT_FIELD_VALUE ?? "private_events";
export const PRIVATE_EVENT_LOCATION_TAG_PREFIX = "private_event_location_";
export const FOLLOW_UP_1_SENT_TAG = "private_event_followup_1_sent";
export const FOLLOW_UP_2_SENT_TAG = "private_event_followup_2_sent";
export const FOLLOW_UP_3_SENT_TAG = "private_event_followup_3_sent";

export const env = {
  zendesk: {
    subdomain: required("ZENDESK_SUBDOMAIN"),
    email: required("ZENDESK_EMAIL"),
    apiToken: required("ZENDESK_API_TOKEN"),
  },
  webhookSecret: process.env.ZENDESK_WEBHOOK_SECRET ?? "",
  ai: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
  },
  mode: (process.env.MODE === "auto" ? "auto" : "draft") as Mode,
  brand: process.env.BRAND ?? "painting_and_vino",
  port: Number(process.env.PORT ?? 3000),
};

// Daily private-event digest (src/digest.ts). Off by default: it emails
// real people, so it stays dark until DIGEST_ENABLED=true is set in
// Railway. Everything else is overridable without a deploy.
export const DIGEST_ENABLED = process.env.DIGEST_ENABLED === "true";
export const DIGEST_BRAND_LABEL = process.env.DIGEST_BRAND_LABEL ?? "Wine and Canvas";
export const DIGEST_TO = process.env.DIGEST_TO ?? "chris@wineandcanvas.com";
export const DIGEST_CC = (process.env.DIGEST_CC ?? "jessica@wineandcanvas.com")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);
// Hour of the day, US Eastern, at or after which the digest goes out.
export const DIGEST_HOUR_ET = Number(process.env.DIGEST_HOUR_ET ?? 7);
