// Runs a handful of mock tickets through the real rules engine, location
// resolver, and knowledge base (and the real AI if ANTHROPIC_API_KEY is
// set) WITHOUT touching a real Zendesk account. Use this to sanity-check
// config/rules.yaml, config/locations.yaml, and config/knowledge-base/**
// before pointing the webhook at production.
//
// Usage:
//   npm run test:mock                 (rules engine only, fake canned drafts)
//   ANTHROPIC_API_KEY=sk-... npm run test:mock   (also exercises the real AI)

import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import yaml from "js-yaml";
import { RulesEngine } from "../src/rules.js";
import { LocationResolver } from "../src/locations.js";
import { AiDrafter, type IAiDrafter } from "../src/ai.js";
import type { IZendeskClient } from "../src/zendesk.js";
import { processTicket } from "../src/pipeline.js";
import type { ActionType, DraftResult, RuleDecision, TicketContext, ZendeskComment } from "../src/types.js";

const CONFIG_DIR = path.resolve(process.cwd(), "config");
const sharedKnowledgeBase = fs.readFileSync(path.join(CONFIG_DIR, "knowledge-base", "shared.md"), "utf-8");
const LOCATION_KB_DIR = path.join(CONFIG_DIR, "knowledge-base", "locations");
function loadLocationSnippet(file: string): string | null {
  const p = path.join(LOCATION_KB_DIR, file);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
}
const rules = new RulesEngine(path.join(CONFIG_DIR, "rules.yaml"));
const locations = new LocationResolver(path.join(CONFIG_DIR, "locations.yaml"));

// --- Mock Zendesk: records what would have been posted instead of calling the API ---
class MockZendeskClient implements IZendeskClient {
  constructor(private ctx: TicketContext) {}
  async getTicketContext(): Promise<TicketContext> {
    return this.ctx;
  }
  async postComment(
    ticketId: number,
    body: string,
    opts: { isPublic: boolean; status?: ActionType; addTags?: string[]; htmlBody?: string; uploadTokens?: string[] }
  ): Promise<void> {
    console.log(`\n  -> would post comment (public=${opts.isPublic}, status=${opts.status ?? "unchanged"}, tags=${opts.addTags?.join(",") ?? "-"}, htmlBody=${opts.htmlBody ? "yes" : "no"}, uploads=${opts.uploadTokens?.length ?? 0}):`);
    console.log(`     "${body.replace(/\n/g, "\n     ")}"`);
  }
  async uploadFile(filename: string, _contentType: string, data: Buffer): Promise<{ token: string; contentUrl: string }> {
    console.log(`\n  -> would upload file ${filename} (${data.length} bytes)`);
    return { token: `mock-upload-token-${filename}`, contentUrl: `https://mock.zendesk.com/uploads/${filename}` };
  }
  async updateTicket(
    ticketId: number,
    opts: { status?: string; addTags?: string[]; fields?: Array<{ id: number; value: string | null }> }
  ): Promise<void> {
    console.log(
      `\n  -> would set status=${opts.status ?? "unchanged"}, tags+=${opts.addTags?.join(",") ?? "-"}, fields=${opts.fields ? JSON.stringify(opts.fields) : "-"}, no reply`
    );
  }
  async searchTicketIds(_query: string): Promise<number[]> {
    return [];
  }
}

// --- Mock AI: used when no ANTHROPIC_API_KEY is set, so the rules engine can be
// tested offline. Produces an obviously-fake reply that echoes the rule decision. ---
class MockAiDrafter implements IAiDrafter {
  async draftReply(ctx: TicketContext, _kb: string, rule: RuleDecision): Promise<DraftResult> {
    return {
      replyBody: `[MOCK DRAFT - no ANTHROPIC_API_KEY set] Hi ${ctx.requester?.name ?? "there"}, thanks for reaching out about "${ctx.ticket.subject}". (rule=${rule.matchedRule})`,
      suggestedAction: rule.action,
      confidence: "medium",
      reasoning: "Mock drafter - set ANTHROPIC_API_KEY to test real AI output.",
    };
  }
}

function makeComment(body: string, authorId: number, isPublic = true): ZendeskComment {
  return {
    id: Math.floor(Math.random() * 1e6),
    author_id: authorId,
    body,
    public: isPublic,
    created_at: new Date().toISOString(),
  };
}

const CUSTOMER_ID = 1001;

const scenarios: { label: string; ctx: TicketContext }[] = [
  {
    label: "Simple FAQ (should solve)",
    ctx: {
      ticket: {
        id: 1,
        subject: "What is Painting & Vino?",
        description: "What is Painting & Vino? How does it work?",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Jamie Customer", email: "jamie@example.com" },
      comments: [makeComment("What is Painting & Vino? How does it work?", CUSTOMER_ID)],
      brand: "painting_and_vino",
    },
  },
  {
    label: "Refund request (should escalate to human)",
    ctx: {
      ticket: {
        id: 2,
        subject: "Need a refund",
        description: "I need a refund for my ticket, I can't make it anymore.",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Alex Customer", email: "alex@example.com" },
      comments: [makeComment("I need a refund for my ticket, I can't make it anymore.", CUSTOMER_ID)],
      brand: "painting_and_vino",
    },
  },
  {
    label: "Licensee recruitment lead (should go pending, not escalate)",
    ctx: {
      ticket: {
        id: 3,
        subject: "Interested in opening a location",
        description: "How do I become a licensee in Austin, TX?",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Sam Prospect", email: "sam@example.com" },
      comments: [makeComment("How do I become a licensee in Austin, TX?", CUSTOMER_ID)],
      brand: "painting_and_vino",
    },
  },
  {
    label: "Random unclassified message (should fall back to human review)",
    ctx: {
      ticket: {
        id: 4,
        subject: "Question",
        description: "Hey, quick question about last week's event.",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Morgan Customer", email: "morgan@example.com" },
      comments: [makeComment("Hey, quick question about last week's event.", CUSTOMER_ID)],
      brand: "painting_and_vino",
    },
  },
  {
    label: "Out-of-scope location - Toledo, OH (should be skipped entirely, no AI call, no reply)",
    ctx: {
      ticket: {
        id: 5,
        subject: "New message from Toledo, OH Contact Form",
        description: "What time should we arrive for our painting class this weekend?",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Taylor Customer", email: "taylor@example.com" },
      comments: [makeComment("What time should we arrive for our painting class this weekend?", CUSTOMER_ID)],
      brand: "painting_and_vino",
    },
  },
  {
    label: "Managed location - Sacramento pricing question (should resolve location + solve)",
    ctx: {
      ticket: {
        id: 6,
        subject: "New message from Sacramento, CA Contact Form",
        description: "How much does a paint and sip event cost in Sacramento?",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Jordan Customer", email: "jordan@example.com" },
      comments: [makeComment("How much does a paint and sip event cost in Sacramento?", CUSTOMER_ID)],
      brand: "painting_and_vino",
    },
  },
  {
    label: "No location identified - pricing question with no city mentioned (should ask, not guess)",
    ctx: {
      ticket: {
        id: 7,
        subject: "Pricing question",
        description: "How much does it cost to book an event?",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Casey Customer", email: "casey@example.com" },
      comments: [makeComment("How much does it cost to book an event?", CUSTOMER_ID)],
      brand: "painting_and_vino",
    },
  },
  {
    label: 'Newsletter Sign Up - Indianapolis (real ticket #29078 shape: should set Reason for Contact + solve + close, no AI call)',
    ctx: {
      ticket: {
        id: 8,
        subject: "Wine and Canvas - Indianapolis Newsletter Sign Up",
        description: "Newsletter Sign Up\n\nEmail: obiadibartho@gmail.com",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Obiadibartho", email: "obiadibartho@gmail.com" },
      comments: [makeComment("Newsletter Sign Up\n\nEmail: obiadibartho@gmail.com", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: 'Newsletter Sign Up - Austin (different city, proves the rule is not Indianapolis-only)',
    ctx: {
      ticket: {
        id: 9,
        subject: "Wine and Canvas - Austin Newsletter Sign Up",
        description: "Newsletter Sign Up\n\nEmail: someone@example.com",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Someone Else", email: "someone@example.com" },
      comments: [makeComment("Newsletter Sign Up\n\nEmail: someone@example.com", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    // Regression test mirroring Painting and Vino's fix for the bug Bonnie
    // reported 2026-09-22 (ticket #29199 on that brand): "the same email is
    // sending out over and over." Same root cause applies here - the
    // webhook re-runs processTicket on EVERY ticket update, and
    // event_booking_question's broad keyword list can still match the
    // customer's own reply after a quote already went out. This scenario
    // simulates a ticket already tagged private_event_quote_sent (quote
    // already sent), where the customer's LATEST message still contains a
    // matching keyword ("party"). Expected: no second quote - falls back
    // to an internal note for a human instead.
    label: "REGRESSION: customer reply after quote already sent should NOT re-send the quote",
    ctx: {
      ticket: {
        id: 29199,
        subject: "Re: Party request from Test Customer",
        description: "Party request from Test Customer. Guests: about 20. Preferred date: flexible.",
        status: "pending",
        requester_id: CUSTOMER_ID,
        tags: ["booking_question", "private_event_quote_sent", "private_event_quote_sent_standard", "private_event_location_tampa"],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Test Customer", email: "test@example.com" },
      comments: [
        makeComment("Party request from Test Customer. Guests: about 20. Preferred date: flexible.", CUSTOMER_ID),
        makeComment("[Bonnie's original private event quote already sent here]", 999), // the agent's own quote reply - the anchor a real ticket would have
        makeComment("Thanks so much! Quick question about our party - can we bring our own cake?", CUSTOMER_ID), // the reply that should NOT re-trigger a quote
      ],
      brand: "wine_and_canvas",
    },
  },
  {
    // TRUE POSITIVE guard: a genuine contact-form Party Request must keep
    // auto-quoting after the required_keywords gate was added below to
    // event_booking_question (2026-09-23). Body text is the real fixed
    // boilerplate confirmed against ticket #29199 (Rachael Nesbitt) -
    // "Party Request from Wine & Canvas" as the first line, "This e-mail
    // was sent from a contact form on Wine & Canvas" as the closing line.
    label: "TRUE POSITIVE (mirrors ticket #29199): genuine contact-form Party Request should still auto-quote",
    ctx: {
      ticket: {
        id: 90001,
        subject: "Party Request from Test Customer",
        description: "Party Request from Wine & Canvas\n\nName: Test Customer\nEmail: testcustomer@example.com\nGuests: 12\nPreferred Date: 2027-03-06\nLocation: Indianapolis\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Test Customer", email: "testcustomer@example.com" },
      comments: [
        makeComment(
          "Party Request from Wine & Canvas\n\nName: Test Customer\nEmail: testcustomer@example.com\nGuests: 12\nPreferred Date: 2027-03-06\nLocation: Indianapolis\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
          CUSTOMER_ID
        ),
      ],
      brand: "wine_and_canvas",
    },
  },
  {
    // REGRESSION (ticket #29225): Kiara Kelly, a Wine and Canvas licensee
    // (Greater Indianapolis), chatting with Bonnie about a new booking
    // from her own operational mailbox - misfired into an auto-quote
    // before this fix. Real subject/requester confirmed live in Zendesk.
    // Expected: falls through event_booking_question (missing the
    // contact-form phrase) to a generic no_action rule - no quote sent.
    label: "REGRESSION (ticket #29225): licensee's own booking chatter should NOT be auto-quoted",
    ctx: {
      ticket: {
        id: 29225,
        subject: "New Private event inquiry - are you available - 10/24",
        description: "Hey Bonnie, do we have anyone available for a private event 10/24? Let me know!",
        status: "new",
        requester_id: 5001,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: 5001, name: "Wineandcanvas Gw", email: "wineandcanvas.gw@gmail.com" },
      comments: [makeComment("Hey Bonnie, do we have anyone available for a private event 10/24? Let me know!", 5001)],
      brand: "wine_and_canvas",
    },
  },
  {
    // REGRESSION (ticket #29206): Amanda Winden, the Grand Rapids
    // licensee, CC'ing external partners (St. Julian Winery) on an
    // unrelated website-bug-report thread that happened to be subjected
    // "Re: Wine and canvas Events" - also misfired into an auto-quote
    // (and sent externally) before this fix.
    label: "REGRESSION (ticket #29206): licensee website-bug thread should NOT be auto-quoted",
    ctx: {
      ticket: {
        id: 29206,
        subject: "Re: Wine and canvas Events",
        description:
          "Good afternoon, I'll add support to this, hello Bonnie - can you look into this? Also, let's get another private event booked for our next painting event once the website's fixed.",
        status: "new",
        requester_id: 5002,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: 5002, name: "Amanda Winden", email: "wineandcanvas.gr@gmail.com" },
      comments: [
        makeComment(
          "Good afternoon, I'll add support to this, hello Bonnie - can you look into this? Also, let's get another private event booked for our next painting event once the website's fixed.",
          5002
        ),
      ],
      brand: "wine_and_canvas",
    },
  },
];

async function main() {
  const useRealAi = Boolean(process.env.ANTHROPIC_API_KEY);
  const ai: IAiDrafter = useRealAi
    ? new AiDrafter({ apiKey: process.env.ANTHROPIC_API_KEY!, model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5" })
    : new MockAiDrafter();

  console.log(`Running ${scenarios.length} mock tickets through the pipeline (AI: ${useRealAi ? "real Claude API" : "mock, offline"})\n`);
  console.log("Loaded rules:", (yaml.load(fs.readFileSync(path.join(CONFIG_DIR, "rules.yaml"), "utf-8")) as { rules: { name: string }[] }).rules.map((r) => r.name).join(", "));

  const resultsByLabel = new Map<string, Awaited<ReturnType<typeof processTicket>>>();
  for (const scenario of scenarios) {
    console.log(`\n=== ${scenario.label} ===`);
    const zendesk = new MockZendeskClient(scenario.ctx);
    const result = await processTicket(
      { zendesk, rules, locations, ai, sharedKnowledgeBase, loadLocationSnippet, mode: "draft" },
      scenario.ctx.ticket.id
    );
    resultsByLabel.set(scenario.label, result);
    console.log(`  matched rule: ${result.ruleDecision.matchedRule}`);
    console.log(`  matched location: ${result.matchedLocation ?? "(none)"}`);
    if (result.draft) {
      console.log(`  suggested action: ${result.draft.suggestedAction} (confidence: ${result.draft.confidence})`);
    } else {
      console.log(`  no draft (AI was never called)`);
    }
    console.log(`  final: ${result.finalAction}`);
  }

  // --- Regression check (mirrors Painting and Vino's ticket #29199 fix) ---
  const regressionLabel = "REGRESSION: customer reply after quote already sent should NOT re-send the quote";
  const regressionResult = resultsByLabel.get(regressionLabel);
  if (!regressionResult) throw new Error(`ASSERTION FAILED: regression scenario "${regressionLabel}" did not run`);
  if (regressionResult.finalAction !== "posted_internal_note") {
    throw new Error(
      `ASSERTION FAILED: reply-after-quote regression - expected finalAction "posted_internal_note" (no re-send), got "${regressionResult.finalAction}". ` +
        `This means a customer reply after the quote was already sent would trigger ANOTHER copy of the quote email - the exact bug Bonnie reported on Painting and Vino.`
    );
  }
  console.log("\nRegression check passed: reply-after-quote does not re-send the quote email.");

  // --- Regression checks for the internal-sender/staff-misfire fix (2026-09-23) ---
  const truePositiveLabel = "TRUE POSITIVE (mirrors ticket #29199): genuine contact-form Party Request should still auto-quote";
  const truePositiveResult = resultsByLabel.get(truePositiveLabel);
  if (!truePositiveResult) throw new Error(`ASSERTION FAILED: scenario "${truePositiveLabel}" did not run`);
  if (truePositiveResult.ruleDecision.matchedRule !== "event_booking_question") {
    throw new Error(
      `ASSERTION FAILED: genuine Party Request regression - expected matched rule "event_booking_question", got "${truePositiveResult.ruleDecision.matchedRule}". ` +
        `This means the new required_keywords gate is ALSO blocking real customer inquiries, not just staff misfires - that would silently stop answering genuine private-event requests.`
    );
  }

  for (const label of [
    "REGRESSION (ticket #29225): licensee's own booking chatter should NOT be auto-quoted",
    "REGRESSION (ticket #29206): licensee website-bug thread should NOT be auto-quoted",
  ]) {
    const result = resultsByLabel.get(label);
    if (!result) throw new Error(`ASSERTION FAILED: scenario "${label}" did not run`);
    if (result.ruleDecision.matchedRule === "event_booking_question" || result.ruleDecision.matchedRule === "private_event_reply_after_quote_sent") {
      throw new Error(
        `ASSERTION FAILED: ${label} - matched rule "${result.ruleDecision.matchedRule}" would still trigger a private-event quote. ` +
          `This is the exact staff-misfire bug (a licensee's own operational email getting auto-quoted as if it were a real customer inquiry).`
      );
    }
    if (result.finalAction !== "skipped_out_of_scope") {
      throw new Error(
        `ASSERTION FAILED: ${label} - expected finalAction "skipped_out_of_scope" (falls through to a generic no-action rule), got "${result.finalAction}".`
      );
    }
  }
  console.log("Regression check passed: staff/licensee misfires (#29225, #29206) are no longer auto-quoted, and genuine inquiries (#29199-style) still are.");
}

main().catch((err) => {
  console.error("test-local failed:", err);
  process.exit(1);
});
