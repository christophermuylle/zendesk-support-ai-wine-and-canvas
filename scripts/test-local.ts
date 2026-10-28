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
import { ORDER_CONFIRMATION_FIELD_ID } from "../src/config.js";
import {
  resolvePrivateEventLocationKey,
  getLocationInfo,
  classifyPrivateEvent,
  mentionsNonprofitStatus,
  PRIVATE_EVENT_LOCATION_CALENDAR_LINKS,
} from "../src/private-event-quotes.js";
import type { ActionType, DraftResult, RuleDecision, TicketContext, ZendeskComment } from "../src/types.js";
import { extractFormContactName, firstNameFromFullName, looksMachineDerivedName } from "../src/util.js";

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
// Every custom ticket field the pipeline set via postComment, by ticket.
// Used to assert that private-event tickets get "Reason for Customer
// Contacting Us" on EVERY path, including the ones that hand off to a
// human - Christopher, 2026-09-28, after finding tickets quoted days
// earlier with the field still blank.
const fieldsSetByTicket = new Map<number, Array<{ id: number; value: string | null }>>();
/** Every status updateTicket was asked to set, in order - so a test can
 * assert that a ticket passed through Solved on its way to Closed. */
const statusesSetByTicket = new Map<number, string[]>();

class MockZendeskClient implements IZendeskClient {
  // priorOrderTicketIds simulates other "New order" tickets that already
  // exist for the same event - what the real pipeline looks up to tell a
  // private-event deposit from a final balance payment.
  constructor(private ctx: TicketContext, private priorOrderTicketIds: number[] = []) {}
  async getTicketContext(): Promise<TicketContext> {
    return this.ctx;
  }
  async postComment(
    ticketId: number,
    body: string,
    opts: {
      isPublic: boolean;
      status?: ActionType;
      addTags?: string[];
      htmlBody?: string;
      uploadTokens?: string[];
      fields?: Array<{ id: number; value: string | null }>;
    }
  ): Promise<void> {
    for (const f of opts.fields ?? []) {
      fieldsSetByTicket.set(ticketId, [...(fieldsSetByTicket.get(ticketId) ?? []), f]);
    }
    // Tags recorded, not just logged. The same gap on `fields` meant the
    // Reason-for-Contact assertions could never fail; a tag that decides
    // PRICING deserves better than a console line.
    for (const tag of opts.addTags ?? []) {
      tagsAddedByTicket.set(ticketId, [...(tagsAddedByTicket.get(ticketId) ?? []), tag]);
    }
    bodiesByTicket.set(ticketId, [...(bodiesByTicket.get(ticketId) ?? []), `${body}\n${opts.htmlBody ?? ""}`]);
    commentedTicketIds.push(ticketId);
    console.log(`\n  -> would post comment (public=${opts.isPublic}, status=${opts.status ?? "unchanged"}, tags=${opts.addTags?.join(",") ?? "-"}, htmlBody=${opts.htmlBody ? "yes" : "no"}, uploads=${opts.uploadTokens?.length ?? 0}, fields=${opts.fields ? JSON.stringify(opts.fields) : "-"}):`);
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
    // postComment records its fields; this used to drop them, so the
    // mechanical rules (newsletter_signup, order_confirmation,
    // paypal_receipt) - which never post a comment and do all their work
    // here - had no way to be asserted on at all. Their whole job is the
    // tagger field and the status sequence.
    for (const f of opts.fields ?? []) {
      fieldsSetByTicket.set(ticketId, [...(fieldsSetByTicket.get(ticketId) ?? []), f]);
    }
    for (const tag of opts.addTags ?? []) {
      tagsAddedByTicket.set(ticketId, [...(tagsAddedByTicket.get(ticketId) ?? []), tag]);
    }
    statusesSetByTicket.set(ticketId, [...(statusesSetByTicket.get(ticketId) ?? []), opts.status ?? "unchanged"]);
    console.log(
      `\n  -> would set status=${opts.status ?? "unchanged"}, tags+=${opts.addTags?.join(",") ?? "-"}, fields=${opts.fields ? JSON.stringify(opts.fields) : "-"}, no reply`
    );
  }
  async searchTicketIds(query: string): Promise<number[]> {
    console.log(`\n  -> would search Zendesk: ${query}`);
    return this.priorOrderTicketIds;
  }
  // The digest is exercised by its own preview endpoint against real
  // Zendesk data, not by this per-scenario harness.
  async searchTickets(): Promise<never[]> {
    return [];
  }
  async createTicket(): Promise<number> {
    throw new Error("createTicket is not expected in this test");
  }
  async updateUserName(userId: number, name: string): Promise<void> {
    nameCorrections.push({ userId, name });
    console.log(`\n  -> would rename Zendesk user ${userId} to "${name}"`);
  }
}

// Records every requester-name correction the pipeline makes, so a
// scenario can assert on it. The WC mock used to silently drop `fields`,
// which meant the Reason-for-Contact assertions could never fail - not
// repeating that mistake with this one.
const nameCorrections: Array<{ userId: number; name: string }> = [];
const tagsAddedByTicket = new Map<number, string[]>();
const bodiesByTicket = new Map<number, string[]>();
/** Which tickets had ANY comment posted, so a mechanical rule can be
 * asserted to have posted nothing at all. */
const commentedTicketIds: number[] = [];

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
/** Any id that is not the requester's - used for comments WE authored. */
const AGENT_ID = 2002;

const scenarios: { label: string; ctx: TicketContext; priorOrderTicketIds?: number[] }[] = [
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
  {
    // REGRESSION (ticket #29324 / order #180826): an ordinary single-seat
    // purchase whose venue is in an excluded city (Lansing, MI). Real
    // ticket, confirmed in Zendesk 2026-09-24: out_of_scope_location
    // matched 3 seconds after it arrived and the ticket was never
    // recognised as an order at all - no Reason for Contact, no solve,
    // until a human fixed it by hand an hour later. Expected now: ordinary
    // Order Confirmation, solved and closed.
    label: "REGRESSION (#29324): ordinary order at an excluded-city venue should be filed, solved and closed",
    ctx: {
      ticket: {
        id: 29324,
        subject: "[Wine and Canvas - Michigan]: New order #180826",
        description: "You have received a new order.\n\n[Order #180826] (https://wineandcanvas.com/michigan/wp-admin/post.php?post=180826&action=edit)\n\nProduct Quantity Price\nBirch Forest - LBC 10/4 (#179011-5135-BIRCH-FOREST---LBC-10/4)\nBirch Forest - Paint and Sip at Lansing Brewing Company (https://wineandcanvas.com/michigan/event/birch-forest-paint-and-sip-at-lansing-brewing/)\nLansing Brewing Company\n518 E Shiawassee St\nLansing, MI 48912 United States\n 1  $38.00\n\n| Total: | $38.00 |",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Test Buyer", email: "buyer@example.com" },
      comments: [makeComment("You have received a new order.\n\n[Order #180826] (https://wineandcanvas.com/michigan/wp-admin/post.php?post=180826&action=edit)\n\nProduct Quantity Price\nBirch Forest - LBC 10/4 (#179011-5135-BIRCH-FOREST---LBC-10/4)\nBirch Forest - Paint and Sip at Lansing Brewing Company (https://wineandcanvas.com/michigan/event/birch-forest-paint-and-sip-at-lansing-brewing/)\nLansing Brewing Company\n518 E Shiawassee St\nLansing, MI 48912 United States\n 1  $38.00\n\n| Total: | $38.00 |", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    // REGRESSION (ticket #29221 / order #180710): the deposit that started
    // all of this. Real shape, confirmed in Zendesk 2026-09-24 - note it
    // contains the word "private" NOWHERE (the event is "Okemos Paint
    // Party"), which is exactly why the deposit is detected from the
    // PRODUCT line and not from a "private" keyword search. No earlier
    // order exists for event 180408, so this is the deposit.
    // Expected: Reason = Private Event Deposit, status Pending, not closed.
    label: "REGRESSION (order #180710): first payment for an event is a Private Event Deposit, left Pending",
    priorOrderTicketIds: [],
    ctx: {
      ticket: {
        id: 29221,
        subject: "[Wine and Canvas - Michigan]: New order #180710",
        description: "You have received a new order.\n\n[Order #180710] (https://wineandcanvas.com/michigan/wp-admin/post.php?post=180710&action=edit)\n\nProduct Quantity Price\nDeposit - Covers 2 Seats (#180408-5135-DEPOSIT---COVERS-2-SEATS-)\nOkemos Paint Party (https://wineandcanvas.com/michigan/event/okemos-paint-party/)\nFri, Oct 2nd, 2026 @ 6:00 pm - 8:00 pm\nWine and Canvas - Lansing\nAll Around Town\nLansing, MI 48912 United States\n 1  $58.00\n\n| Total: | $58.00 |",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Alexis Buyer", email: "alexis@example.com" },
      comments: [makeComment("You have received a new order.\n\n[Order #180710] (https://wineandcanvas.com/michigan/wp-admin/post.php?post=180710&action=edit)\n\nProduct Quantity Price\nDeposit - Covers 2 Seats (#180408-5135-DEPOSIT---COVERS-2-SEATS-)\nOkemos Paint Party (https://wineandcanvas.com/michigan/event/okemos-paint-party/)\nFri, Oct 2nd, 2026 @ 6:00 pm - 8:00 pm\nWine and Canvas - Lansing\nAll Around Town\nLansing, MI 48912 United States\n 1  $58.00\n\n| Total: | $58.00 |", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    // Same event (180408), but an EARLIER order ticket already exists for
    // it (id 29221 < 29400), so this second payment is the final balance
    // rather than another deposit. Christopher, 2026-09-24: "First order =
    // deposit, later = balance."
    label: "Second payment for the same event should be a Private Event Final Balance, left Pending",
    priorOrderTicketIds: [29221],
    ctx: {
      ticket: {
        id: 29400,
        subject: "[Wine and Canvas - Michigan]: New order #180999",
        description: "You have received a new order.\n\n[Order #180710] (https://wineandcanvas.com/michigan/wp-admin/post.php?post=180710&action=edit)\n\nProduct Quantity Price\nDeposit - Covers 2 Seats (#180408-5135-DEPOSIT---COVERS-2-SEATS-)\nOkemos Paint Party (https://wineandcanvas.com/michigan/event/okemos-paint-party/)\nFri, Oct 2nd, 2026 @ 6:00 pm - 8:00 pm\nWine and Canvas - Lansing\nAll Around Town\nLansing, MI 48912 United States\n 1  $58.00\n\n| Total: | $58.00 |",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Alexis Buyer", email: "alexis@example.com" },
      comments: [makeComment("You have received a new order.\n\n[Order #180710] (https://wineandcanvas.com/michigan/wp-admin/post.php?post=180710&action=edit)\n\nProduct Quantity Price\nDeposit - Covers 2 Seats (#180408-5135-DEPOSIT---COVERS-2-SEATS-)\nOkemos Paint Party (https://wineandcanvas.com/michigan/event/okemos-paint-party/)\nFri, Oct 2nd, 2026 @ 6:00 pm - 8:00 pm\nWine and Canvas - Lansing\nAll Around Town\nLansing, MI 48912 United States\n 1  $58.00\n\n| Total: | $58.00 |", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    // A $0 order stays Open for a human, deposit or not - unchanged rule.
    label: "$0 order should be left Open for a human",
    ctx: {
      ticket: {
        id: 90003,
        subject: "[Wine and Canvas - Michigan]: New order #180500",
        description:
          "You have received a new order.\n\nProduct Quantity Price\nDeposit - Covers 2 Seats (#180408-5135-DEPOSIT---COVERS-2-SEATS-)\n 1  $0.00\n\n| Total: | $0.00 |",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Zero Buyer", email: "zero@example.com" },
      comments: [
        makeComment(
          "You have received a new order.\n\nProduct Quantity Price\nDeposit - Covers 2 Seats (#180408-5135-DEPOSIT---COVERS-2-SEATS-)\n 1  $0.00\n\n| Total: | $0.00 |",
          CUSTOMER_ID
        ),
      ],
      brand: "wine_and_canvas",
    },
  },
  {
    // REGRESSION (2026-09-24): newsletter signups are in scope for EVERY
    // city, including the ones out_of_scope_location excludes. Before
    // newsletter_signup_ticket was moved above that rule, a signup whose
    // body carried an excluded city in the "city, state" form would have
    // been tagged out_of_scope and left Open instead of being filed and
    // closed - the same hijack that hit order #180710.
    label: "REGRESSION: Newsletter Sign Up naming an excluded city should still be filed and closed",
    ctx: {
      ticket: {
        id: 90002,
        subject: "Wine and Canvas - Lansing Newsletter Sign Up",
        description: "Newsletter Sign Up\n\nEmail: signup@example.com\nCity: Lansing, MI",
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Signup Person", email: "signup@example.com" },
      comments: [makeComment("Newsletter Sign Up\n\nEmail: signup@example.com\nCity: Lansing, MI", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    // The ordinary Wine and Canvas contact-form request: the form has NO
    // occasion field, so location is known but focus is not. Christopher,
    // 2026-09-25 - ask rather than send the general quote. Real tickets
    // #29383 and #29310 are this exact shape.
    label: "Contact-form request with a known city but no stated occasion should ask what the focus is",
    ctx: {
      ticket: {
        id: 90200, subject: "Party Request from Dana Unknown",
        description: "Party Request from Wine & Canvas\n\nName: Dana Unknown\nEmail: dana@example.com\nPhone: 3175550142\nPreferred Date: 2026-11-14\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Indianapolis, IN\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Dana Unknown", email: "dana@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Dana Unknown\nEmail: dana@example.com\nPhone: 3175550142\nPreferred Date: 2026-11-14\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Indianapolis, IN\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    // Ticket #29391's shape: the location dropdown's literal "unsure"
    // value, and no occasion either - both questions at once.
    label: "Contact-form request with Location: unsure and no occasion should ask both questions",
    ctx: {
      ticket: {
        id: 90201, subject: "Party Request from Pat Nowhere",
        description: "Party Request from Wine & Canvas\n\nName: Pat Nowhere\nEmail: pat@example.com\nPhone: 3175550199\nPreferred Date: 2026-11-20\nPreferred Time: 7:00 PM\nGuests: 14\nLocation: unsure\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Pat Nowhere", email: "pat@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Pat Nowhere\nEmail: pat@example.com\nPhone: 3175550199\nPreferred Date: 2026-11-20\nPreferred Time: 7:00 PM\nGuests: 14\nLocation: unsure\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    // Already asked, reply still says nothing - hand to a human rather
    // than asking a second time.
    label: "Clarifier already sent and the reply is still unclear - should go to a human, not ask again",
    ctx: {
      ticket: {
        id: 90202, subject: "Party Request from Vague Vera",
        description: "Party Request from Wine & Canvas\n\nName: Dana Unknown\nEmail: dana@example.com\nPhone: 3175550142\nPreferred Date: 2026-11-14\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Indianapolis, IN\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "pending", requester_id: CUSTOMER_ID,
        tags: ["booking_question", "private_event_clarification_sent"],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Vague Vera", email: "vera@example.com" },
      comments: [
        makeComment("Party Request from Wine & Canvas\n\nName: Dana Unknown\nEmail: dana@example.com\nPhone: 3175550142\nPreferred Date: 2026-11-14\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Indianapolis, IN\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID),
        makeComment("[clarifying question already sent here]", 999),
        makeComment("Sounds good, let me know!", CUSTOMER_ID),
      ],
      brand: "wine_and_canvas",
    },
  },
  {
    // The other half of the loop: we asked, and they told us. The reply
    // ("team building for our office") is what classifies the ticket, so
    // the proper Corporate quote goes out rather than the general one.
    // With PRIVATE_EVENT_QUOTES_LIVE off here it is held as an internal
    // note, same as any other quote in draft mode.
    label: "Customer answers the clarifying question - should now quote properly",
    ctx: {
      ticket: {
        id: 90203, subject: "Party Request from Dana Unknown",
        description: "Party Request from Wine & Canvas\n\nName: Dana Unknown\nEmail: dana@example.com\nPhone: 3175550142\nPreferred Date: 2026-11-14\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Indianapolis, IN\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "pending", requester_id: CUSTOMER_ID,
        tags: ["booking_question", "private_event_clarification_sent"],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Dana Unknown", email: "dana@example.com" },
      comments: [
        makeComment("Party Request from Wine & Canvas\n\nName: Dana Unknown\nEmail: dana@example.com\nPhone: 3175550142\nPreferred Date: 2026-11-14\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Indianapolis, IN\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID),
        makeComment("[clarifying question already sent here]", 999),
        makeComment("It's a team building event for our office, in Indianapolis.", CUSTOMER_ID),
      ],
      brand: "wine_and_canvas",
    },
  },
  {
    // REGRESSION (ticket #29229, Molly Caulfield): her form said
    // "Location: Westfield indiana" and the keyword is "westfield, in", so
    // nothing matched, no quote was generated, and the whole inquiry fell
    // to a human - who then sent the quote by hand, which meant it never
    // got the follow-up tags either. getTicketMatchText now also searches a
    // state-normalised copy of the text, so the spelled-out form resolves.
    label: "REGRESSION (#29229): 'Westfield indiana' should resolve to Indianapolis, not fall through as unknown",
    ctx: {
      ticket: {
        id: 29229, subject: "Party Request from Molly Caulfield",
        description: "Party Request from Wine & Canvas\n\nName: Molly Caulfield\nEmail: molly@example.com\nPhone: 3172582114\nPreferred Date: 2026-10-15\nPreferred Time: 1:00 PM\nGuests: 10\nLocation: Westfield indiana\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Molly Caulfield", email: "molly@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Molly Caulfield\nEmail: molly@example.com\nPhone: 3172582114\nPreferred Date: 2026-10-15\nPreferred Time: 1:00 PM\nGuests: 10\nLocation: Westfield indiana\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    // REGRESSION (ticket #29490, 2026-09-28): an AGENT replying on an
    // already-quoted ticket used to land in the reply-after-quote branch
    // and get an internal note saying the CUSTOMER had replied, plus a
    // needs_human tag - about the agent's own message. Expected: nothing
    // at all, since the newest comment is ours.
    label: "Agent's own reply on an already-quoted ticket should produce nothing",
    ctx: {
      ticket: {
        id: 90300,
        subject: "Party Request from Quoted Customer",
        description: "Party Request from Wine & Canvas\n\nName: Quoted Customer\nGuests: 20\nLocation: Indianapolis, IN\nAdditional Info: birthday party",
        status: "pending",
        requester_id: CUSTOMER_ID,
        tags: ["booking_question", "private_event_quote_sent", "private_event_quote_sent_standard", "private_event_location_indianapolis"],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Quoted Customer", email: "quoted@example.com" },
      comments: [
        makeComment("Party Request from Wine & Canvas\n\nName: Quoted Customer\nGuests: 20\nLocation: Indianapolis, IN\nAdditional Info: birthday party", CUSTOMER_ID),
        makeComment("[the quote we already sent]", 999),
        makeComment("Hi again, just following up on the quote I sent you!", 999), // AGENT, newest
      ],
      brand: "wine_and_canvas",
    },
  },
  {
    // REGRESSION (mirrors Painting and Vino ticket #81443, 2026-09-29):
    // a message arriving FROM the brand's own mail domain is staff, never a
    // customer. On that brand the Tucson mailbox became the requester on a
    // follow-up ticket and its payment reminder was auto-quoted, addressed
    // "Hi Painting," - the customer on the thread replied asking for the
    // auto-reply to be turned off. isInternalBrandSender only checked the
    // LOCAL PART for the brand name, so an address with the brand on the
    // right of the @ sailed through. This brand has the same exposure
    // (indy@wineandcanvas.com appears on real tickets), so the guard now
    // covers the domain too. Worst case modelled here: the body even
    // carries the contact-form phrase, so the rule matches and only the
    // sender guard stands between staff and an auto-quote.
    label: "REGRESSION (#81443 class): a message from the brand's own domain must never be auto-quoted",
    ctx: {
      ticket: {
        id: 90400, subject: "Fwd: Party Request from Forwarded Customer",
        description: "Party Request from Wine & Canvas\n\nName: Forwarded Customer\nEmail: customer@example.com\nGuests: 15\nPreferred Date: 2026-11-08\nLocation: Indianapolis, IN\nAdditional Info: birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: 7778, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: 7778, name: "Wine and Canvas Indy", email: "indy@wineandcanvas.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Forwarded Customer\nEmail: customer@example.com\nGuests: 15\nPreferred Date: 2026-11-08\nLocation: Indianapolis, IN\nAdditional Info: birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", 7778)],
      brand: "wine_and_canvas",
    },
  },
  {
    // Christopher's Miami-Dade list, 2026-10-01. Kendall was a real
    // unresolved ticket. The point of the scenario is the PRICE: these towns
    // must land on the miami key (Group B, $45) and not Fort Lauderdale's
    // (Group A, $39), which is what adding them to the slug's keywords alone
    // would have done.
    label: "Miami-Dade: a Kendall inquiry must be quoted at Miami rates, not Fort Lauderdale rates",
    ctx: {
      ticket: {
        id: 90801, subject: "Party Request from Wine & Canvas Florida",
        description: "Party Request from  Wine & Canvas Florida\n\nName: Dade Tester\nEmail: dade@example.com\nPreferred Date: 2026-11-15\nGuests: 14\nLocation: Kendall, Florida\nAdditional Info: girls night out with friends",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Dade Tester", email: "dade@example.com" },
      comments: [makeComment("Party Request from  Wine & Canvas Florida\n\nName: Dade Tester\nEmail: dade@example.com\nPreferred Date: 2026-11-15\nGuests: 14\nLocation: Kendall, Florida\nAdditional Info: girls night out with friends", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    // REGRESSION (ticket #29607, Wendy Fortune, 2026-09-30): the contact
    // form emails us from a shared address, so Zendesk invented the
    // end-user "Viawendy" from viawendy@gmail.com and the clarifier went
    // out as "Hi Viawendy,". An audit the same day found 14 of 19
    // private-event tickets had a user record disagreeing with the form -
    // #29509 was greeted "Hi Trosand," and #29453 "Hi Sstinson131313,".
    // Expected: the greeting uses the form name, and the USER RECORD is
    // corrected too, because emails 1-3 read the record rather than this
    // reply.
    label: "REGRESSION (#29607): the form name beats the name Zendesk invented from the email address",
    ctx: {
      ticket: {
        id: 29607, subject: "Party Request from Wendy Fortune",
        description: "Party Request from Wine & Canvas Florida \n\n Name: Wendy Fortune \n Email: viawendy@gmail.com \n Phone: 9544640778 \n Preferred Date: 2026-10-10 \n Preferred Time: [preferredtime] \n Guests: 8 \n Location: My office in Margate \n Additional Info: I'm having a small launch party at my office for about 8 ladies. \n Referral: Online \n\n-- \nThis e-mail was sent from a contact form on Wine and Canvas \u2013 Florida (https://wineandcanvas.com/florida)",
        status: "open", requester_id: CUSTOMER_ID,
        tags: ["booking_question", "private_events"],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Viawendy", email: "viawendy@gmail.com" },
      comments: [makeComment("Party Request from Wine & Canvas Florida \n\n Name: Wendy Fortune \n Email: viawendy@gmail.com \n Phone: 9544640778 \n Preferred Date: 2026-10-10 \n Preferred Time: [preferredtime] \n Guests: 8 \n Location: My office in Margate \n Additional Info: I'm having a small launch party at my office for about 8 ladies. \n Referral: Online \n\n-- \nThis e-mail was sent from a contact form on Wine and Canvas \u2013 Florida (https://wineandcanvas.com/florida)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    // REGRESSION (ticket #29509, Taylor Rosand, 2026-09-29): the form gave
    // us her location, we asked what the occasion was, and she answered
    // "team building". Matching on that reply ALONE, the focus was clear
    // but her location had vanished - so she was told her event was still
    // unclear. Expected: both details in view, so a proper corporate quote.
    label: "REGRESSION (#29509): an answer to the clarifying question must not lose the location from the original form",
    ctx: {
      ticket: {
        id: 29509, subject: "Party Request from Taylor Rosand",
        description: "Party Request from Wine & Canvas\n\nName: Taylor Rosand\nEmail: taylor@example.com\nPhone: 7273653585\nPreferred Date: 2026-10-23\nPreferred Time: 5:30 PM\nGuests: 9\nLocation: Fort Lauderdale, FL\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "pending", requester_id: CUSTOMER_ID,
        tags: ["booking_question", "private_event_clarification_sent"],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Taylor Rosand", email: "taylor@example.com" },
      comments: [
        makeComment("Party Request from Wine & Canvas\n\nName: Taylor Rosand\nEmail: taylor@example.com\nPhone: 7273653585\nPreferred Date: 2026-10-23\nPreferred Time: 5:30 PM\nGuests: 9\nLocation: Fort Lauderdale, FL\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID),
        makeComment("[the clarifying question we sent]", 999),
        makeComment("It's a team building, self care evening for my team of therapists in our group practice.", CUSTOMER_ID),
      ],
      brand: "wine_and_canvas",
    },
  },
  {
    // REGRESSION (#29509, second bug): the clarifying question we post
    // wakes the webhook, and this branch used to declare the ticket "still
    // unclear after asking" two seconds later - about our own message.
    // Expected: nothing, because the customer has not spoken since.
    label: "REGRESSION (#29509): our own clarifying question must not trigger 'still unclear'",
    ctx: {
      ticket: {
        id: 90500, subject: "Party Request from Quiet Customer",
        description: "Party Request from Wine & Canvas\n\nName: Taylor Rosand\nEmail: taylor@example.com\nPhone: 7273653585\nPreferred Date: 2026-10-23\nPreferred Time: 5:30 PM\nGuests: 9\nLocation: Fort Lauderdale, FL\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "pending", requester_id: CUSTOMER_ID,
        tags: ["booking_question", "private_event_clarification_sent"],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Quiet Customer", email: "quiet@example.com" },
      comments: [
        makeComment("Party Request from Wine & Canvas\n\nName: Taylor Rosand\nEmail: taylor@example.com\nPhone: 7273653585\nPreferred Date: 2026-10-23\nPreferred Time: 5:30 PM\nGuests: 9\nLocation: Fort Lauderdale, FL\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID),
        makeComment("[the clarifying question we just sent]", 999),
      ],
      brand: "wine_and_canvas",
    },
  },
  {
    // REGRESSION (ticket #29107, Avyana Carrasco): the quote was sent BY
    // HAND, so the ticket carried no quote-sent tag. Days later the agent
    // replied again, that update woke the webhook, and with no tag to stop
    // it the pipeline read her own message as a fresh inquiry and sent the
    // customer a SECOND copy of the quote. The tag was missing and could
    // not save us; what saves us is that the newest message is not the
    // customer's. Expected: nothing at all.
    label: "REGRESSION (#29107): an agent reply on an untagged, already-hand-quoted ticket must not re-quote",
    ctx: {
      ticket: {
        id: 90600, subject: "Party Request from Avyana Carrasco",
        description: "Party Request from Wine & Canvas\n\nName: Avyana Carrasco\nEmail: avyana@example.com\nGuests: 12\nPreferred Date: 2026-11-01\nLocation: Orlando, FL\nAdditional Info: birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "pending", requester_id: CUSTOMER_ID,
        tags: ["booking_question"],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Avyana Carrasco", email: "avyana@example.com" },
      comments: [
        makeComment("Party Request from Wine & Canvas\n\nName: Avyana Carrasco\nEmail: avyana@example.com\nGuests: 12\nPreferred Date: 2026-11-01\nLocation: Orlando, FL\nAdditional Info: birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID),
        makeComment("[the quote Bonnie sent by hand - no tags applied]", 999),
        makeComment("Hi Avyana, I sent you a text about your party quote. Did you get it?", 999),
      ],
      brand: "wine_and_canvas",
    },
  },
  {
    // REGRESSION (ticket #81500, Maribeth Grandpre, 2026-09-30): an
    // already-booked, already-paid customer replied to her own ticket
    // confirmation asking to move the start time by half an hour. Quoted
    // underneath was OUR confirmation email, containing "Private painting
    // event with Erin" - and "painting event" is one of this rule's
    // keywords. Our own words, quoted back to us, were read as a fresh
    // private-event inquiry and she was asked what the occasion was.
    // Expected: her one-line question is all that gets matched, so this
    // never reaches the private-event branch.
    label: "REGRESSION (#81500): quoted email history must not be matched as the customer's message",
    ctx: {
      ticket: {
        id: 81500, subject: "RE: Your tickets from Painting and Vino",
        description: "Hi Erin,\n\nIs it possible to change the time to 3:00- 4:30 pm?\n\nPlease let me know.\n\nThanks!\nMaribeth\n\nFrom: Wine and Canvas <support@wineandcanvas.com>\nSent: Wednesday, September 23, 2026 6:10 PM\nTo: Maribeth\nSubject: Your tickets\n\nPrivate painting event with Erin\nCSN Private Paint event activity",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Maribeth Grandpre", email: "maribeth@example.com" },
      comments: [makeComment("Hi Erin,\n\nIs it possible to change the time to 3:00- 4:30 pm?\n\nPlease let me know.\n\nThanks!\nMaribeth\n\nFrom: Wine and Canvas <support@wineandcanvas.com>\nSent: Wednesday, September 23, 2026 6:10 PM\nTo: Maribeth\nSubject: Your tickets\n\nPrivate painting event with Erin\nCSN Private Paint event activity", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    // THE GATE (Christopher, 2026-09-30): a perfectly reasonable private
    // event request that did NOT come through the form. It reads like a
    // real inquiry and would classify cleanly - and that is exactly the
    // problem, because so did our own marketing copy quoted back to us on
    // #81500. Free-form email is held for a human instead.
    label: "GATE: a convincing private-event request that did not come through the form must be held, not sent",
    ctx: {
      ticket: {
        id: 90700, subject: "Private event pricing",
        description: "Hi there, we'd like to book a private event for about 20 people in November. It's a corporate team building day. Can you send pricing?",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Free Form", email: "freeform@example.com" },
      comments: [makeComment("Hi there, we'd like to book a private event for about 20 people in November. It's a corporate team building day. Can you send pricing?", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    // WC #30265 (2026-10-12): Raimey emailed the Orlando licensee "are you
    // available?" with a new lead, stacking the Artist Available macro on top
    // of the Standard ORL quote macro. The first comment on this ticket is
    // OURS; the licensee is the requester. Her reply is a reply to us, not an
    // inquiry. Same shape as PV #81725 (re-engagement blast) and #81443 (a
    // payment reminder that came back as a ticket).
    label: "REGRESSION (#30265): a thread WE started must never be auto-answered",
    ctx: {
      ticket: {
        id: 30265, subject: "New Private event inquiry - are you available?",
        description: "We have a new party booking! Date/time: Sometime in November. Location: School in Portage, MI. Estimated headcount: Undecided. Let me know if you are available.",
        status: "pending", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Licensee Orlando", email: "licensee.orlando@example.com" },
      comments: [
        makeComment("We have a new party booking! Date/time: Sometime in November. Location: School in Portage, MI. Estimated headcount: Undecided. Let me know if you are available.", AGENT_ID),
        makeComment("Yes, I am available that week and can cover the party. Let me know the final headcount and I will plan the paint party.", CUSTOMER_ID),
      ],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "REGRESSION (#30268): a party under the group minimum gets public classes, not a quote",
    ctx: {
      ticket: {
        id: 30268, subject: "Party Request from Iris Figurora",
        description: "## Party Request from Wine & Canvas\n\n**Name:** Iris Figurora\n\n**Email:** iris@example.com\n\n**Preferred Date:** 2026-12-05\n\n**Guests:** 2\n\n**Location:** Indianapolis, IN\n\n**Additional Info:** Birthday celebration for my wife",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Iris Figurora", email: "iris@example.com" },
      comments: [makeComment("## Party Request from Wine & Canvas\n\n**Name:** Iris Figurora\n\n**Email:** iris@example.com\n\n**Preferred Date:** 2026-12-05\n\n**Guests:** 2\n\n**Location:** Indianapolis, IN\n\n**Additional Info:** Birthday celebration for my wife", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "CONTROL (#30268): a party at or above the minimum still gets the normal quote",
    ctx: {
      ticket: {
        id: 30269, subject: "Party Request from Iris Figurora",
        description: "## Party Request from Wine & Canvas\n\n**Name:** Iris Figurora\n\n**Email:** iris@example.com\n\n**Preferred Date:** 2026-12-05\n\n**Guests:** 20\n\n**Location:** Indianapolis, IN\n\n**Additional Info:** Birthday celebration for my wife",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Iris Figurora", email: "iris@example.com" },
      comments: [makeComment("## Party Request from Wine & Canvas\n\n**Name:** Iris Figurora\n\n**Email:** iris@example.com\n\n**Preferred Date:** 2026-12-05\n\n**Guests:** 20\n\n**Location:** Indianapolis, IN\n\n**Additional Info:** Birthday celebration for my wife", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "REGRESSION (#30357/#30413): a generic contact-form inquiry must be flagged for a human",
    ctx: {
      ticket: {
        id: 30413, subject: "Contact from Kristi Risnes",
        description: "## Contact from Wine & Canvas Michigan\n\n**Name:** Kristi Risnes\n\n**Email:** kristi@example.com\n\n**Phone:** (320) 495-3392\n\n**Location:** Mille Lacs Island Resort\n\n**Message:** I am looking for someone to come onsite for a couple of events for the summer of 2027. My office hours are Monday -Friday 9 a.m. to 5 p.m.\n\n-- This e-mail was sent from a contact form on Wine and Canvas - Michigan (https://wineandcanvas.com/michigan)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Contact Former", email: "cf@example.com" },
      comments: [makeComment("## Contact from Wine & Canvas Michigan\n\n**Name:** Kristi Risnes\n\n**Email:** kristi@example.com\n\n**Phone:** (320) 495-3392\n\n**Location:** Mille Lacs Island Resort\n\n**Message:** I am looking for someone to come onsite for a couple of events for the summer of 2027. My office hours are Monday -Friday 9 a.m. to 5 p.m.\n\n-- This e-mail was sent from a contact form on Wine and Canvas - Michigan (https://wineandcanvas.com/michigan)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    // The "New submission from ..." wording is what the storefront form
    // sends (Christopher, 2026-10-22) - different from this brand's
    // "<Brand> - <City> Newsletter Sign Up" subjects above, and the reason
    // Painting and Vino needed the rule built from scratch. Pinned here so
    // a future keyword tidy-up can't drop the wording that catches it.
    label: 'REGRESSION (2026-10-22): "New submission from Newsletter Signup" is filed, Solved and Closed',
    ctx: {
      ticket: {
        id: 7742,
        subject: "New submission from Newsletter Signup",
        description: `Name
Dana Rivera
Email
dana@example.com
Location
Indianapolis`,
        status: "new",
        requester_id: CUSTOMER_ID,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Dana Rivera", email: "dana@example.com" },
      comments: [
        makeComment(
          `Name
Dana Rivera
Email
dana@example.com
Location
Indianapolis`,
          CUSTOMER_ID
        ),
      ],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Bloomington standard private party (2026-10-26): Indianapolis pricing, Bloomington venue kit",
    ctx: {
      ticket: {
        id: 90901, subject: "Party Request from Bea Standard",
        description: "Party Request from Wine & Canvas\n\nName: Bea Standard\nEmail: bea@example.com\nPhone: 8125550199\nPreferred Date: 2026-12-12\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Bloomington, IN\nAdditional Info: Birthday party for my sister\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Bea Standard", email: "bea@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Bea Standard\nEmail: bea@example.com\nPhone: 8125550199\nPreferred Date: 2026-12-12\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Bloomington, IN\nAdditional Info: Birthday party for my sister\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Bloomington corporate private party (2026-10-26): Indianapolis corporate pricing",
    ctx: {
      ticket: {
        id: 90902, subject: "Party Request from Cal Corporate",
        description: "Party Request from Wine & Canvas\n\nName: Cal Corporate\nEmail: cal@example.com\nPhone: 8125550199\nPreferred Date: 2026-12-12\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Bloomington, IN\nAdditional Info: Corporate team building event for our office\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Cal Corporate", email: "cal@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Cal Corporate\nEmail: cal@example.com\nPhone: 8125550199\nPreferred Date: 2026-12-12\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Bloomington, IN\nAdditional Info: Corporate team building event for our office\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Bloomington Cookies & Canvas kids party (2026-10-26): Indianapolis kids pricing",
    ctx: {
      ticket: {
        id: 90903, subject: "Party Request from Kim Kiddo",
        description: "Party Request from Wine & Canvas\n\nName: Kim Kiddo\nEmail: kim@example.com\nPhone: 8125550199\nPreferred Date: 2026-12-12\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Bloomington, IN\nAdditional Info: Cookies and Canvas kids party, ages 6-10\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Kim Kiddo", email: "kim@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Kim Kiddo\nEmail: kim@example.com\nPhone: 8125550199\nPreferred Date: 2026-12-12\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Bloomington, IN\nAdditional Info: Cookies and Canvas kids party, ages 6-10\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Bloomington fundraiser (2026-10-26): Indianapolis fundraiser pricing",
    ctx: {
      ticket: {
        id: 90904, subject: "Party Request from Fay Fundraiser",
        description: "Party Request from Wine & Canvas\n\nName: Fay Fundraiser\nEmail: fay@example.com\nPhone: 8125550199\nPreferred Date: 2026-12-12\nPreferred Time: 6:00 PM\nGuests: 30\nLocation: Bloomington, IN\nAdditional Info: Fundraiser for our school PTO\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Fay Fundraiser", email: "fay@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Fay Fundraiser\nEmail: fay@example.com\nPhone: 8125550199\nPreferred Date: 2026-12-12\nPreferred Time: 6:00 PM\nGuests: 30\nLocation: Bloomington, IN\nAdditional Info: Fundraiser for our school PTO\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Bedford, IN private party (2026-10-26): Bloomington pricing plus the TBD travel-fee line",
    ctx: {
      ticket: {
        id: 90905, subject: "Party Request from Bud Bedford",
        description: "Party Request from Wine & Canvas\n\nName: Bud Bedford\nEmail: bud@example.com\nPhone: 8125550177\nPreferred Date: 2026-12-19\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Bedford, IN\nAdditional Info: Birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Bud Bedford", email: "bud@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Bud Bedford\nEmail: bud@example.com\nPhone: 8125550177\nPreferred Date: 2026-12-19\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Bedford, IN\nAdditional Info: Birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Martinsville, IN private party (2026-10-26): in service area, NO travel fee",
    ctx: {
      ticket: {
        id: 90906, subject: "Party Request from Mara Martinsville",
        description: "Party Request from Wine & Canvas\n\nName: Mara Martinsville\nEmail: mara@example.com\nPhone: 7655550188\nPreferred Date: 2026-12-20\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Martinsville, IN\nAdditional Info: Birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Mara Martinsville", email: "mara@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Mara Martinsville\nEmail: mara@example.com\nPhone: 7655550188\nPreferred Date: 2026-12-20\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Martinsville, IN\nAdditional Info: Birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Sarasota standard private party (2026-10-26): Tampa pricing, Sarasota venue kit",
    ctx: {
      ticket: {
        id: 91001, subject: "Party Request from Sam Sarasota",
        description: "Party Request from Wine & Canvas\n\nName: Sam Sarasota\nEmail: sam@example.com\nPhone: 9415550133\nPreferred Date: 2027-01-16\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Sarasota, FL\nAdditional Info: Birthday party for my sister\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Sam Sarasota", email: "sam@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Sam Sarasota\nEmail: sam@example.com\nPhone: 9415550133\nPreferred Date: 2027-01-16\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Sarasota, FL\nAdditional Info: Birthday party for my sister\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Sarasota corporate private party (2026-10-26): Tampa corporate pricing",
    ctx: {
      ticket: {
        id: 91002, subject: "Party Request from Cora Corporate",
        description: "Party Request from Wine & Canvas\n\nName: Cora Corporate\nEmail: cora@example.com\nPhone: 9415550133\nPreferred Date: 2027-01-16\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Sarasota, FL\nAdditional Info: Corporate team building event for our office\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Cora Corporate", email: "cora@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Cora Corporate\nEmail: cora@example.com\nPhone: 9415550133\nPreferred Date: 2027-01-16\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Sarasota, FL\nAdditional Info: Corporate team building event for our office\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Sarasota Cookies & Canvas kids party (2026-10-26): Tampa kids pricing",
    ctx: {
      ticket: {
        id: 91003, subject: "Party Request from Kit Kiddo",
        description: "Party Request from Wine & Canvas\n\nName: Kit Kiddo\nEmail: kit@example.com\nPhone: 9415550133\nPreferred Date: 2027-01-16\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Sarasota, FL\nAdditional Info: Cookies and Canvas kids party, ages 6-10\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Kit Kiddo", email: "kit@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Kit Kiddo\nEmail: kit@example.com\nPhone: 9415550133\nPreferred Date: 2027-01-16\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Sarasota, FL\nAdditional Info: Cookies and Canvas kids party, ages 6-10\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Sarasota fundraiser (2026-10-26): Tampa fundraiser pricing",
    ctx: {
      ticket: {
        id: 91004, subject: "Party Request from Fern Fundraiser",
        description: "Party Request from Wine & Canvas\n\nName: Fern Fundraiser\nEmail: fern@example.com\nPhone: 9415550133\nPreferred Date: 2027-01-16\nPreferred Time: 6:00 PM\nGuests: 30\nLocation: Sarasota, FL\nAdditional Info: Fundraiser for our school PTO\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Fern Fundraiser", email: "fern@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Fern Fundraiser\nEmail: fern@example.com\nPhone: 9415550133\nPreferred Date: 2027-01-16\nPreferred Time: 6:00 PM\nGuests: 30\nLocation: Sarasota, FL\nAdditional Info: Fundraiser for our school PTO\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Sarasota party under the minimum (2026-10-26): no calendar page, so the phone/email fallback",
    ctx: {
      ticket: {
        id: 91005, subject: "Party Request from Tess Tiny",
        description: "Party Request from Wine & Canvas\n\nName: Tess Tiny\nEmail: tess@example.com\nPhone: 9415550133\nPreferred Date: 2027-01-16\nPreferred Time: 6:00 PM\nGuests: 2\nLocation: Sarasota, FL\nAdditional Info: Just the two of us for a birthday\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Tess Tiny", email: "tess@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Tess Tiny\nEmail: tess@example.com\nPhone: 9415550133\nPreferred Date: 2027-01-16\nPreferred Time: 6:00 PM\nGuests: 2\nLocation: Sarasota, FL\nAdditional Info: Just the two of us for a birthday\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Grand Rapids private party (2026-10-26): no kit link, artist-availability line instead",
    ctx: {
      ticket: {
        id: 91101, subject: "Party Request from Gail Rapids",
        description: "Party Request from Wine & Canvas\n\nName: Gail Rapids\nEmail: gail@example.com\nPhone: 6165550144\nPreferred Date: 2027-02-13\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Grand Rapids, MI\nAdditional Info: Birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Gail Rapids", email: "gail@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Gail Rapids\nEmail: gail@example.com\nPhone: 6165550144\nPreferred Date: 2027-02-13\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Grand Rapids, MI\nAdditional Info: Birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Traverse City private party (2026-10-26): served as Grand Rapids, so also no kit link",
    ctx: {
      ticket: {
        id: 91102, subject: "Party Request from Tru Traverse",
        description: "Party Request from Wine & Canvas\n\nName: Tru Traverse\nEmail: tru@example.com\nPhone: 6165550144\nPreferred Date: 2027-02-13\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Traverse City, MI\nAdditional Info: Birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Tru Traverse", email: "tru@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Tru Traverse\nEmail: tru@example.com\nPhone: 6165550144\nPreferred Date: 2027-02-13\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Traverse City, MI\nAdditional Info: Birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
      brand: "wine_and_canvas",
    },
  },
  {
    label: "Bradenton, FL private party (2026-10-26): Sarasota pricing plus a $40 travel fee",
    ctx: {
      ticket: {
        id: 91006, subject: "Party Request from Bree Bradenton",
        description: "Party Request from Wine & Canvas\n\nName: Bree Bradenton\nEmail: bree@example.com\nPhone: 9415550155\nPreferred Date: 2027-01-30\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Bradenton, FL\nAdditional Info: Birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)",
        status: "new", requester_id: CUSTOMER_ID, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      requester: { id: CUSTOMER_ID, name: "Bree Bradenton", email: "bree@example.com" },
      comments: [makeComment("Party Request from Wine & Canvas\n\nName: Bree Bradenton\nEmail: bree@example.com\nPhone: 9415550155\nPreferred Date: 2027-01-30\nPreferred Time: 6:00 PM\nGuests: 20\nLocation: Bradenton, FL\nAdditional Info: Birthday party\n\n-- This e-mail was sent from a contact form on Wine & Canvas (https://wineandcanvas.com)", CUSTOMER_ID)],
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
    const zendesk = new MockZendeskClient(scenario.ctx, scenario.priorOrderTicketIds);
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

  // --- Miami-Dade pricing (2026-10-01) ---
  const dadeLabel = "Miami-Dade: a Kendall inquiry must be quoted at Miami rates, not Fort Lauderdale rates";
  const dadeResult = resultsByLabel.get(dadeLabel);
  if (!dadeResult) throw new Error(`ASSERTION FAILED: scenario "${dadeLabel}" did not run`);
  // matchedLocation is the locations.yaml SLUG's display name ("Fort
  // Lauderdale / Miami, FL") for both keys, so it cannot tell them apart.
  // The location tag is what the pricing actually hangs off.
  // PRIVATE_EVENT_QUOTES_LIVE is off here, so the quote is held as an
  // internal note rather than sent - and matchedLocation reports the
  // locations.yaml SLUG name ("Fort Lauderdale / Miami, FL") for both keys,
  // so it cannot tell them apart. The rendered price can.
  const dadeText = (bodiesByTicket.get(90801) ?? []).join("\n");
  if (!dadeText.includes("Pricing for Miami, FL") || !dadeText.includes("$45/person")) {
    throw new Error(
      `ASSERTION FAILED: a Kendall inquiry was not priced as Miami. Expected "Pricing for Miami, FL" and ` +
        `"$45/person" in the quote; Fort Lauderdale's Group A rate is $39, so getting this wrong under-quotes ` +
        `every Miami-Dade job by $6 a head. Got:\n${dadeText.slice(0, 600)}`
    );
  }
  if (dadeText.includes("$39/person")) {
    throw new Error(`ASSERTION FAILED: a Kendall inquiry was quoted Fort Lauderdale's $39/person Group A rate.`);
  }
  console.log("\nRegression check passed: Miami-Dade towns are priced as Miami, not Fort Lauderdale.");

  // --- Category keywords must match whole tokens (2026-10-05) ---
  // Audit prompted by the kids-template bug. Substring matching had the same
  // failure three more times, and the first is the worst of the lot: "cause"
  // matched "because", so ANY inquiry containing ordinary writing like "I'm
  // asking because..." was classified FUNDRAISER and sent donation mechanics.
  {
    const classify = (text: string): string | null => {
      const c: TicketContext = {
        ticket: { ...scenarios[0].ctx.ticket, id: 91300, description: text, requester_id: CUSTOMER_ID },
        requester: { id: CUSTOMER_ID, name: "T", email: "t@example.com" },
        comments: [makeComment(text, CUSTOMER_ID)],
        brand: "wine_and_canvas",
      };
      return classifyPrivateEvent(c);
    };
    const misfires: Array<[string, string]> = [
      ["I'm asking because we have 12 people", "cause/because"],
      ["Just checking because the date is tight", "cause/because"],
      ["We are staffing the event ourselves", "staff/staffing"],
    ];
    for (const [text, why] of misfires) {
      const got = classify(text);
      if (got !== null) throw new Error(`ASSERTION FAILED (${why}): "${text}" classified as "${got}", expected no category. A keyword matched inside a longer word.`);
    }

    // --- "non-profit" is not an event type (2026-10-28) ---
    // Found on the other brand, Painting and Vino #82266: "I'm hosting an
    // employee party ... Can you share pricing and if you have non-profit
    // rates?" got the fundraiser quote - donation mechanics for a staff
    // Christmas party. "employee" is a CORPORATE keyword, but fundraiser is
    // checked first, so "non-profit" won. This brand had the identical
    // keyword list and ordering, so it was one inquiry away from the same
    // mistake; these cases are that brand's real wording.
    const nonprofitNotFundraiser: Array<[string, string, string]> = [
      [
        "Tell us about your Event: I'm hosting an employee party. We have several activities and I'd like to add a simple paint event. Can you share pricing and if you have non-profit rates?",
        "corporate",
        "PV #82266 - an employee party at a nonprofit is a CORPORATE event",
      ],
      [
        "Tell us about your Event: We are a non-profit family services organization wanting to book a painting activity for a staff retreat. We have a tax-exempt certificate.",
        "corporate",
        "PV #77541 - a staff retreat at a nonprofit is a CORPORATE event",
      ],
    ];
    for (const [text, want, why] of nonprofitNotFundraiser) {
      const got = classify(text);
      if (got !== want) {
        throw new Error(
          `ASSERTION FAILED (${why}): classified as "${got}", expected "${want}". Being a nonprofit is who the ` +
            `customer IS, not what the event is - it must not decide the category.`
        );
      }
    }
    {
      const text =
        "Tell us about your Event: RETA-RSES is a non-profit association and we are hosting our annual conference. We are looking for a group paint instructor to teach a class of about 60 people.";
      if (classify(text) === "fundraiser") {
        throw new Error(
          `ASSERTION FAILED (PV #80826): a nonprofit booking its annual conference was classified as a fundraiser.`
        );
      }
    }
    const stillFundraiser: Array<[string, string]> = [
      [
        "Tell us about your Event: We are a non-profit religious organization and as part of a fund raising project we wanted to explore bringing this experience to our membership.",
        "PV #70000 - 'fund raising' as two words was the ONLY fundraiser signal in this ticket",
      ],
      [
        "Tell us about your Event: we are a nonprofit hosting a fundraiser for the shelter",
        "a nonprofit that says 'fundraiser' is still a fundraiser",
      ],
      [
        "Tell us about your Event: our non-profit is holding a charity auction night",
        "'charity' still decides on its own",
      ],
    ];
    for (const [text, why] of stillFundraiser) {
      const got = classify(text);
      if (got !== "fundraiser") {
        throw new Error(
          `ASSERTION FAILED (${why}): classified as "${got}", expected "fundraiser". Demoting "non-profit" must ` +
            `not stop genuine fundraisers being caught.`
        );
      }
    }
    for (const text of [
      "Tell us about your Event: employee party, do you have non-profit rates?",
      "Tell us about your Event: staff retreat, we have a tax-exempt certificate",
      "Tell us about your Event: we are a 501c3",
    ]) {
      const c: TicketContext = {
        ticket: { ...scenarios[0].ctx.ticket, id: 91303, description: text, requester_id: CUSTOMER_ID },
        requester: { id: CUSTOMER_ID, name: "T", email: "t@example.com" },
        comments: [makeComment(text, CUSTOMER_ID)],
        brand: "wine_and_canvas",
      };
      if (!mentionsNonprofitStatus(c)) {
        throw new Error(
          `ASSERTION FAILED: mentionsNonprofitStatus missed ${JSON.stringify(text)}. These customers ask about ` +
            `nonprofit rates and tax exemption, which no quote template answers - they need a human.`
        );
      }
    }
    {
      const text = "Tell us about your Event: a birthday party for my wife";
      const c: TicketContext = {
        ticket: { ...scenarios[0].ctx.ticket, id: 91304, description: text, requester_id: CUSTOMER_ID },
        requester: { id: CUSTOMER_ID, name: "T", email: "t@example.com" },
        comments: [makeComment(text, CUSTOMER_ID)],
        brand: "wine_and_canvas",
      };
      if (mentionsNonprofitStatus(c)) {
        throw new Error(`ASSERTION FAILED: mentionsNonprofitStatus fired on an ordinary birthday inquiry.`);
      }
    }
    // Whole-token matching means inflections must be listed explicitly. If one
    // is dropped from the keyword lists, this is what catches it.
    const stillWorks: Array<[string, string]> = [
      ["Additional Info: we are fundraising for the team", "fundraiser"],
      ["Additional Info: raising donations for the shelter", "fundraiser"],
      ["Additional Info: donating the proceeds", "fundraiser"],
      ["Additional Info: we work with local charities", "fundraiser"],
      ["Additional Info: to support our cause", "fundraiser"],
      ["Additional Info: an employee appreciation night", "corporate"],
      ["Additional Info: a launch party at my office", "corporate"],
      ["Additional Info: one of our celebrations", "standard"],
      ["Additional Info: a few families getting together", "standard"],
      ["Additional Info: an event for every resident", "standard"],
    ];
    for (const [text, want] of stillWorks) {
      const got = classify(text);
      if (got !== want) throw new Error(`ASSERTION FAILED: "${text}" classified as "${got}", expected "${want}". Whole-token matching needs each inflected form spelled out in the keyword lists.`);
    }
    console.log(`\nRegression check passed: ${misfires.length} substring misfires blocked, ${stillWorks.length} inflected forms still classify.`);
  }

  // --- Adult birthdays must not get the kids template (2026-10-05, #29784) ---
  // KIDS_KEYWORDS contained the bare word "birthday", and the classifier
  // checks kids FIRST, so every birthday inquiry got Cookies & Canvas
  // whatever the age. Melissa Marx answered the clarifier with "55th
  // Birthday/Halloween" and was sent the kids quote. It also made
  // KIDS_AGE_PATTERN dead code - that regex exists to cap kids at 16.
  {
    const classify = (text: string): string | null => {
      const c: TicketContext = {
        ticket: { ...scenarios[0].ctx.ticket, id: 91200, description: text, requester_id: CUSTOMER_ID },
        requester: { id: CUSTOMER_ID, name: "T", email: "t@example.com" },
        comments: [makeComment(text, CUSTOMER_ID)],
        brand: "wine_and_canvas",
      };
      return classifyPrivateEvent(c);
    };
    const adult: Array<[string, string | null]> = [
      ["55th Birthday/Halloween", "standard"],                 // #29784, verbatim
      ["Additional Info: 40th birthday celebration", "standard"],
      ["Additional Info: birthday party for about 15 of us", "standard"],
      ["Additional Info: her 17th birthday", "standard"],
      ["Additional Info: 21st birthday", "standard"],
      // The range pattern must not fire on adult ages or on a headcount.
      ["Additional Info: ages 21-30 bachelorette", "standard"],
      ["Additional Info: Guests: 20-30 for a birthday party", "standard"],
      ["Additional Info: bridal shower, ages 25 to 40", "standard"],
    ];
    for (const [text, want] of adult) {
      const got = classify(text);
      if (got !== want) throw new Error(`ASSERTION FAILED: "${text}" classified as "${got}", expected "${want}". An adult birthday must never get the Cookies & Canvas kids template.`);
    }
    const kids: string[] = [
      "Additional Info: 10 year old girl birthday",             // #29638
      "Additional Info: The birthday girl will be turning 10",  // #29575
      "Additional Info: she turns 8 that week",
      "Additional Info: her 8th birthday",
      "Additional Info: my daughter's birthday",
      "Additional Info: a kids party",
      "Additional Info: sweet 16",
      "Additional Info: he is turning 16",
      // Age RANGES and plurals - how people describe a GROUP of children
      // rather than one birthday child (#30423, Kristina Ripani, 2026-10-14).
      "Additional Info: Girls and boys ages 7-9 with a few adults",
      "Additional Info: ages 7-9",
      "Additional Info: ages 7 to 9",
      "Additional Info: a bunch of 8 year olds",
      "Additional Info: 7-9 year olds",
      "Additional Info: Cookies and Canvas for my son",
    ];
    for (const text of kids) {
      const got = classify(text);
      if (got !== "kids") throw new Error(`ASSERTION FAILED: "${text}" classified as "${got}", expected "kids".`);
    }
    // 17 and over is not a kids event, and an address number is not an age.
    if (classify("Additional Info: he is turning 17") === "kids") throw new Error(`ASSERTION FAILED: "turning 17" must not be kids - the template covers 16 and under.`);
    if (classify("Location: 1701 10 mile rd ne") !== null) throw new Error(`ASSERTION FAILED: a street number must not be read as a child's age.`);
    console.log(`\nRegression check passed: ${adult.length} adult birthdays classify as standard, ${kids.length} kid birthdays as kids.`);
  }

  // --- Fort Myers vs Naples pricing split (2026-10-02) ---
  // The riskiest split in the file: one locations.yaml slug feeds TWO pricing
  // keys, so a town in the wrong list is a $6-a-head error on every quote
  // rather than a cosmetic one. Asserting the PRICE, not the key name.
  {
    const lcResolver = new LocationResolver(path.join(CONFIG_DIR, "locations.yaml"));
    const priceFor = (text: string): number | null => {
      const c: TicketContext = {
        ticket: { ...scenarios[0].ctx.ticket, id: 91100, description: text, requester_id: CUSTOMER_ID, subject: "Party Request from Wine & Canvas Florida" },
        requester: { id: CUSTOMER_ID, name: "T", email: "t@example.com" },
        comments: [makeComment(text, CUSTOMER_ID)],
        brand: "wine_and_canvas",
      };
      const loc = lcResolver.resolve(c);
      const key = loc ? resolvePrivateEventLocationKey(c, loc.slug) : null;
      return key ? getLocationInfo(key).pricing.standardTiers[0].pricePerPerson : null;
    };
    const fortMyersSide = ["Fort Myers", "Fort Myers Beach", "North Fort Myers", "Cape Coral", "Sanibel", "Captiva", "Boca Grande", "Bokeelia", "Pineland, FL", "Saint James City", "Lehigh Acres", "Alva, FL", "Estero"];
    const naplesSide = ["Naples", "Bonita Springs", "Marco Island", "Everglades City"];
    for (const town of fortMyersSide) {
      const p = priceFor(`Location: ${town}`);
      if (p !== 39) throw new Error(`ASSERTION FAILED: "${town}" priced at $${p}, expected Fort Myers' $39. Naples is $45 - this slug feeds two pricing keys.`);
    }
    for (const town of naplesSide) {
      const p = priceFor(`Location: ${town}`);
      if (p !== 45) throw new Error(`ASSERTION FAILED: "${town}" priced at $${p}, expected Naples' $45. Fort Myers' $39 under-quotes it by $6 a head.`);
    }
    // Fort Myers wins when a ticket names both - a Fort Myers event that
    // mentions Naples in passing is still a Fort Myers event.
    if (priceFor("Location: Fort Myers - some guests driving from Naples") !== 39) {
      throw new Error(`ASSERTION FAILED: a ticket naming both Fort Myers and Naples must price as Fort Myers.`);
    }
    // Bare "everglades" is a national park and a painting subject.
    if (priceFor("Additional Info: an everglades sunset design") !== null) {
      throw new Error(`ASSERTION FAILED: "an everglades sunset design" matched a location. Bare "everglades" must not be a location keyword.`);
    }
    // Boca Grande (Lee County) and Boca Raton (Broward) must not be confused.
    if (priceFor("Location: Boca Raton") !== 39 || priceFor("Location: Boca Grande") !== 39) {
      throw new Error(`ASSERTION FAILED: Boca Raton and Boca Grande must both price at $39, via Fort Lauderdale and Fort Myers respectively.`);
    }
    console.log(`\nRegression check passed: ${fortMyersSide.length} Fort Myers-side towns price at $39, ${naplesSide.length} Naples-side at $45.`);
  }

  // --- South Florida split by proximity (2026-10-01) ---
  // Unit-level, because the per-scenario harness runs one ticket at a time
  // and there are 40-odd towns. What matters is the PRICE each one lands on.
  {
    const sfResolver = new LocationResolver(path.join(CONFIG_DIR, "locations.yaml"));
    const priceFor = (town: string): number | null => {
      const text = `Location: ${town}`;
      const c: TicketContext = {
        ticket: { ...scenarios[0].ctx.ticket, id: 90900, description: text, requester_id: CUSTOMER_ID, subject: "Party Request from Wine & Canvas Florida" },
        requester: { id: CUSTOMER_ID, name: "T", email: "t@example.com" },
        comments: [makeComment(text, CUSTOMER_ID)],
        brand: "wine_and_canvas",
      };
      const loc = sfResolver.resolve(c);
      const key = loc ? resolvePrivateEventLocationKey(c, loc.slug) : null;
      return key ? getLocationInfo(key).pricing.standardTiers[0].pricePerPerson : null;
    };
    const broward = ["Hollywood, FL", "Pembroke Pines", "Coral Springs", "Miramar", "Pompano Beach", "Davie", "Margate", "Tamarac", "Coconut Creek", "Hallandale Beach", "Dania Beach", "Weston, FL"];
    const dade = ["Kendall", "Homestead", "Doral", "Palmetto Bay", "Pinecrest", "Coral Gables", "Hialeah", "Cutler Bay", "Brickell", "Aventura", "Key Biscayne"];
    for (const town of broward) {
      if (priceFor(town) !== 39) throw new Error(`ASSERTION FAILED: Broward town "${town}" priced at $${priceFor(town)}, expected Fort Lauderdale's $39.`);
    }
    for (const town of dade) {
      if (priceFor(town) !== 45) throw new Error(`ASSERTION FAILED: Miami-Dade town "${town}" priced at $${priceFor(town)}, expected Miami's $45 - Fort Lauderdale's $39 under-quotes it by $6 a head.`);
    }
    // "Sunrise" alone is a painting word long before it is a city, so it
    // must NOT match a location - a human looks at it instead.
    if (priceFor("Sunrise") !== null) {
      throw new Error(`ASSERTION FAILED: bare "Sunrise" matched a location. It is too common in painting titles to use unqualified.`);
    }
    if (priceFor("Sunrise, FL") !== 39) throw new Error(`ASSERTION FAILED: "Sunrise, FL" should price as Fort Lauderdale.`);
    console.log(`\nRegression check passed: ${broward.length} Broward towns price as Fort Lauderdale, ${dade.length} Miami-Dade towns as Miami.`);
  }

  // --- Regression checks for the requester-name fix (2026-09-30, #29607) ---
  const nameLabel = "REGRESSION (#29607): the form name beats the name Zendesk invented from the email address";
  const nameResult = resultsByLabel.get(nameLabel);
  if (!nameResult) throw new Error(`ASSERTION FAILED: scenario "${nameLabel}" did not run`);
  const rename = nameCorrections.find((c) => c.userId === CUSTOMER_ID);
  if (!rename) {
    throw new Error(
      `ASSERTION FAILED: requester-name fix - the pipeline never corrected the Zendesk user record. ` +
        `Follow-up emails 1-3 read the record, not the reply, so without this they all go out as "Hi Viawendy,".`
    );
  }
  if (rename.name !== "Wendy Fortune") {
    throw new Error(`ASSERTION FAILED: requester-name fix - expected the record set to "Wendy Fortune", got "${rename.name}".`);
  }
  console.log(`\nRegression check passed: requester name corrected to "${rename.name}" from the form body.`);

  // Unit-level checks on the pieces, because the pipeline path above only
  // exercises the happy case.
  const nameUnitCases: Array<[string, string | null, string | null, boolean]> = [
    // [stored name, stored email, form name, may we overwrite the record?]
    ["Viawendy", "viawendy@gmail.com", "Wendy Fortune", true],
    ["Trosand", "trosand@example.com", "Taylor Rosand", true],
    ["Mollycaulfield", "mollycaulfield@example.com", "Molly Caulfield", true],
    // A real full name against a form nickname - the record must survive.
    ["Hanadya Ale", "hanadya@example.com", "Hanny Ale", false],
  ];
  for (const [stored, email, _form, mayOverwrite] of nameUnitCases) {
    if (looksMachineDerivedName(stored, email) !== mayOverwrite) {
      throw new Error(
        `ASSERTION FAILED: looksMachineDerivedName("${stored}", "${email}") should be ${mayOverwrite}. ` +
          `Getting this wrong either leaves "Hi Trosand," in place or overwrites someone's real name.`
      );
    }
  }
  // "Last, First" - #29218 was stored as "Halpin, Elisa" and greeted "Hi Halpin,".
  if (firstNameFromFullName("Halpin, Elisa") !== "Elisa") {
    throw new Error(`ASSERTION FAILED: firstNameFromFullName("Halpin, Elisa") should be "Elisa", got "${firstNameFromFullName("Halpin, Elisa")}".`);
  }
  // An unrendered form placeholder must never become a greeting - the same
  // WordPress bug that keeps sending us "[preferredtime]".
  const placeholderCtx: TicketContext = {
    ticket: { ...scenarios[0].ctx.ticket, id: 99999, description: "Party Request from Wine & Canvas\n\nName: [name]\nGuests: 12", requester_id: CUSTOMER_ID },
    requester: { id: CUSTOMER_ID, name: "Realperson Name", email: "real@example.com" },
    comments: [],
    brand: "wine_and_canvas",
  };
  if (extractFormContactName(placeholderCtx) !== null) {
    throw new Error(`ASSERTION FAILED: an unrendered "[name]" placeholder must be rejected, got "${extractFormContactName(placeholderCtx)}".`);
  }
  console.log("Regression check passed: name parsing rejects placeholders, handles \"Last, First\", and leaves real names alone.");

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
  // --- Regression checks for the order-handling rules (2026-09-24) ---
  const orderExpectations: Array<[string, string, string]> = [
    [
      "REGRESSION (#29324): ordinary order at an excluded-city venue should be filed, solved and closed",
      "new_order_confirmation",
      "order_confirmation_solved_and_closed",
    ],
    [
      "REGRESSION (order #180710): first payment for an event is a Private Event Deposit, left Pending",
      "new_order_confirmation",
      "private_event_deposit_pending",
    ],
    [
      "Second payment for the same event should be a Private Event Final Balance, left Pending",
      "new_order_confirmation",
      "private_event_final_balance_pending",
    ],
    ["$0 order should be left Open for a human", "new_order_confirmation", "order_confirmation_left_open"],
  ];
  for (const [label, expectedRule, expectedFinal] of orderExpectations) {
    const r = resultsByLabel.get(label);
    if (!r) throw new Error(`ASSERTION FAILED: scenario "${label}" did not run`);
    if (r.ruleDecision.matchedRule !== expectedRule) {
      throw new Error(
        `ASSERTION FAILED: ${label} - expected matched rule "${expectedRule}", got "${r.ruleDecision.matchedRule}". ` +
          `If this is out_of_scope_location, it is hijacking order tickets again - check the rule order in config/rules.yaml.`
      );
    }
    if (r.finalAction !== expectedFinal) {
      throw new Error(`ASSERTION FAILED: ${label} - expected finalAction "${expectedFinal}", got "${r.finalAction}".`);
    }
  }
  console.log(
    "Regression check passed: ordinary orders solve+close, first payment = Private Event Deposit (Pending), second = Final Balance (Pending), $0 stays Open."
  );

  // --- Grand Rapids sends no kit (2026-10-26) ---
  // Christopher: "I need to update Grand Rapids to not send a kit right away
  // but to say, a restaurant list will be provided based on the artist's
  // availability... This is due to multiple artists in the area."
  //
  // Cadillac is checked alongside it: it has displayed as Grand Rapids since
  // 2026-10-19, and the same displayed market must not link a list for one
  // customer and withhold it from another.
  const GRAND_RAPIDS_KIT = "1_tpH4iq8jeYF07RXhH-FjC7BhPl5SOtZ";
  for (const [ticketId, label] of [
    [91101, "Grand Rapids private party (2026-10-26): no kit link, artist-availability line instead"],
    [91102, "Traverse City private party (2026-10-26): served as Grand Rapids, so also no kit link"],
  ] as Array<[number, string]>) {
    const r = resultsByLabel.get(label);
    if (!r) throw new Error(`ASSERTION FAILED: scenario "${label}" did not run`);
    // NOT r.matchedLocation: that is the locations.yaml display_name, which
    // for the Traverse City side is still "Cadillac, MI" (internal only). The
    // customer-facing name comes from the pricing key's displayName, so the
    // body is what matters - and it must read Grand Rapids for both.
    const text = (bodiesByTicket.get(ticketId) ?? []).join("\n");
    if (!text.includes("Grand Rapids, MI")) {
      throw new Error(
        `ASSERTION FAILED: ${label} - the quote does not name Grand Rapids, MI. Cadillac closed on 2026-10-19 and ` +
          `its area is served from Grand Rapids, so that is the name the customer should see.`
      );
    }
    if (text.includes(GRAND_RAPIDS_KIT)) {
      throw new Error(
        `ASSERTION FAILED: ${label} - the quote still links the Grand Rapids kit. It must not go out ` +
          `automatically: there are multiple artists in the area and the right list depends on who covers the date.`
      );
    }
    if (!/once we confirm which artist is available for your date/i.test(text)) {
      throw new Error(
        `ASSERTION FAILED: ${label} - the quote does not tell the customer the restaurant list follows once the ` +
          `artist is confirmed. Body was: ${JSON.stringify(text.slice(0, 500))}`
      );
    }
    if (/Restaurant List Link/i.test(text)) {
      throw new Error(`ASSERTION FAILED: ${label} - the quote still carries a "Restaurant List Link" label.`);
    }
  }
  // Markets that DO have a kit must be unaffected - this change is Michigan
  // only, and the null branch is shared by all three templates.
  for (const [ticketId, label, kit] of [
    [91001, "Sarasota standard private party (2026-10-26): Tampa pricing, Sarasota venue kit", "16duDOCQhUKjzXNiIhbp3fd4niuI7aTOw"],
    [90901, "Bloomington standard private party (2026-10-26): Indianapolis pricing, Bloomington venue kit", "1PVGbphfP5tJU2G11Y10CLHf35wmhdSL0"],
  ] as Array<[number, string, string]>) {
    const text = (bodiesByTicket.get(ticketId) ?? []).join("\n");
    if (!text.includes(kit)) {
      throw new Error(`ASSERTION FAILED: ${label} - lost its kit link when Grand Rapids' was removed.`);
    }
    if (/once we confirm which artist is available/i.test(text)) {
      throw new Error(
        `ASSERTION FAILED: ${label} - a market WITH a kit is sending the artist-availability line as well.`
      );
    }
  }
  // The null branch used to emit a literal "[TODO_CHRISTOPHER: restaurant
  // list link for X]" placeholder. Nothing reached it while every market had
  // a kit; Grand Rapids now does, so this guards every rendered body.
  for (const [ticketId, bodies] of bodiesByTicket) {
    if (bodies.join("\n").includes("TODO_CHRISTOPHER")) {
      throw new Error(
        `ASSERTION FAILED: ticket ${ticketId}'s reply contains a TODO_CHRISTOPHER placeholder - that is customer-facing text.`
      );
    }
  }
  console.log("Regression check passed: Grand Rapids and Cadillac send no kit link, just the artist-availability line; markets with a kit keep theirs (2026-10-26).");

  // --- Sarasota, FL (2026-10-26) ---
  // Christopher: "Adding Sarasota to our territories now. Please quote
  // private events the same pricing as Tampa but send this SARASOTA
  // RESTAURANT LIST LINK."
  const SARASOTA_VENUE_KIT = "16duDOCQhUKjzXNiIhbp3fd4niuI7aTOw";
  const TAMPA_VENUE_KIT = "1gTEOFxbdbvKhMtKhfOPo_-ZxgfAO_A9-";
  for (const [ticketId, label, expectedPrices] of [
    [91001, "Sarasota standard private party (2026-10-26): Tampa pricing, Sarasota venue kit", ["$39", "$35", "$30"]],
    [91002, "Sarasota corporate private party (2026-10-26): Tampa corporate pricing", ["$44", "$40", "$35"]],
    [91003, "Sarasota Cookies & Canvas kids party (2026-10-26): Tampa kids pricing", ["$29"]],
    [91004, "Sarasota fundraiser (2026-10-26): Tampa fundraiser pricing", ["$39", "$34"]],
  ] as Array<[number, string, string[]]>) {
    const r = resultsByLabel.get(label);
    if (!r) throw new Error(`ASSERTION FAILED: scenario "${label}" did not run`);
    if (r.ruleDecision.matchedRule !== "event_booking_question") {
      throw new Error(
        `ASSERTION FAILED: ${label} - matched "${r.ruleDecision.matchedRule}" instead of event_booking_question.`
      );
    }
    if (r.matchedLocation !== "Sarasota, FL") {
      throw new Error(
        `ASSERTION FAILED: ${label} - resolved to "${r.matchedLocation}" instead of "Sarasota, FL". If it came out ` +
          `as Tampa, Sarasota's own slug is not matching and the customer gets Tampa's venue kit and name.`
      );
    }
    const text = (bodiesByTicket.get(ticketId) ?? []).join("\n");
    for (const price of expectedPrices) {
      if (!text.includes(price)) {
        throw new Error(
          `ASSERTION FAILED: ${label} - the quote does not mention ${price}. Sarasota is Group A, the same as ` +
            `Tampa: 39/35/30 standard, 44/40/35 corporate, $29 kids, $39 fundraiser retail keeping $34.`
        );
      }
    }
    if (ticketId === 91001 && (text.includes("$45") || text.includes("$50"))) {
      throw new Error(`ASSERTION FAILED: ${label} - the quote mentions a Group B rate ($45/$50). Sarasota is Group A.`);
    }
    if (!text.includes(SARASOTA_VENUE_KIT)) {
      throw new Error(
        `ASSERTION FAILED: ${label} - the quote does not link Sarasota's own venue kit. He sent a separate kit; ` +
          `sharing Tampa's would send customers venues 60 miles away.`
      );
    }
    if (text.includes(TAMPA_VENUE_KIT)) {
      throw new Error(`ASSERTION FAILED: ${label} - the quote links TAMPA's venue kit. Same pricing, different venues.`);
    }
  }
  // The $40 travel-fee split, Christopher 2026-10-26: "You can include these
  // areas but with a $40 travel fee: Venice, North Port, Englewood, Osprey,
  // Nokomis and Bradenton."
  {
    const saraResolver = new LocationResolver(path.join(CONFIG_DIR, "locations.yaml"));
    const keyFor = (town: string): string | null => {
      const text = `Party Request from Wine & Canvas\n\nGuests: 20\nLocation: ${town}`;
      const c: TicketContext = {
        ticket: { ...scenarios[0].ctx.ticket, id: 91400, description: text, requester_id: CUSTOMER_ID, subject: "Party Request from Wine & Canvas" },
        requester: { id: CUSTOMER_ID, name: "T", email: "t@example.com" },
        comments: [makeComment(text, CUSTOMER_ID)],
        brand: "wine_and_canvas",
      };
      const loc = saraResolver.resolve(c);
      return loc ? resolvePrivateEventLocationKey(c, loc.slug) : null;
    };
    for (const town of ["Sarasota, FL", "Siesta Key", "Lido Key", "Longboat Key"]) {
      if (keyFor(town) !== "sarasota") {
        throw new Error(
          `ASSERTION FAILED: "${town}" resolved to ${JSON.stringify(keyFor(town))}, expected "sarasota" (no fee).`
        );
      }
    }
    for (const town of ["Venice, FL", "North Port", "Englewood, FL", "Osprey, FL", "Nokomis, FL", "Bradenton"]) {
      if (keyFor(town) !== "sarasota-travel") {
        throw new Error(
          `ASSERTION FAILED: "${town}" resolved to ${JSON.stringify(keyFor(town))}, expected "sarasota-travel". ` +
            `Quoting one of these with no fee means going back to add $40 after the customer has seen a number.`
        );
      }
    }
    // Bare forms of the ambiguous ones must NOT reach Florida. Nokomis is the
    // dangerous one: it is a lake and neighbourhood in Minneapolis, which is
    // an excluded market on this brand.
    for (const town of ["Venice, CA", "Venice, Italy", "Englewood, CO", "Lake Nokomis, Minneapolis, MN"]) {
      const key = keyFor(town);
      if (key === "sarasota" || key === "sarasota-travel") {
        throw new Error(
          `ASSERTION FAILED: "${town}" resolved to the Sarasota key ${JSON.stringify(key)}. These keywords must ` +
            `stay state-qualified.`
        );
      }
    }
    // A ticket naming both must carry the fee.
    if (keyFor("Sarasota area - the party is in Bradenton") !== "sarasota-travel") {
      throw new Error(
        `ASSERTION FAILED: a ticket naming both Sarasota and Bradenton lost the fee. A fee town named anywhere wins.`
      );
    }
    const saraTravel = getLocationInfo("sarasota-travel");
    if (JSON.stringify(saraTravel.pricing) !== JSON.stringify(getLocationInfo("sarasota").pricing)) {
      throw new Error(`ASSERTION FAILED: the fee towns are priced differently from Sarasota; only the fee differs.`);
    }
    if (saraTravel.restaurantListUrl !== getLocationInfo("sarasota").restaurantListUrl) {
      throw new Error(`ASSERTION FAILED: the fee towns should share Sarasota's venue kit.`);
    }
    if (!saraTravel.travelFee || !saraTravel.travelFee.includes("$40")) {
      throw new Error(
        `ASSERTION FAILED: the Sarasota fee towns' travel fee is ${JSON.stringify(saraTravel.travelFee)} - it must ` +
          `state $40.`
      );
    }
    // The rendered quote, end to end.
    const bradLabel = "Bradenton, FL private party (2026-10-26): Sarasota pricing plus a $40 travel fee";
    const brad = resultsByLabel.get(bradLabel);
    if (!brad) throw new Error(`ASSERTION FAILED: scenario "${bradLabel}" did not run`);
    if (brad.ruleDecision.matchedRule !== "event_booking_question") {
      throw new Error(`ASSERTION FAILED: ${bradLabel} - matched "${brad.ruleDecision.matchedRule}".`);
    }
    const bradText = (bodiesByTicket.get(91006) ?? []).join("\n");
    if (!bradText.includes("$40 travel fee")) {
      throw new Error(
        `ASSERTION FAILED: ${bradLabel} - the quote does not state the $40 travel fee.`
      );
    }
    if (!bradText.includes("$39")) {
      throw new Error(`ASSERTION FAILED: ${bradLabel} - not at Sarasota/Tampa rates.`);
    }
    // And Sarasota proper must not have picked it up.
    const saraText = (bodiesByTicket.get(91001) ?? []).join("\n");
    if (/\$40 travel fee/.test(saraText)) {
      throw new Error(
        `ASSERTION FAILED: the Sarasota quote states a $40 travel fee. Sarasota proper and its keys carry none.`
      );
    }
  }

  {
    // Same rates as Tampa, read off both entries rather than restated.
    const sara = getLocationInfo("sarasota");
    const tampa = getLocationInfo("tampa");
    if (JSON.stringify(sara.pricing) !== JSON.stringify(tampa.pricing)) {
      throw new Error(
        `ASSERTION FAILED: Sarasota's pricing has drifted from Tampa's. Christopher, 2026-10-26: "the same ` +
          `pricing as Tampa". Sarasota: ${JSON.stringify(sara.pricing)}; Tampa: ${JSON.stringify(tampa.pricing)}.`
      );
    }
    if (sara.restaurantListUrl === tampa.restaurantListUrl) {
      throw new Error(`ASSERTION FAILED: Sarasota and Tampa share a venue kit link. He sent a separate kit.`);
    }
    if (sara.travelFee) {
      throw new Error(`ASSERTION FAILED: Sarasota has a travel fee set (${sara.travelFee}); none was given.`);
    }
    // No Sarasota page exists on the live Florida site, so this must stay
    // null rather than a guessed /florida/sarasota/ or a borrowed Tampa link.
    if (PRIVATE_EVENT_LOCATION_CALENDAR_LINKS.sarasota !== null) {
      throw new Error(
        `ASSERTION FAILED: Sarasota's calendar link is ` +
          `${JSON.stringify(PRIVATE_EVENT_LOCATION_CALENDAR_LINKS.sarasota)}, expected null. The Florida site had ` +
          `no Sarasota page as of 2026-10-26 - its Event Locations menu lists Fort Lauderdale, Fort Myers, Miami, ` +
          `Orlando and Tampa Bay only. Set this the moment a real page exists, but never guess one.`
      );
    }
  }
  {
    // The null-calendar fallback, which Sarasota is currently the only market
    // to exercise - Cadillac was the last one and now shares Grand Rapids'
    // link, so this path had no coverage at all.
    const label = "Sarasota party under the minimum (2026-10-26): no calendar page, so the phone/email fallback";
    const r = resultsByLabel.get(label);
    if (!r) throw new Error(`ASSERTION FAILED: scenario "${label}" did not run`);
    if (r.finalAction !== "private_event_below_minimum") {
      throw new Error(
        `ASSERTION FAILED: ${label} - produced "${r.finalAction}" instead of private_event_below_minimum.`
      );
    }
    const text = (bodiesByTicket.get(91005) ?? []).join("\n");
    if (!text.includes("(866) 631-0226") || !text.includes("support@wineandcanvas.com")) {
      throw new Error(
        `ASSERTION FAILED: ${label} - with no calendar page the reply must fall back to the phone/email line. ` +
          `Body was: ${JSON.stringify(text.slice(0, 400))}`
      );
    }
    if (/florida\/sarasota/i.test(text) || text.includes("florida/tampa")) {
      throw new Error(
        `ASSERTION FAILED: ${label} - the reply links a calendar page. /florida/sarasota/ does not exist, and ` +
          `Tampa's is 60 miles away.`
      );
    }
  }
  console.log("Regression check passed: Sarasota, FL quotes at Tampa rates across all four categories, with its own venue kit, and falls back to phone/email with no calendar page (2026-10-26).");

  // --- Bloomington, IN (2026-10-26) ---
  // Christopher: "New location to add for private event macros. Is the same
  // pricing as Indianapolis. Please add Bloomington, Indiana for private
  // party standard, corporate, Kids, and fundraiser." Plus its own venue kit.
  //
  // Bloomington was in out_of_scope_location until this change (the former
  // Bloomington licensee's territory, 2026-10-01), and that rule sits above
  // event_booking_question - so the FIRST thing each of these asserts is the
  // matched rule. Put "bloomington, in" back in that rule and all four fail
  // there, which is the whole point: the pricing below is unreachable while
  // the exclusion stands.
  const BLOOMINGTON_VENUE_KIT = "1PVGbphfP5tJU2G11Y10CLHf35wmhdSL0";
  const INDIANAPOLIS_VENUE_KIT = "1ljOmNUETCo9iB6Cya5NycSgwNK-fjfza";
  for (const [ticketId, label, expectedPrices] of [
    [90901, "Bloomington standard private party (2026-10-26): Indianapolis pricing, Bloomington venue kit", ["$39", "$35", "$30"]],
    [90902, "Bloomington corporate private party (2026-10-26): Indianapolis corporate pricing", ["$44", "$40", "$35"]],
    [90903, "Bloomington Cookies & Canvas kids party (2026-10-26): Indianapolis kids pricing", ["$29"]],
    [90904, "Bloomington fundraiser (2026-10-26): Indianapolis fundraiser pricing", ["$39", "$34"]],
  ] as Array<[number, string, string[]]>) {
    const r = resultsByLabel.get(label);
    if (!r) throw new Error(`ASSERTION FAILED: scenario "${label}" did not run`);
    if (r.ruleDecision.matchedRule !== "event_booking_question") {
      throw new Error(
        `ASSERTION FAILED: ${label} - matched "${r.ruleDecision.matchedRule}" instead of event_booking_question. ` +
          `If that is out_of_scope_location, Bloomington is still excluded there and none of these quotes can ever ` +
          `be sent - see the 2026-10-26 note in config/rules.yaml.`
      );
    }
    // With PRIVATE_EVENT_QUOTES_LIVE off in this test environment the quote
    // is held as an internal note rather than sent - same as the clarifier
    // checks further down. The rendered quote body is identical either way,
    // which is what the pricing and venue-kit assertions below read.
    if (r.finalAction !== "posted_internal_note") {
      throw new Error(
        `ASSERTION FAILED: ${label} - expected finalAction "posted_internal_note" (this harness runs in draft ` +
          `mode), got "${r.finalAction}".`
      );
    }
    if (r.matchedLocation !== "Bloomington, IN") {
      throw new Error(
        `ASSERTION FAILED: ${label} - resolved to "${r.matchedLocation}" instead of "Bloomington, IN". ` +
          `A bare "bloomington" keyword would also pull in Bloomington MN and IL, both larger cities - the ` +
          `locations.yaml entry is state-qualified on purpose.`
      );
    }
    const text = (bodiesByTicket.get(ticketId) ?? []).join("\n");
    for (const price of expectedPrices) {
      if (!text.includes(price)) {
        throw new Error(
          `ASSERTION FAILED: ${label} - the quote does not mention ${price}. Bloomington is Group A, the same as ` +
            `Indianapolis: 39/35/30 standard, 44/40/35 corporate, $29 kids, $39 fundraiser retail keeping $34.`
        );
      }
    }
    // Group B prices would mean it was grouped with Orlando/Naples/Miami.
    if (ticketId === 90901 && (text.includes("$45") || text.includes("$50"))) {
      throw new Error(
        `ASSERTION FAILED: ${label} - the quote mentions a Group B rate ($45/$50). Bloomington is Group A.`
      );
    }
    if (!text.includes(BLOOMINGTON_VENUE_KIT)) {
      throw new Error(
        `ASSERTION FAILED: ${label} - the quote does not link Bloomington's own venue kit. Christopher sent a ` +
          `separate kit for this market; sharing Indianapolis's would send customers the wrong venue list.`
      );
    }
    if (text.includes(INDIANAPOLIS_VENUE_KIT)) {
      throw new Error(
        `ASSERTION FAILED: ${label} - the quote links INDIANAPOLIS's venue kit. Same pricing does not mean the ` +
          `same venues.`
      );
    }
  }
  // The rendered quote for a fee town, end to end.
  {
    const label = "Bedford, IN private party (2026-10-26): Bloomington pricing plus the TBD travel-fee line";
    const r = resultsByLabel.get(label);
    if (!r) throw new Error(`ASSERTION FAILED: scenario "${label}" did not run`);
    if (r.ruleDecision.matchedRule !== "event_booking_question") {
      throw new Error(
        `ASSERTION FAILED: ${label} - matched "${r.ruleDecision.matchedRule}". Bedford was in ` +
          `out_of_scope_location until 2026-10-26; if that is what matched, it is back.`
      );
    }
    const text = (bodiesByTicket.get(90905) ?? []).join("\n");
    if (!/travel fee will be required/i.test(text)) {
      throw new Error(
        `ASSERTION FAILED: ${label} - the quote does not tell the customer a travel fee will be required. ` +
          `Christopher, 2026-10-26: Bedford, French Lick and Terre Haute "will require a service fee".`
      );
    }
    if (!/let you know how much shortly/i.test(text)) {
      throw new Error(`ASSERTION FAILED: ${label} - the quote omits the "we will let you know how much shortly" half.`);
    }
    if (!text.includes("$39")) {
      throw new Error(`ASSERTION FAILED: ${label} - the quote is not at Bloomington/Indianapolis rates.`);
    }
    // And the no-fee markets must NOT have picked up that sentence. Checked
    // against the SPECIFIC wording, not the words "travel fee": every
    // market's corporate template already carries a generic "Travel fees may
    // apply outside the greater city limits." line, so a looser test here
    // fails on all of them.
    const bloomText = (bodiesByTicket.get(90901) ?? []).join("\n");
    if (/will be required/i.test(bloomText) || /let you know how much shortly/i.test(bloomText)) {
      throw new Error(
        `ASSERTION FAILED: the Bloomington quote states that a travel fee WILL be required. Bloomington, ` +
          `Martinsville and Ellettsville carry none - telling those customers a fee is coming would lose jobs.`
      );
    }
  }

  // Martinsville, end to end THROUGH THE RULES ENGINE. The key-resolution
  // checks below call the resolver directly, which skips
  // out_of_scope_location entirely - so putting Martinsville back in that
  // rule passed every one of them. This scenario is what catches that.
  {
    const label = "Martinsville, IN private party (2026-10-26): in service area, NO travel fee";
    const r = resultsByLabel.get(label);
    if (!r) throw new Error(`ASSERTION FAILED: scenario "${label}" did not run`);
    if (r.ruleDecision.matchedRule !== "event_booking_question") {
      throw new Error(
        `ASSERTION FAILED: ${label} - matched "${r.ruleDecision.matchedRule}" instead of event_booking_question. ` +
          `If that is out_of_scope_location, Martinsville is excluded again - Christopher, 2026-10-26: ` +
          `"Martinsville is in service area with no travel fee."`
      );
    }
    if (r.matchedLocation !== "Bloomington, IN") {
      throw new Error(`ASSERTION FAILED: ${label} - resolved to ${JSON.stringify(r.matchedLocation)}.`);
    }
    const text = (bodiesByTicket.get(90906) ?? []).join("\n");
    if (/will be required/i.test(text) || /let you know how much shortly/i.test(text)) {
      throw new Error(
        `ASSERTION FAILED: ${label} - the quote tells Martinsville a travel fee will be required. It has none.`
      );
    }
    if (!text.includes("$39")) {
      throw new Error(`ASSERTION FAILED: ${label} - not at Bloomington/Indianapolis rates.`);
    }
  }

  // The location KEY, which is what becomes the private_event_location_*
  // tag on the live send and is what the follow-up sweep reads at email 3 to
  // pick the calendar link and promo pool. Asserted directly rather than off
  // the ticket's tags, because the draft-mode path this harness runs does not
  // apply the location tag.
  {
    const bloomResolver = new LocationResolver(path.join(CONFIG_DIR, "locations.yaml"));
    const bloomingtonTowns = ["Bloomington, IN", "Bloomington Indiana", "Ellettsville", "Monroe County, IN"];
    for (const town of bloomingtonTowns) {
      const text = `Party Request from Wine & Canvas\n\nGuests: 20\nLocation: ${town}`;
      const c: TicketContext = {
        ticket: { ...scenarios[0].ctx.ticket, id: 91300, description: text, requester_id: CUSTOMER_ID, subject: "Party Request from Wine & Canvas" },
        requester: { id: CUSTOMER_ID, name: "T", email: "t@example.com" },
        comments: [makeComment(text, CUSTOMER_ID)],
        brand: "wine_and_canvas",
      };
      const loc = bloomResolver.resolve(c);
      const key = loc ? resolvePrivateEventLocationKey(c, loc.slug) : null;
      if (key !== "bloomington") {
        throw new Error(
          `ASSERTION FAILED: "${town}" resolved to location key ${JSON.stringify(key)} instead of "bloomington". ` +
            `That key becomes the private_event_location_* tag the follow-up sweep reads at email 3.`
        );
      }
    }
    // Minnesota and Illinois Bloomington must NOT land here. Minneapolis and
    // Rochester MN are excluded markets on this brand, so a bare
    // "bloomington" keyword would quote Indiana prices for a city we do not
    // serve at all.
    for (const town of ["Bloomington, MN", "Bloomington Minnesota", "Bloomington, IL"]) {
      const text = `Party Request from Wine & Canvas\n\nGuests: 20\nLocation: ${town}`;
      const c: TicketContext = {
        ticket: { ...scenarios[0].ctx.ticket, id: 91301, description: text, requester_id: CUSTOMER_ID, subject: "Party Request from Wine & Canvas" },
        requester: { id: CUSTOMER_ID, name: "T", email: "t@example.com" },
        comments: [makeComment(text, CUSTOMER_ID)],
        brand: "wine_and_canvas",
      };
      const loc = bloomResolver.resolve(c);
      const key = loc ? resolvePrivateEventLocationKey(c, loc.slug) : null;
      if (key === "bloomington") {
        throw new Error(
          `ASSERTION FAILED: "${town}" resolved to the Indiana "bloomington" key. The locations.yaml entry must ` +
            `stay state-qualified - Bloomington MN and Bloomington IL are both larger than Bloomington IN.`
        );
      }
    }
    // Travel-fee split, Christopher 2026-10-26. Same slug, same prices, two
    // answers on the fee.
    const NO_FEE_TOWNS = ["Bloomington, IN", "Martinsville, IN", "Ellettsville"];
    const FEE_TOWNS = ["Bedford, IN", "French Lick", "Terre Haute"];
    const keyFor = (town: string): string | null => {
      const text = `Party Request from Wine & Canvas\n\nGuests: 20\nLocation: ${town}`;
      const c: TicketContext = {
        ticket: { ...scenarios[0].ctx.ticket, id: 91302, description: text, requester_id: CUSTOMER_ID, subject: "Party Request from Wine & Canvas" },
        requester: { id: CUSTOMER_ID, name: "T", email: "t@example.com" },
        comments: [makeComment(text, CUSTOMER_ID)],
        brand: "wine_and_canvas",
      };
      const loc = bloomResolver.resolve(c);
      return loc ? resolvePrivateEventLocationKey(c, loc.slug) : null;
    };
    for (const town of NO_FEE_TOWNS) {
      const key = keyFor(town);
      if (key !== "bloomington") {
        throw new Error(
          `ASSERTION FAILED: "${town}" resolved to ${JSON.stringify(key)}, expected "bloomington" (no travel fee). ` +
            `Christopher, 2026-10-26: "Martinsville is in service area with no travel fee."`
        );
      }
      if (getLocationInfo("bloomington").travelFee) {
        throw new Error(`ASSERTION FAILED: the no-fee Bloomington key has a travel fee set.`);
      }
    }
    for (const town of FEE_TOWNS) {
      const key = keyFor(town);
      if (key !== "bloomington-travel") {
        throw new Error(
          `ASSERTION FAILED: "${town}" resolved to ${JSON.stringify(key)}, expected "bloomington-travel". ` +
            `Christopher, 2026-10-26: "Bedford, French Link [Lick], and Terre Haute are available for parties but ` +
            `will require a service fee." Quoting one of these with no fee means going back to add one.`
        );
      }
    }
    // A ticket naming both must carry the fee - the recoverable error. See
    // the note in resolvePrivateEventLocationKey for why this is the
    // opposite of the Fort Myers/Naples rule.
    const bothKey = keyFor("Bloomington, IN area - the party is in Bedford, IN");
    if (bothKey !== "bloomington-travel") {
      throw new Error(
        `ASSERTION FAILED: a ticket naming both Bloomington and Bedford resolved to ${JSON.stringify(bothKey)}. ` +
          `A fee town named anywhere has to win, or a Bedford party gets quoted with no fee.`
      );
    }
    // The fee towns are priced identically - only the fee sentence differs.
    const travel = getLocationInfo("bloomington-travel");
    if (JSON.stringify(travel.pricing) !== JSON.stringify(getLocationInfo("bloomington").pricing)) {
      throw new Error(`ASSERTION FAILED: the fee towns are priced differently from Bloomington; only the fee differs.`);
    }
    if (travel.restaurantListUrl !== getLocationInfo("bloomington").restaurantListUrl) {
      throw new Error(`ASSERTION FAILED: the fee towns should share Bloomington's venue kit.`);
    }
    // His exact instruction: "just say 'travel fee will be required, we will
    // let you know how much shortly.'" No invented amount.
    if (!travel.travelFee) {
      throw new Error(`ASSERTION FAILED: the fee towns carry no travel-fee sentence at all.`);
    }
    if (!/travel fee will be required/i.test(travel.travelFee) || !/let you know how much shortly/i.test(travel.travelFee)) {
      throw new Error(
        `ASSERTION FAILED: the travel-fee sentence is ${JSON.stringify(travel.travelFee)}. Christopher gave the ` +
          `copy verbatim: "travel fee will be required, we will let you know how much shortly."`
      );
    }
    if (/\$\d/.test(travel.travelFee)) {
      throw new Error(
        `ASSERTION FAILED: the travel-fee sentence names an amount (${JSON.stringify(travel.travelFee)}). Nobody ` +
          `knows it yet - he has to ask the artist.`
      );
    }
    // Cadillac still states its real amount, so folding the amount into the
    // sentence did not lose it.
    const cadillacFee = getLocationInfo("cadillac").travelFee;
    if (!cadillacFee || !cadillacFee.includes("$100")) {
      throw new Error(
        `ASSERTION FAILED: Grand Rapids/Cadillac's travel fee is ${JSON.stringify(cadillacFee)} - it must still ` +
          `state $100. travelFee now holds the whole sentence rather than just the amount.`
      );
    }

    // Same rates as Indianapolis, read off both entries rather than restated.
    const bloom = getLocationInfo("bloomington");
    const indy = getLocationInfo("indianapolis");
    if (JSON.stringify(bloom.pricing) !== JSON.stringify(indy.pricing)) {
      throw new Error(
        `ASSERTION FAILED: Bloomington's pricing has drifted from Indianapolis's. Christopher, 2026-10-26: "Is ` +
          `the same pricing as Indianapolis." Bloomington: ${JSON.stringify(bloom.pricing)}; Indianapolis: ` +
          `${JSON.stringify(indy.pricing)}.`
      );
    }
    if (bloom.restaurantListUrl === indy.restaurantListUrl) {
      throw new Error(
        `ASSERTION FAILED: Bloomington and Indianapolis share a venue kit link. Same pricing, different venues - ` +
          `Christopher sent a separate kit for Bloomington.`
      );
    }
    if (bloom.travelFee) {
      throw new Error(`ASSERTION FAILED: Bloomington has a travel fee set (${bloom.travelFee}); none was given.`);
    }
  }

  // The calendar link email 3 and the below-minimum reply use. Read off the
  // Bloomington subsite's own nav, not pattern-matched from Indianapolis.
  if (PRIVATE_EVENT_LOCATION_CALENDAR_LINKS.bloomington !== "https://wineandcanvas.com/bloomington/events/") {
    throw new Error(
      `ASSERTION FAILED: Bloomington's public calendar link is ` +
        `${JSON.stringify(PRIVATE_EVENT_LOCATION_CALENDAR_LINKS.bloomington)}, expected ` +
        `https://wineandcanvas.com/bloomington/events/.`
    );
  }
  console.log("Regression check passed: Bloomington, IN quotes at Indianapolis rates across all four categories, with its own venue kit and calendar link (2026-10-26).");

  // --- Regression check for the newsletter rule-ordering fix (2026-09-24) ---
  const newsLabel = "REGRESSION: Newsletter Sign Up naming an excluded city should still be filed and closed";
  const newsResult = resultsByLabel.get(newsLabel);
  if (!newsResult) throw new Error(`ASSERTION FAILED: scenario "${newsLabel}" did not run`);
  if (newsResult.ruleDecision.matchedRule !== "newsletter_signup_ticket") {
    throw new Error(
      `ASSERTION FAILED: newsletter ordering regression - expected matched rule "newsletter_signup_ticket", got "${newsResult.ruleDecision.matchedRule}". ` +
        `out_of_scope_location is hijacking newsletter signups - check the rule order in config/rules.yaml.`
    );
  }
  if (newsResult.finalAction !== "newsletter_signup_solved_and_closed") {
    throw new Error(
      `ASSERTION FAILED: newsletter ordering regression - expected finalAction "newsletter_signup_solved_and_closed", got "${newsResult.finalAction}".`
    );
  }

  // --- Newsletter signup: the field value and the status sequence (2026-10-22) ---
  // The two checks above assert the matched rule and the finalAction string.
  // Neither could ever have caught a wrong tagger value, because this mock's
  // updateTicket silently dropped `fields` - and this branch does all its
  // work in updateTicket, posting no comment. Now recorded, so these assert
  // what actually lands on the ticket.
  //
  // Christopher, 2026-10-22: "Tickets with New submission from Newsletter
  // Signup subject lines should be closed with reason for contacting
  // newsletter signup and status closed with solved."
  const nlNewLabel = 'REGRESSION (2026-10-22): "New submission from Newsletter Signup" is filed, Solved and Closed';
  const nlNew = resultsByLabel.get(nlNewLabel);
  if (!nlNew) throw new Error(`ASSERTION FAILED: scenario "${nlNewLabel}" did not run`);
  if (nlNew.ruleDecision.matchedRule !== "newsletter_signup_ticket") {
    throw new Error(
      `ASSERTION FAILED: the "New submission from Newsletter Signup" wording matched ` +
        `"${nlNew.ruleDecision.matchedRule}" instead of newsletter_signup_ticket. This brand's keywords have to ` +
        `cover the storefront form's wording, not just "<Brand> - <City> Newsletter Sign Up".`
    );
  }
  if (nlNew.finalAction !== "newsletter_signup_solved_and_closed") {
    throw new Error(
      `ASSERTION FAILED: expected newsletter_signup_solved_and_closed, got "${nlNew.finalAction}".`
    );
  }
  if ((statusesSetByTicket.get(7742) ?? []).join(",") !== "solved,closed") {
    throw new Error(
      `ASSERTION FAILED: expected the status sequence solved -> closed, got ` +
        `"${(statusesSetByTicket.get(7742) ?? []).join(",") || "(none)"}". Zendesk rejects a direct new -> closed ` +
        `jump, so the ticket has to pass through Solved.`
    );
  }
  // The literal, NOT NEWSLETTER_SIGNUP_FIELD_VALUE: this assertion exists to
  // guard that constant, and comparing it against itself would always pass.
  // Read off this brand's live field (24492007664795) - option "Newsletter
  // Sign up", value "newsletter_sign_up". If the option is ever rebuilt,
  // change it here and in src/config.ts together.
  const EXPECTED_NEWSLETTER_VALUE = "newsletter_sign_up";
  const nlNewField = (fieldsSetByTicket.get(7742) ?? []).find((f) => f.id === ORDER_CONFIRMATION_FIELD_ID);
  if (nlNewField?.value !== EXPECTED_NEWSLETTER_VALUE) {
    throw new Error(
      `ASSERTION FAILED: "Reason for Customer Contacting Us" was set to ${JSON.stringify(nlNewField?.value)} ` +
        `instead of "${EXPECTED_NEWSLETTER_VALUE}". Zendesk silently ignores a tagger value that is not one of ` +
        `the field's options, leaving the field blank on every ticket. This brand's option is "Newsletter Sign up" ` +
        `(value "newsletter_sign_up"); Painting and Vino's is "Newsletter Signup" (value "newsletter_signup") - ` +
        `do not copy one to the other.`
    );
  }
  if (commentedTicketIds.includes(7742)) {
    throw new Error(
      `ASSERTION FAILED: a newsletter notification had a comment posted on it. Nobody is asking anything; nothing ` +
        `should reach the requester, in draft or auto mode.`
    );
  }
  console.log("Regression check passed: newsletter signup notifications are filed as Newsletter Sign up, Solved then Closed, with no reply (2026-10-22).");
  console.log("Regression check passed: newsletter signups from excluded cities are still filed and closed.");

  // --- Clarifier checks (Christopher, 2026-09-25) ---
  // NOTE: with PRIVATE_EVENT_QUOTES_LIVE off in this test environment the
  // clarifier is held as an internal note rather than sent, exactly like
  // the quote itself - so the expected finalAction here is
  // posted_internal_note. What these assert is that the pipeline REACHED
  // the clarifier branch instead of quoting a guess.
  const clarifierCases: Array<[string, string]> = [
    ["Contact-form request with a known city but no stated occasion should ask what the focus is", "event_booking_question"],
    ["Contact-form request with Location: unsure and no occasion should ask both questions", "event_booking_question"],
    // The customer's own reply no longer carries the contact-form phrase
    // event_booking_question requires, so it is the tag-matched
    // private_event_clarification_reply rule that routes it back into the
    // private-event branch. Without that rule the answer we asked for
    // would fall through to a generic FAQ rule.
    ["Clarifier already sent and the reply is still unclear - should go to a human, not ask again", "private_event_clarification_reply"],
    ["Customer answers the clarifying question - should now quote properly", "private_event_clarification_reply"],
  ];
  for (const [label, expectedRule] of clarifierCases) {
    const r = resultsByLabel.get(label);
    if (!r) throw new Error(`ASSERTION FAILED: scenario "${label}" did not run`);
    if (r.finalAction !== "posted_internal_note") {
      throw new Error(`ASSERTION FAILED: ${label} - expected finalAction "posted_internal_note", got "${r.finalAction}".`);
    }
    if (r.ruleDecision.matchedRule !== expectedRule) {
      throw new Error(`ASSERTION FAILED: ${label} - expected matched rule "${expectedRule}", got "${r.ruleDecision.matchedRule}".`);
    }
  }
  // --- Reason for Customer Contacting Us on every private-event path ---
  const REASON_FIELD_ID = 24492007664795;
  for (const [label, ticketId] of [
    ["Contact-form request with a known city but no stated occasion should ask what the focus is", 90200],
    ["Contact-form request with Location: unsure and no occasion should ask both questions", 90201],
    ["Clarifier already sent and the reply is still unclear - should go to a human, not ask again", 90202],
    ["Customer answers the clarifying question - should now quote properly", 90203],
  ] as Array<[string, number]>) {
    const set = fieldsSetByTicket.get(ticketId) ?? [];
    const reason = set.find((f) => f.id === REASON_FIELD_ID);
    if (!reason || reason.value !== "private_events") {
      throw new Error(
        `ASSERTION FAILED: ${label} - expected "Reason for Customer Contacting Us" to be set to "private_events", got ${JSON.stringify(reason)}. ` +
          `Private-event tickets must be categorised on every path, including the ones that hand off to a human.`
      );
    }
  }
  // --- Spelled-out state names (ticket #29229) ---
  const mollyLabel = "REGRESSION (#29229): 'Westfield indiana' should resolve to Indianapolis, not fall through as unknown";
  const molly = resultsByLabel.get(mollyLabel);
  if (!molly) throw new Error(`ASSERTION FAILED: scenario "${mollyLabel}" did not run`);
  if (!molly.matchedLocation || !/indianapolis/i.test(molly.matchedLocation)) {
    throw new Error(
      `ASSERTION FAILED: #29229 regression - expected the location to resolve to Indianapolis, got ${JSON.stringify(molly.matchedLocation)}. ` +
        `"Westfield indiana" must match the "westfield, in" keyword via the state-name normalisation in src/util.ts.`
    );
  }
  console.log("Regression check passed: spelled-out state names resolve to the right location (#29229).");

  console.log("Regression check passed: every private-event path sets Reason for Customer Contacting Us to Private Events.");

  console.log("Regression check passed: inquiries with an unknown focus or location get a clarifying question instead of a guessed quote, and we never ask twice.");

  // --- Agent replies must not be read as customer replies (#29490) ---
  const agentReplyLabel = "Agent's own reply on an already-quoted ticket should produce nothing";
  const agentReply = resultsByLabel.get(agentReplyLabel);
  if (!agentReply) throw new Error(`ASSERTION FAILED: scenario "${agentReplyLabel}" did not run`);
  if (agentReply.finalAction !== "no_op") {
    throw new Error(
      `ASSERTION FAILED: #29490 regression - expected finalAction "no_op" when the newest comment is the agent's own, got "${agentReply.finalAction}". ` +
        `An agent answering a quoted ticket must not be reported as "the customer replied after the quote".`
    );
  }
  console.log("Regression check passed: an agent's own reply on a quoted ticket produces nothing (#29490).");

  // --- Brand-domain senders must never be auto-quoted (#81443 class) ---
  const wcDomainLabel = "REGRESSION (#81443 class): a message from the brand's own domain must never be auto-quoted";
  const wcDomain = resultsByLabel.get(wcDomainLabel);
  if (!wcDomain) throw new Error(`ASSERTION FAILED: scenario "${wcDomainLabel}" did not run`);
  if (wcDomain.ruleDecision.matchedRule !== "event_booking_question") {
    throw new Error(
      `ASSERTION FAILED: #81443-class regression - scenario did not reach the private-event branch (matched "${wcDomain.ruleDecision.matchedRule}"), so the internal-sender guard was never exercised.`
    );
  }
  if (wcDomain.finalAction === "posted_public_reply") {
    throw new Error(
      `ASSERTION FAILED: #81443-class regression - a message from the brand's own mail domain was auto-quoted.`
    );
  }
  console.log("Regression check passed: mail from the brand's own domain is treated as staff, never auto-quoted (#81443).");

  // --- Clarifier answers keep earlier details; our own question is not an answer (#29509) ---
  const answeredLabel = "REGRESSION (#29509): an answer to the clarifying question must not lose the location from the original form";
  const answered = resultsByLabel.get(answeredLabel);
  if (!answered) throw new Error(`ASSERTION FAILED: scenario "${answeredLabel}" did not run`);
  // matchedLocation is the tell. Before the fix her reply was judged on its
  // own, the location vanished and the ticket was declared still unclear
  // with matchedLocation null. With the fix her form's location is still in
  // view. (finalAction can't be the check here: with
  // PRIVATE_EVENT_QUOTES_LIVE off in this test environment a successful
  // classification is held as an internal note, the same finalAction the
  // still-unclear path produces.)
  if (!answered.matchedLocation) {
    throw new Error(
      `ASSERTION FAILED: #29509 regression - the location from the original form was lost once the customer replied to the clarifying question.`
    );
  }
  if (answered.finalAction === "private_event_clarification_sent") {
    throw new Error(`ASSERTION FAILED: #29509 regression - the customer answered, but we asked again.`);
  }

  const quietLabel = "REGRESSION (#29509): our own clarifying question must not trigger 'still unclear'";
  const quiet = resultsByLabel.get(quietLabel);
  if (!quiet) throw new Error(`ASSERTION FAILED: scenario "${quietLabel}" did not run`);
  if (quiet.finalAction !== "no_op") {
    throw new Error(
      `ASSERTION FAILED: #29509 regression - expected "no_op" when the newest comment is our own clarifying question, got "${quiet.finalAction}".`
    );
  }
  console.log("Regression check passed: a clarifier answer keeps the details already given, and our own question never counts as an answer (#29509).");

  // --- The one guard for the whole conversational half (#29107) ---
  const avyanaLabel = "REGRESSION (#29107): an agent reply on an untagged, already-hand-quoted ticket must not re-quote";
  const avyana = resultsByLabel.get(avyanaLabel);
  if (!avyana) throw new Error(`ASSERTION FAILED: scenario "${avyanaLabel}" did not run`);
  if (avyana.finalAction !== "no_op") {
    throw new Error(
      `ASSERTION FAILED: #29107 regression - expected "no_op" when the newest message is ours, got "${avyana.finalAction}". ` +
        `This is the guard that stops a customer receiving a second copy of a quote when the first was sent by hand.`
    );
  }
  console.log("Regression check passed: nothing conversational acts on a ticket whose newest message is our own (#29107).");

  // --- Quoted email history is not the customer's message (#81500) ---
  const quotedLabel = "REGRESSION (#81500): quoted email history must not be matched as the customer's message";
  const quoted = resultsByLabel.get(quotedLabel);
  if (!quoted) throw new Error(`ASSERTION FAILED: scenario "${quotedLabel}" did not run`);
  if (quoted.ruleDecision.matchedRule === "event_booking_question") {
    throw new Error(
      `ASSERTION FAILED: #81500 regression - a booked customer asking to move her start time matched event_booking_question. ` +
        `The only private-event wording is in the quoted copy of our own email, which is not something she said.`
    );
  }
  if (quoted.finalAction === "private_event_clarification_sent" || quoted.finalAction === "posted_public_reply") {
    throw new Error(
      `ASSERTION FAILED: #81500 regression - expected no private-event reply, got "${quoted.finalAction}".`
    );
  }
  console.log("Regression check passed: quoted email history is not treated as the customer's own message (#81500).");

  // --- The form gate (Christopher, 2026-09-30) ---
  const gateLabel = "GATE: a convincing private-event request that did not come through the form must be held, not sent";
  const gate = resultsByLabel.get(gateLabel);
  if (!gate) throw new Error(`ASSERTION FAILED: scenario "${gateLabel}" did not run`);
  // On this brand a free-form request is stopped one layer earlier -
  // event_booking_question itself requires the contact-form phrase, so it
  // never reaches the private-event branch. Either outcome is correct; what
  // matters is that nothing reached the customer.
  if (gate.finalAction === "posted_public_reply" || gate.finalAction === "private_event_clarification_sent") {
    throw new Error(
      `ASSERTION FAILED: form gate - a non-form request produced "${gate.finalAction}". ` +
        `Nothing reaches a customer automatically unless the ticket began as a form submission.`
    );
  }
  console.log("Regression check passed: only form submissions are answered automatically; free-form email is held for a human.");

  // --- Generic contact-form inquiries (#30357 / #30413, 2026-10-16) ---
  const cfLabel = "REGRESSION (#30357/#30413): a generic contact-form inquiry must be flagged for a human";
  const cf = resultsByLabel.get(cfLabel);
  if (!cf) throw new Error(`ASSERTION FAILED: scenario "${cfLabel}" did not run`);
  if (cf.ruleDecision.matchedRule !== "contact_form_inquiry") {
    throw new Error(
      `ASSERTION FAILED: a contact-form inquiry matched "${cf.ruleDecision.matchedRule}" instead of ` +
        `contact_form_inquiry. general_faq matches the bare word "location", which is a field label on ` +
        `every one of these forms, and swallows them with no reply and no needs_human.`
    );
  }
  if (!(cf.ruleDecision.addTags ?? []).includes("needs_human")) {
    throw new Error(`ASSERTION FAILED: a contact-form inquiry must be tagged needs_human.`);
  }
  console.log("Regression check passed: generic contact-form inquiries are flagged for a human, not silently FAQ-tagged (#30357, #30413).");


  // --- Below the group minimum (#30268, 2026-10-12) ---
  const smallLabel = "REGRESSION (#30268): a party under the group minimum gets public classes, not a quote";
  const small = resultsByLabel.get(smallLabel);
  if (!small) throw new Error(`ASSERTION FAILED: scenario "${smallLabel}" did not run`);
  if (small.finalAction !== "private_event_below_minimum") {
    throw new Error(
      `ASSERTION FAILED: #30268 regression - a 2-guest request produced "${small.finalAction}". ` +
        `A party under the minimum is pointed at public classes, never quoted.`
    );
  }
  const bigLabel = "CONTROL (#30268): a party at or above the minimum still gets the normal quote";
  const big = resultsByLabel.get(bigLabel);
  if (!big) throw new Error(`ASSERTION FAILED: scenario "${bigLabel}" did not run`);
  if (big.finalAction === "private_event_below_minimum") {
    throw new Error(
      `ASSERTION FAILED: #30268 control - a 20-guest request was treated as below the minimum.`
    );
  }
  console.log("Regression check passed: parties under the group minimum get public classes, not a quote (#30268).");


  // --- Outbound threads (WC #30265, 2026-10-12) ---
  const outboundLabel = "REGRESSION (#30265): a thread WE started must never be auto-answered";
  const outbound = resultsByLabel.get(outboundLabel);
  if (!outbound) throw new Error(`ASSERTION FAILED: scenario "${outboundLabel}" did not run`);
  if (outbound.finalAction === "posted_public_reply" || outbound.finalAction === "private_event_clarification_sent") {
    throw new Error(
      `ASSERTION FAILED: #30265 regression - a ticket whose first comment is OURS produced "${outbound.finalAction}". ` +
        `An outbound thread is never an inbound inquiry, however much private-event vocabulary the reply contains.`
    );
  }
  console.log("Regression check passed: a thread we started is never auto-answered (#30265).");


  console.log("Regression check passed: staff/licensee misfires (#29225, #29206) are no longer auto-quoted, and genuine inquiries (#29199-style) still are.");
}

main().catch((err) => {
  console.error("test-local failed:", err);
  process.exit(1);
});
