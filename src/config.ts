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
