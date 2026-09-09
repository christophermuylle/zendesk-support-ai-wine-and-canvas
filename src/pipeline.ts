// The core pipeline: fetch ticket -> run rules -> draft with AI -> act.
// Shared by the live webhook server (src/index.ts) and the local mock test
// (scripts/test-local.ts) so both exercise identical logic.

import type { IAiDrafter } from "./ai.js";
import type { RulesEngine } from "./rules.js";
import type { LocationResolver } from "./locations.js";
import type { IZendeskClient } from "./zendesk.js";
import type { Mode } from "./config.js";
import type { DraftResult, RuleDecision, TicketContext } from "./types.js";

export interface PipelineResult {
  ticketId: number;
  ruleDecision: RuleDecision;
  matchedLocation: string | null;
  // Absent when the rules engine short-circuited to "no_action" (e.g. an
  // out-of-scope-location ticket) - the AI is never called for those, so
  // there's nothing to draft and no cost incurred.
  draft?: DraftResult;
  finalAction: "posted_public_reply" | "posted_internal_note" | "skipped_out_of_scope" | "no_op";
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
  // behalf. No AI call, no comment. It IS explicitly set to Open (not left
  // whatever status it arrived in, and not Solved/Pending) and tagged, so it
  // surfaces in the queue for Bonnie to notice and forward to the location
  // that actually owns it.
  if (ruleDecision.action === "no_action") {
    await deps.zendesk.updateTicket(ticketId, { status: "open", addTags: ruleDecision.addTags });
    return { ticketId, ruleDecision, matchedLocation: null, finalAction: "skipped_out_of_scope", mode: deps.mode };
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
