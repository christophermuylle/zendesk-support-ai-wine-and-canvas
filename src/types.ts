// Shared types used across the pipeline.

export interface ZendeskComment {
  id: number;
  author_id: number;
  body: string;
  html_body?: string;
  public: boolean;
  created_at: string;
  /**
   * How the comment was created. Zendesk has always returned this on the
   * comments endpoint; it simply was not declared here until 2026-11-04.
   * The only values that matter to us are "api" (posted by this service)
   * and "web" (typed by a person in the agent interface) - which is the
   * ONLY way to tell our own automated messages from Raimey's and Bonnie's,
   * since both brands post everything through a single shared agent
   * account. Optional because nothing guarantees it on a test fixture.
   */
  via?: { channel?: string };
}

export interface ZendeskTicket {
  id: number;
  subject: string;
  description: string;
  status: "new" | "open" | "pending" | "hold" | "solved" | "closed";
  requester_id: number;
  tags: string[];
  priority?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ZendeskRequester {
  id: number;
  name: string;
  email: string;
}

/** Everything the rules engine + AI drafting need about one ticket. */
export interface TicketContext {
  ticket: ZendeskTicket;
  requester: ZendeskRequester | null;
  comments: ZendeskComment[]; // chronological, oldest first
  brand: string;
}

export type ActionType =
  | "solve"
  | "pending"
  | "escalate"
  | "no_action"
  | "order_confirmation"
  | "newsletter_signup"
  | "private_event_quote";

/** Outcome of running the rules engine against a ticket. */
export interface RuleDecision {
  action: ActionType;
  /** Which rule (by name) produced this decision, for logging/audit. */
  matchedRule: string;
  /** Tags to add to the ticket when this rule fires. */
  addTags?: string[];
  /** If true, never auto-send even in auto mode - always require human review. */
  forceHumanReview: boolean;
  /** Extra instruction to hand the AI when drafting the reply (e.g. "ask for the event date"). */
  draftingHint?: string;
}

/** Outcome of the AI drafting step. */
export interface DraftResult {
  replyBody: string;
  suggestedAction: ActionType;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}
