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
import { FOLLOW_UP_1_SENT_TAG, FOLLOW_UP_2_SENT_TAG, FOLLOW_UP_3_SENT_TAG } from "../src/config.js";
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
  readonly renamedUsers: Array<{ userId: number; name: string }> = [];
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
  // The digest is exercised by its own preview endpoint against real
  // Zendesk data, not by this per-scenario harness.
  async searchTickets(): Promise<never[]> {
    return [];
  }
  async createTicket(): Promise<number> {
    throw new Error("createTicket is not expected in this test");
  }
  async updateUserName(userId: number, name: string): Promise<void> {
    this.renamedUsers.push({ userId, name });
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

  // 8: PV #81571 (Beverly Bumgarner). Quoted 120h ago, the customer has
  // replied since, and the pipeline stamped private_event_reply_after_quote
  // at the time - but a human set the ticket back to PENDING (which is also
  // what Zendesk does whenever an agent answers a customer), so it is back
  // in the sweep's candidate set. Before 2026-10-08 nothing in followups.ts
  // read that tag and she got follow-up 1 asking whether the quote she had
  // already replied to four times had reached her. Must send nothing.
  const t8 = makeTicket(8, 120, ["private_event_quote_sent_corporate", "private_event_reply_after_quote"], "Replied But Pending");
  t8.comments.push(comment("Yes we want to book, what do I do next?", CUSTOMER_ID, 119));
  t8.comments.push(comment("Let me check with our artist and get back to you.", AGENT_ID, 110));
  store.set(8, t8);

  // 30265: WC #30265 (2026-10-12). Raimey emailed the Orlando licensee "are you
  // available?" and stacked the Artist Available macro on top of the Standard
  // ORL quote macro, so the ticket carried private_event_quote_sent and status
  // pending even though no quote was ever sent to anyone. 24h later this sweep
  // emailed the licensee "following up on the painting party quote I sent
  // yesterday." The tell is the FIRST comment: it is ours, not the requester's.
  const tOutbound = makeTicket(30265, 30, ["private_event_quote_sent_standard", "private_event_location_orlando"], "Licensee Outbound");
  tOutbound.comments = [
    comment("We have a new party booking! Let me know if you are available.", AGENT_ID, 30),
    comment("Yes I can cover that date.", CUSTOMER_ID, 26),
  ];
  store.set(30265, tOutbound);

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
  assert(
    sentStages(30265).length === 0,
    "ticket 30265 (outbound thread we started) should get nothing"
  );
  assert(
    sentStages(8).length === 0,
    "ticket 8 (replied after quote, tagged, back on pending) should get nothing"
  );
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

  // --- Bloomington has no promo sheet yet (2026-10-26) ---
  // Every stage-3 check above stops at the "promo codes aren't configured"
  // guard, because this harness sets no Google credentials - so none of them
  // can reach the per-market pool lookup. This runs a second, isolated sweep
  // with the two credential env vars set (loadPromoCodeConfig only reads env;
  // no network is touched, because the pool guard returns before
  // claimNextCode is ever called) so the Bloomington path is actually
  // exercised.
  //
  // Christopher, 2026-10-26: "I will add $10 off promo codes soon as well."
  // Until his sheet exists, Bloomington's pool is null, and email 3 must tag
  // for a human rather than hand out an Indianapolis code that may be scoped
  // to the Indianapolis subsite and would not redeem.
  {
    const bloomStore = new Map<number, StoredTicket>();
    const bt = makeTicket(9100, 130, ["private_event_quote_sent_standard", "private_event_location_bloomington"], "Blair Bloomington");
    bt.ticket.tags.push(FOLLOW_UP_1_SENT_TAG, FOLLOW_UP_2_SENT_TAG);
    bloomStore.set(9100, bt);
    // A market that DOES have a sheet, as the control - it must get past the
    // pool guard and fail later instead (no network here, so it throws and
    // takes the throw path), proving the guard is Bloomington-specific.
    const ct = makeTicket(9101, 130, ["private_event_quote_sent_standard", "private_event_location_indianapolis"], "Casey Control");
    ct.ticket.tags.push(FOLLOW_UP_1_SENT_TAG, FOLLOW_UP_2_SENT_TAG);
    bloomStore.set(9101, ct);

    const prevEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const prevKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "stub@example.iam.gserviceaccount.com";
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = "stub-key-never-used-the-pool-guard-returns-first";
    // Both the pool guard and the later throw path tag the same two tags, so
    // the tags alone cannot tell them apart. Capture the log line to pin WHICH
    // path ran - otherwise mapping Bloomington back to the Indianapolis sheet
    // would still pass every assertion below.
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    let bloomResult;
    try {
      bloomResult = await runFollowUpSweep({ zendesk: new InMemoryZendesk(bloomStore) });
    } finally {
      console.error = realError;
      if (prevEmail === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      else process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = prevEmail;
      if (prevKey === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
      else process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = prevKey;
    }

    for (const line of logged) realError(line);
    const bloomLog = logged.find((l) => l.includes("ticket 9100"));
    assert(
      bloomLog !== undefined && bloomLog.includes("has no promo code sheet yet"),
      `Bloomington stage 3 must stop at the "no promo code sheet yet" guard, not fall through to a Sheets call. ` +
        `Its log line was: ${JSON.stringify(bloomLog ?? "(none)")}. If it mentions a sheet THROWING, Bloomington ` +
        `is mapped to another market's pool again.`
    );
    const controlLog = logged.find((l) => l.includes("ticket 9101"));
    assert(
      controlLog !== undefined && !controlLog.includes("has no promo code sheet yet"),
      `The Indianapolis control must get PAST the pool guard - it has a sheet. Its log line was: ` +
        `${JSON.stringify(controlLog ?? "(none)")}.`
    );
    const bloomTags = bloomStore.get(9100)!.ticket.tags;
    assert(
      bloomResult.sent.filter((x) => x.ticketId === 9100).length === 0,
      "Bloomington stage 3 must NOT send while it has no promo code sheet - an Indianapolis code may be scoped to that subsite and would not redeem"
    );
    assert(
      bloomTags.includes("needs_human") && bloomTags.includes(`${FOLLOW_UP_3_SENT_TAG}_needs_manual_code`),
      `Bloomington stage 3 must tag needs_human + ${FOLLOW_UP_3_SENT_TAG}_needs_manual_code so it is visible; tags were [${bloomTags.join(", ")}]`
    );
    assert(
      !bloomTags.includes(FOLLOW_UP_3_SENT_TAG),
      "Bloomington must NOT be marked as having had email 3 sent - the sequence has to resume once the codes exist"
    );
    assert(
      bloomStore.get(9100)!.ticket.status === "pending",
      "Bloomington stage 3 must leave the ticket pending"
    );
    assert(
      bloomResult.sent.filter((x) => x.ticketId === 9101).length === 0,
      "the Indianapolis control must not send here either (no network in this harness)"
    );
    console.log("Assertion passed: Bloomington stage 3 tags for a human instead of sending another market's promo code.");
  }

  console.log("\nAll assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
