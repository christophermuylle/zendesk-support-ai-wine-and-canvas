import fs from "node:fs";
import yaml from "js-yaml";
import type { ActionType, RuleDecision, TicketContext } from "./types.js";
import { getTicketMatchText } from "./util.js";

interface RawRule {
  name: string;
  match: {
    any_keywords?: string[];
    all_keywords?: string[];
    // Every phrase here must be present, in addition to whatever
    // any_keywords/all_keywords/tags below also require - an AND-gate
    // layered on top of their OR-logic. Added 2026-09-23 for
    // event_booking_question: see config/rules.yaml for why.
    required_keywords?: string[];
    tags?: string[];
  };
  action: ActionType;
  force_human_review: boolean;
  add_tags?: string[];
  drafting_hint?: string;
}

interface RulesFile {
  rules: RawRule[];
}

export class RulesEngine {
  private rules: RawRule[];

  constructor(rulesPath: string) {
    const raw = fs.readFileSync(rulesPath, "utf-8");
    const parsed = yaml.load(raw) as RulesFile;
    if (!parsed?.rules?.length) {
      throw new Error(`No rules found in ${rulesPath}`);
    }
    this.rules = parsed.rules;
  }

  /** Evaluate rules against the latest customer message in the ticket. */
  evaluate(ctx: TicketContext): RuleDecision {
    const text = getTicketMatchText(ctx);
    const ticketTags = new Set(ctx.ticket.tags.map((t) => t.toLowerCase()));

    for (const rule of this.rules) {
      if (this.matches(rule, text, ticketTags)) {
        return {
          action: rule.action,
          matchedRule: rule.name,
          addTags: rule.add_tags,
          forceHumanReview: rule.force_human_review,
          draftingHint: rule.drafting_hint,
        };
      }
    }

    // Should never happen if the config has a catch-all rule, but fail safe.
    return {
      action: "pending",
      matchedRule: "no_rule_matched_default",
      forceHumanReview: true,
      addTags: ["needs_human", "unclassified"],
    };
  }

  private matches(rule: RawRule, text: string, ticketTags: Set<string>): boolean {
    const m = rule.match ?? {};

    // required_keywords must ALL be present or this rule does not match,
    // no matter what any_keywords/all_keywords/tags below would otherwise
    // match. See the RawRule interface above for when to use this.
    if (m.required_keywords?.length) {
      if (!m.required_keywords.every((k) => text.includes(k.toLowerCase()))) return false;
    }

    const hasAnyMatcher = m.any_keywords?.length || m.all_keywords?.length || m.tags?.length;

    if (!hasAnyMatcher) {
      // Empty match block = catch-all (used for the fallback rule). If
      // required_keywords was the only matcher specified and it passed
      // above, this rule matches.
      return true;
    }

    if (m.any_keywords?.length) {
      if (m.any_keywords.some((k) => text.includes(k.toLowerCase()))) return true;
    }
    if (m.all_keywords?.length) {
      if (m.all_keywords.every((k) => text.includes(k.toLowerCase()))) return true;
    }
    if (m.tags?.length) {
      if (m.tags.some((t) => ticketTags.has(t.toLowerCase()))) return true;
    }
    return false;
  }
}
