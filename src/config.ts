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

// Tag scheme for the private-event follow-up sequence (src/followups.ts) -
// added 2026-09-22 alongside the follow-up templates themselves. Same
// naming convention Painting and Vino's config.ts uses for its own
// (single-pool) version of this sequence.
export const PRIVATE_EVENT_QUOTE_SENT_TAG = "private_event_quote_sent";
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
