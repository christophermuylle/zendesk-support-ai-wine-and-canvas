import Anthropic from "@anthropic-ai/sdk";
import type { DraftResult, RuleDecision, TicketContext } from "./types.js";

export interface AiConfig {
  apiKey: string;
  model: string;
}

/** Minimal surface the pipeline depends on - lets tests/mocks swap in a fake. */
export interface IAiDrafter {
  draftReply(ctx: TicketContext, knowledgeBase: string, ruleDecision: RuleDecision): Promise<DraftResult>;
}

const SYSTEM_PROMPT = `You are a customer support agent drafting a reply to a Zendesk ticket for
a paint-and-sip events company. You must:

1. Answer ONLY using facts present in the knowledge base you are given. If the
   knowledge base does not clearly answer the customer's question, say so in
   your reasoning and prefer a cautious, honest reply (e.g. "let me check on
   that for you") over guessing or inventing a policy, price, or date.
2. Match a warm, friendly, concise support tone - this is a fun, social
   events brand, not a formal enterprise product.
3. Never invent specific dates, prices, or policies that are not in the
   knowledge base.
4. Output ONLY valid JSON matching this exact shape, no other text:
{
  "replyBody": "the reply to send, plain text, no markdown",
  "suggestedAction": "solve" | "pending" | "escalate",
  "confidence": "high" | "medium" | "low",
  "reasoning": "one or two sentences on why you chose this reply/action"
}`;

export class AiDrafter implements IAiDrafter {
  private client: Anthropic;
  private model: string;

  constructor(cfg: AiConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey });
    this.model = cfg.model;
  }

  async draftReply(
    ctx: TicketContext,
    knowledgeBase: string,
    ruleDecision: RuleDecision
  ): Promise<DraftResult> {
    const conversation = ctx.comments
      .map((c) => `[${c.public ? "public" : "internal"}] ${c.author_id === ctx.ticket.requester_id ? "Customer" : "Agent"}: ${c.body}`)
      .join("\n\n");

    const userPrompt = `KNOWLEDGE BASE:
"""
${knowledgeBase}
"""

RULES ENGINE DECISION for this ticket:
- Matched rule: ${ruleDecision.matchedRule}
- Suggested action: ${ruleDecision.action}
- Drafting hint: ${ruleDecision.draftingHint ?? "(none)"}

TICKET SUBJECT: ${ctx.ticket.subject}
CUSTOMER NAME: ${ctx.requester?.name ?? "Unknown"}

CONVERSATION SO FAR (oldest first):
${conversation || "(no comments yet - use the ticket subject/description)"}

Draft the next reply as the support agent, following the rules engine's
suggested action unless the knowledge base clearly contradicts it (e.g. the
rule says "solve" but you don't actually have the information needed - then
prefer "pending" and explain why in reasoning).`;

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = res.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("AI response contained no text block");
    }

    return this.parseDraft(textBlock.text);
  }

  private parseDraft(raw: string): DraftResult {
    // Models sometimes wrap JSON in a code fence despite instructions - strip it defensively.
    const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new Error(`Failed to parse AI response as JSON: ${(err as Error).message}\nRaw: ${raw}`);
    }
    const d = parsed as Partial<DraftResult>;
    if (!d.replyBody || !d.suggestedAction || !d.confidence || !d.reasoning) {
      throw new Error(`AI response missing required fields: ${JSON.stringify(parsed)}`);
    }
    return d as DraftResult;
  }
}
