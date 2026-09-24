// Exercises the follow-up poller's state machine (src/followups.ts)
// directly - stage progression, the 24h/72h/120h thresholds, idempotency
// (never re-sending a stage), the Corporate vs Standard email 2 branch,
// and the "promo codes not configured yet" fallback for stage 3. Mirrors
// Painting and Vino's scripts/test-followups.ts, adapted for this brand's
// finer-grained 9-location private-event system and its own tag/category
// naming ("kids" not "kiddos", location tags like
// "private_event_location_naples"/"private_event_location_cadillac"
// instead of a coarse city slug). This is a different code path from
// scripts/test-local.ts (which exercises processTicket per-ticket, not the
// periodic sweep), so it gets its own mock Zendesk client with a real
// in-memory ticket store and searchTicketIds.
//
// Usage: npm run test:followups

import { runFollowUpSweep } from "../src/followups.js";
import type { IZendeskClient } from "../src/zendesk.js";
import type { ActionType, TicketContext, ZendeskComment, ZendeskTicket } from "../src/types.js";

const AGENT_ID = 999; // the Zendesk agent/bot account that posts our replies
const CUSTOMER_ID = 1001;

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function comment(body: string, authorId: number, hoursAgoVal: number, isPublic = true): ZendeskComment {
  return { id: Math.floor(Math.random() * 1e6), author_id: authorId, body, public: isPublic, created_at: hoursAgo(hoursAgoVal) };
}

interface StoredTicket {
  ticket: ZendeskTicket;
  requester: { id: number; name: string; email: string };
  comments: ZendeskComment[];
}

class InMemoryZendesk implements IZendeskClient {
  constructor(private store: Map<number, StoredTicket>) {}

  async getTicketContext(ticketId: number): Promise<TicketContext> {
    const t = this.store.get(ticketId);
    if (!t) throw new Error(`unknown ticket ${ticketId}`);
    return { ticket: t.ticket, requester: t.requester, comments: t.comments, brand: "wine_and_canvas" };
  }

  async postComment(
    ticketId: number,
    body: string,
    opts: { isPublic: boolean; status?: ActionType; addTags?: string[]; fields?: Array<{ id: number; value: string | null }>; htmlBody?: string; uploadTokens?: string[] }
  ): Promise<void> {
    const t = this.store.get(ticketId)!;
    const statusMap: Record<string, ZendeskTicket["status"]> = { solve: "solved", pending: "pending", escalate: "open" };
    if (opts.status && statusMap[opts.status]) t.ticket.status = statusMap[opts.status];
    if (opts.addTags?.length) t.ticket.tags = [...new Set([...t.ticket.tags, ...opts.addTags])];
    t.comments.push(comment(opts.htmlBody ?? body, AGENT_ID, 0, opts.isPublic));
    console.log(
      `  [ticket ${ticketId}] postComment public=${opts.isPublic} status=${opts.status ?? "unchanged"} tags+=${opts.addTags?.join(",") ?? "-"}`
    );
    console.log(`    body: ${(opts.htmlBody ?? body).slice(0, 160).replace(/\n/g, " ")}...`);
  }

  async updateTicket(
    ticketId: number,
    opts: { status?: string; addTags?: string[]; fields?: Array<{ id: number; value: string | null }> }
  ): Promise<void> {
    const t = this.store.get(ticketId)!;
    if (opts.addTags?.length) t.ticket.tags = [...new Set([...t.ticket.tags, ...opts.addTags])];
    console.log(`  [ticket ${ticketId}] updateTicket tags+=${opts.addTags?.join(",") ?? "-"}`);
  }

  async uploadFile(filename: string, _contentType: string, data: Buffer): Promise<{ token: string; contentUrl: string }> {
    return { token: `mock-${filename}`, contentUrl: `https://mock.zendesk.com/${filename}` };
  }

  async searchTicketIds(query: string): Promise<number[]> {
    // Mirrors the real query shape (status:pending tags:private_event_quote_sent)
    // closely enough for this test: just return every pending ticket tagged
    // private_event_quote_sent, same as the real Zendesk search would.
    return [...this.store.values()]
      .filter((t) => t.ticket.status === "pending" && t.ticket.tags.includes("private_event_quote_sent"))
      .map((t) => t.ticket.id);
  }
}

function makeTicket(
  id: number,
  quoteAgeHours: number,
  extraTags: string[] = [],
  requesterName = "Test Customer"
): StoredTicket {
  return {
    ticket: {
      id,
      subject: "Private event quote",
      description: "...",
      status: "pending",
      requester_id: CUSTOMER_ID,
      tags: ["booking_question", "private_event_quote_sent", ...extraTags],
      created_at: hoursAgo(quoteAgeHours + 1),
      updated_at: hoursAgo(0),
    },
    requester: { id: CUSTOMER_ID, name: requesterName, email: "test@example.com" },
    comments: [
      comment("Hi, I'd like a quote for a private event.", CUSTOMER_ID, quoteAgeHours + 1),
      comment("Here's your quote...", AGENT_ID, quoteAgeHours), // the "quote sent" anchor
    ],
  };
}

async function main() {
  const store = new Map<number, StoredTicket>();

  // 1: quote sent 30h ago, no follow-up yet -> due for stage 1 (>24h). Indianapolis.
  store.set(1, makeTicket(1, 30, ["private_event_quote_sent_standard", "private_event_location_indianapolis"], "Priya Stage1"));
  // 2: quote sent 10h ago -> NOT due for stage 1 yet (<24h).
  store.set(2, makeTicket(2, 10, ["private_event_quote_sent_standard", "private_event_location_tampa"], "Jamie TooSoon"));
  // 3: quote sent 80h ago, stage 1 already sent -> due for stage 2 Corporate. Grand Rapids.
  const t3 = makeTicket(3, 80, ["private_event_quote_sent_corporate", "private_event_location_grand-rapids"], "Sam Corporate");
  t3.ticket.tags.push("private_event_followup_1_sent");
  store.set(3, t3);
  // 4: quote sent 130h ago, stage 2 already sent -> due for stage 3 (needs promo code - none configured in this test env). Naples.
  const t4 = makeTicket(4, 130, ["private_event_quote_sent_standard", "private_event_location_naples"], "Robin Stage3");
  t4.ticket.tags.push("private_event_followup_1_sent", "private_event_followup_2_sent");
  store.set(4, t4);
  // 5: all three stages already sent -> should be skipped entirely (no re-send).
  const t5 = makeTicket(5, 200, ["private_event_quote_sent_standard", "private_event_location_orlando"], "Done Already");
  t5.ticket.tags.push("private_event_followup_1_sent", "private_event_followup_2_sent", "private_event_followup_3_sent");
  store.set(5, t5);
  // 6: quote sent 30h ago but customer already replied (status back to "open") -> should be skipped.
  const t6 = makeTicket(6, 30, ["private_event_quote_sent_standard", "private_event_location_miami"], "Replied Already");
  t6.ticket.status = "open";
  store.set(6, t6);
  // 7: quote sent 130h ago, stage 2 already sent, kids category -> due for stage 3, Cadillac (no calendar link on file - tests the phone/email fallback line, not just the "no promo config" path). Still won't auto-send here (no promo config in this test env), but exercises the location-key lookup for a no-link location before that fallback fires.
  const t7 = makeTicket(7, 130, ["private_event_quote_sent_kids", "private_event_location_cadillac"], "Casey Cadillac");
  t7.ticket.tags.push("private_event_followup_1_sent", "private_event_followup_2_sent");
  store.set(7, t7);

  // 20: the #29001 / #29107 shape. Quoted 150h ago so ALL THREE stage
  // thresholds are already past, but we sent something on this ticket only
  // 1h ago. Must send nothing - before the 2026-09-24 fix this is exactly
  // how a customer got the quote plus all three follow-ups inside half an
  // hour (one per sweep tick, and every redeploy triggered an extra tick).
  const t20 = makeTicket(20, 150, ["private_event_quote_sent_standard", "private_event_location_indianapolis"], "Stale Anchor");
  t20.comments.push(comment("Automated follow-up we sent an hour ago...", AGENT_ID, 1));
  t20.ticket.tags.push("private_event_followup_1_sent");
  store.set(20, t20);

  const zendesk = new InMemoryZendesk(store);
  console.log("Running follow-up sweep against 7 mock tickets...\n");
  const result = await runFollowUpSweep({ zendesk });

  console.log(`\nSweep result: checked=${result.checked} sent=${result.sent.length} errors=${result.errors.length}`);
  console.log("Sent:", JSON.stringify(result.sent));
  console.log("Errors:", JSON.stringify(result.errors));

  console.log("\nFinal ticket states:");
  for (const [id, t] of store) {
    console.log(`  ticket ${id} (${t.requester.name}): status=${t.ticket.status} tags=[${t.ticket.tags.join(", ")}]`);
  }

  // --- Sanity checks (throws on failure, matching this repo's "visually
  // inspect + assert the important invariants" test style) ---
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  };
  const sentStages = (id: number) => result.sent.filter((s) => s.ticketId === id).map((s) => s.stage);

  assert(sentStages(1).length === 1 && sentStages(1)[0] === 1, "ticket 1 should get exactly stage 1");
  assert(sentStages(2).length === 0, "ticket 2 (10h old) should get nothing yet");
  assert(sentStages(3).length === 1 && sentStages(3)[0] === 2, "ticket 3 should get exactly stage 2 (corporate)");
  assert(store.get(3)!.ticket.status === "pending", "ticket 3 should stay pending after stage 2 (not solved)");
  assert(sentStages(4).length === 0, "ticket 4 (stage 3 due, no promo config) should NOT auto-send - falls back to needs_human");
  assert(store.get(4)!.ticket.tags.includes("needs_human"), "ticket 4 should be tagged needs_human when promo codes aren't configured");
  assert(sentStages(5).length === 0, "ticket 5 (all stages already sent) should get nothing - no re-send");
  assert(sentStages(6).length === 0, "ticket 6 (customer already replied, status=open) should get nothing");
  assert(sentStages(7).length === 0, "ticket 7 (Cadillac, stage 3 due, no promo config) should NOT auto-send either");
  assert(store.get(7)!.ticket.tags.includes("needs_human"), "ticket 7 (Cadillac) should also fall back to needs_human, same as any other location, when promo codes aren't configured");

  assert(
    store.get(5)!.ticket.status === "pending",
    "ticket 5 (all three follow-ups already sent) should REST in pending, not solved - the stage-3 tag ends the sequence, not the status (Christopher, 2026-09-24)"
  );

  // Blanket invariant: this sweep must never leave a private-event ticket
  // Solved. Christopher, 2026-09-24: "You should never close Private Event
  // tickets as closed. Only pending. Let the human solve and close them."
  // Email 3 used to Solve the ticket, which is how a batch of private-event
  // tickets ended up Solved without a human ever seeing them.
  for (const [id, t] of store) {
    assert(
      t.ticket.status !== "solved",
      `ticket ${id} was left Solved by the follow-up sweep - private-event tickets must stay Pending for a human to solve and close`
    );
  }

  assert(
    sentStages(20).length === 0,
    "ticket 20 (anchor 150h old, but we emailed it 1h ago) must get NOTHING - the 24h minimum gap stops the whole sequence firing in one afternoon (tickets #29001/#29107, 2026-09-24)"
  );

  console.log("\nAll assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
