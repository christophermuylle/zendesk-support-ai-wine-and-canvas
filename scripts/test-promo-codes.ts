// Regression test for src/promo-codes.ts range building.
//
// The bug this exists to prevent: the sheet name was hardcoded to "Sheet1"
// (overridable only by an env var nobody remembered to set). All three of
// this brand's code sheets do have tabs named "Sheet1", so Wine & Canvas was
// never bitten - but Painting and Vino's sheet has its tab named "Painting
// and Vino Codes", so every request there asked Google for `Sheet1!A:A`, got
// back 400 "Unable to parse range", threw out of claimNextCode, and -
// because the sweep catches per-ticket errors into result.errors and writes
// nothing to the ticket - email 3 silently stopped going out after
// 2026-10-12. Five PV customers never got it. One rename of any of these
// three tabs would have done the same here.
//
// claimNextCode now asks each spreadsheet what its tabs are called, so these
// tests drive it through a stubbed fetch and assert on the URLs it builds.
//
// Usage: npm run test:promo

import crypto from "node:crypto";
import { loadPromoCodeConfig, claimNextCode, type PromoPool } from "../src/promo-codes.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}`);
  }
}

// A throwaway RSA key so the real JWT signing path runs (not stubbed) -
// getAccessToken calls crypto.sign before it ever reaches fetch.
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

interface Captured {
  url: string;
  method: string;
  body?: string;
}

let stubRun = 0;

/**
 * Points all three pools at their own per-run spreadsheet ids (so the
 * module's tab-name cache, keyed by spreadsheet id, can't answer one
 * scenario out of another's), then installs a fetch stub that answers the
 * OAuth call, reports `tabName` as each spreadsheet's only tab, returns
 * `codes` from column A, and accepts the write.
 */
function stubGoogle(tabName: string, codes: string[]): Captured[] {
  stubRun += 1;
  process.env.GOOGLE_SHEETS_PROMO_SPREADSHEET_ID_INDIANAPOLIS = `stub-in-${stubRun}`;
  process.env.GOOGLE_SHEETS_PROMO_SPREADSHEET_ID_MICHIGAN = `stub-mi-${stubRun}`;
  process.env.GOOGLE_SHEETS_PROMO_SPREADSHEET_ID_FLORIDA = `stub-fl-${stubRun}`;

  const seen: Captured[] = [];
  (globalThis as { fetch: unknown }).fetch = async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({ url, method: init.method ?? "GET", body: init.body as string | undefined });
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return json({ access_token: "stub-token", expires_in: 3600 });
    }
    if (url.includes("fields=sheets.properties.title")) {
      return json({ sheets: [{ properties: { title: tabName } }] });
    }
    if (url.includes("/values/") && (init.method ?? "GET") === "GET") {
      return json({ values: codes.map((c) => [c]) });
    }
    if (url.includes("/values/") && init.method === "PUT") {
      return json({ updatedCells: codes.length });
    }
    return new Response("unexpected request", { status: 500 });
  };
  return seen;
}

const POOLS: PromoPool[] = ["indianapolis", "michigan", "florida"];

async function main(): Promise<void> {
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "stub@example.iam.gserviceaccount.com";
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = privateKey.replace(/\n/g, "\\n");
  delete process.env.GOOGLE_SHEETS_PROMO_SHEET_NAME;

  const realFetch = globalThis.fetch;
  try {
    // --- 1. How these three sheets are set up today: tab really is "Sheet1". ---
    console.log('\nTab named "Sheet1" (how all three Wine & Canvas sheets are set up):');
    const seen1 = stubGoogle("Sheet1", ["codeA", "codeB", "codeC"]);
    const cfg1 = loadPromoCodeConfig();
    assert(cfg1 !== null, "config loads when the service-account env vars are set");
    for (const pool of POOLS) {
      const claimed = await claimNextCode(cfg1!, pool);
      assert(claimed === "codeA", `${pool}: claims the first code in the column`);
    }
    assert(
      seen1.filter((c) => c.url.includes("/values/")).every((c) => c.url.includes("Sheet1!")),
      'resolves to Sheet1 without needing GOOGLE_SHEETS_PROMO_SHEET_NAME set'
    );
    assert(
      new Set(seen1.filter((c) => c.url.includes("/values/")).map((c) => c.url.split("/values/")[0])).size === 3,
      "each pool reads and writes its own spreadsheet"
    );
    const write1 = seen1.find((c) => c.method === "PUT");
    assert(
      JSON.parse(write1!.body!).values.map((r: string[]) => r[0]).join(",") === "codeB,codeC,",
      "writes the remaining codes back, blank-padding the vacated last cell"
    );

    // --- 2. If anyone renames a tab, it must keep working. ---
    console.log('\nTab renamed to "Indianapolis Codes" (the PV failure mode, applied here):');
    const seen2 = stubGoogle("Indianapolis Codes", ["only"]);
    const claimed2 = await claimNextCode(loadPromoCodeConfig()!, "indianapolis");
    assert(claimed2 === "only", "a renamed tab no longer breaks the claim");
    const valueCalls2 = seen2.filter((c) => c.url.includes("/values/"));
    assert(
      valueCalls2.every((c) => c.url.includes(encodeURIComponent("Indianapolis Codes!"))),
      "every range names the sheet's real tab, not a guess"
    );
    assert(
      !valueCalls2.some((c) => c.url.includes("Sheet1")),
      'no request asks for "Sheet1" - this is the 400 "Unable to parse range" that silently killed PV email 3'
    );
    assert(
      valueCalls2.find((c) => c.method === "PUT")?.body?.includes('"Indianapolis Codes!A1:A1"') === true,
      "the PUT body's range field names the real tab too (Sheets rejects a mismatch)"
    );

    // --- 3. An empty pool is null, not a throw - followups.ts tags for a human. ---
    console.log("\nEmpty pool:");
    stubGoogle("Sheet1", []);
    const claimed3 = await claimNextCode(loadPromoCodeConfig()!, "florida");
    assert(claimed3 === null, "an empty column returns null rather than throwing");

    // --- 4. A stale env override must not reintroduce a bad range. ---
    console.log("\nGOOGLE_SHEETS_PROMO_SHEET_NAME set to a tab that does not exist:");
    process.env.GOOGLE_SHEETS_PROMO_SHEET_NAME = "Codes";
    const seen4 = stubGoogle("Sheet1", ["x"]);
    const claimed4 = await claimNextCode(loadPromoCodeConfig()!, "michigan");
    assert(claimed4 === "x", "a wrong env override no longer breaks the claim");
    assert(
      !seen4.some((c) => c.url.includes("/values/") && c.url.includes("Codes")),
      "falls back to the sheet's real tab and warns, instead of sending a range Google will reject"
    );
    delete process.env.GOOGLE_SHEETS_PROMO_SHEET_NAME;
  } finally {
    globalThis.fetch = realFetch;
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
