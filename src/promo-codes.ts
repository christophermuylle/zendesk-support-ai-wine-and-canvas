// Minimal Google Sheets client for the private-event follow-up promo code
// pools (email 3 of the 24h/72h/120h no-response sequence - see
// src/followups.ts). Deliberately implemented with plain `fetch` + a
// hand-signed service-account JWT rather than pulling in the full
// `googleapis` package, matching this codebase's existing style
// (src/zendesk.ts and src/ai.ts are both thin fetch-based clients, no heavy
// SDKs beyond the Anthropic one this project's whole purpose needs). Mirrors
// Painting and Vino's src/promo-codes.ts, extended to THREE separate pools
// instead of one - Wine and Canvas splits its private-event markets across
// three regional $10-off code sheets rather than a single shared pool.
//
// SOURCE OF TRUTH: three Google Sheets Christopher shared 2026-09-22, one
// per region - codes live one per row starting at cell A1, no header row
// in any of them:
//   - "Indianapolis $10 One Time Codes" (81 codes at handoff) - Indianapolis
//     only.
//   - "Michigan $10 One Time Codes" (93 codes at handoff) - Grand Rapids and
//     Cadillac (the only two Michigan markets this brand answers private-
//     event requests for; Kalamazoo and Lansing are out of scope entirely,
//     see rules.yaml's out_of_scope_location rule).
//   - "florida $10 One Time Codes" (95 codes at handoff) - Tampa, Orlando,
//     Fort Myers, Fort Lauderdale, Naples, and Miami all share this one
//     pool (matches how src/private-event-quotes.ts groups their pricing
//     tiers too).
// Which pool a given PrivateEventLocationKey draws from is
// PRIVATE_EVENT_LOCATION_PROMO_POOL in src/followup-templates.ts, not here -
// this file only knows how to read/claim from a named pool's sheet.
//
// Claiming a code deletes it from its sheet (by rewriting the column with
// that row removed), so each sheet is always the live, authoritative
// remaining pool for its region - anyone can see exactly what's left just
// by opening it, and a code Bonnie hands out manually by editing a sheet
// directly is automatically respected (this code always reads current
// sheet state, never caches any pool).
//
// SETUP REQUIRED before this can actually run (Christopher, not something
// Claude can do without Google Cloud Console access - the service account
// pv-promo-code-sheets@wine-and-canvas-event-map.iam.gserviceaccount.com
// already has Editor access on all three sheets as of 2026-09-22, same
// account already used for Painting and Vino's single pool):
//   Set two env vars on the live server: GOOGLE_SERVICE_ACCOUNT_EMAIL (the
//   service account's email) and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (the
//   `private_key` field from its downloaded JSON key, with literal `\n`
//   sequences preserved - this file unescapes them at load time, see
//   loadPromoCodeConfig below). Shared across both this project and
//   Painting and Vino's - same credentials, different spreadsheets.
// Until those are set, claimNextCode() returns null and followups.ts logs
// a clear error + tags the ticket for a human to send email 3 by hand
// rather than crashing the poller.

import crypto from "node:crypto";

export type PromoPool = "indianapolis" | "michigan" | "florida";

export interface PromoCodeConfig {
  serviceAccountEmail: string;
  privateKey: string;
  spreadsheetIds: Record<PromoPool, string>;
  sheetName: string;
}

/** Returns null (not throws) if the required env vars aren't set yet - see the setup note above. */
export function loadPromoCodeConfig(): PromoCodeConfig | null {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawPrivateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!serviceAccountEmail || !rawPrivateKey) return null;
  return {
    serviceAccountEmail,
    // Env vars can't hold real newlines cleanly - the downloaded JSON key's
    // private_key has embedded `\n`, which becomes the literal two
    // characters `\` and `n` once pasted into most .env / host env-var
    // UIs. Unescape them back into real newlines, which is what the RSA
    // PEM parser needs.
    privateKey: rawPrivateKey.replace(/\\n/g, "\n"),
    // Confirmed sheets, shared by Christopher 2026-09-22 - each
    // overridable via env in case a pool ever moves to a different sheet.
    spreadsheetIds: {
      indianapolis: process.env.GOOGLE_SHEETS_PROMO_SPREADSHEET_ID_INDIANAPOLIS ?? "1Sj9Mm3C4BKEYbft69ygLfcTx3cRKMHW8XU7q3SPp2GY",
      michigan: process.env.GOOGLE_SHEETS_PROMO_SPREADSHEET_ID_MICHIGAN ?? "1sAoFqW3zZG3BnH04HrZCBkMB0PpAhexK4QaHR_DYujk",
      florida: process.env.GOOGLE_SHEETS_PROMO_SPREADSHEET_ID_FLORIDA ?? "16IYHyUBYLIIedJNYG3csETiiVWL9vv_Z44QF7R-Pb3k",
    },
    sheetName: process.env.GOOGLE_SHEETS_PROMO_SHEET_NAME ?? "Sheet1",
  };
}

interface CachedToken {
  token: string;
  expiresAt: number; // unix seconds
}

let cachedToken: CachedToken | null = null;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

async function getAccessToken(cfg: PromoCodeConfig): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > nowSec + 60) return cachedToken.token;

  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: cfg.serviceAccountEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), cfg.privateKey);
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google OAuth token request failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: nowSec + data.expires_in };
  return data.access_token;
}

async function sheetsRequest<T>(cfg: PromoCodeConfig, spreadsheetId: string, path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken(cfg);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Google Sheets API ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as T;
}

/** Reads one pool's current codes (column A, no header row), top to bottom, blanks filtered out. */
async function readCodes(cfg: PromoCodeConfig, pool: PromoPool): Promise<string[]> {
  const spreadsheetId = cfg.spreadsheetIds[pool];
  const range = encodeURIComponent(`${cfg.sheetName}!A:A`);
  const data = await sheetsRequest<{ values?: string[][] }>(cfg, spreadsheetId, `/values/${range}`);
  return (data.values ?? []).map((row) => row[0]?.trim()).filter((v): v is string => Boolean(v));
}

/**
 * Claims (removes) the next unused code from the given region's pool and
 * returns it, or null if that pool is empty. Rewrites the whole column
 * rather than using a batchUpdate deleteDimension call, since that needs
 * the sheet's numeric gid and this is simpler and plenty fast for an
 * ~80-100 row pool: read everything, drop the first code, write the
 * remainder back starting at A1, and blank the one now-unused trailing
 * cell so no stale value is left behind.
 */
export async function claimNextCode(cfg: PromoCodeConfig, pool: PromoPool): Promise<string | null> {
  const codes = await readCodes(cfg, pool);
  if (codes.length === 0) return null;

  const spreadsheetId = cfg.spreadsheetIds[pool];
  const [claimed, ...remaining] = codes;
  const range = encodeURIComponent(`${cfg.sheetName}!A1:A${codes.length}`);
  const values = [...remaining.map((c) => [c]), [""]]; // pad with one blank row to overwrite the old last cell
  await sheetsRequest(cfg, spreadsheetId, `/values/${range}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ range: `${cfg.sheetName}!A1:A${codes.length}`, majorDimension: "ROWS", values }),
  });
  return claimed;
}

/** How many codes are left in one region's pool - used for logging; a low-stock alert to Christopher is a separate Cowork scheduled task that reads these same sheets directly (see the one already set up for Painting and Vino's single pool - worth cloning for these three once this goes live). */
export async function getRemainingCount(cfg: PromoCodeConfig, pool: PromoPool): Promise<number> {
  return (await readCodes(cfg, pool)).length;
}
