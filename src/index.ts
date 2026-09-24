import crypto from "node:crypto";
import express from "express";
import { env, loadSharedKnowledgeBase, loadLocationSnippet, RULES_PATH, LOCATIONS_PATH } from "./config.js";
import { ZendeskClient } from "./zendesk.js";
import { RulesEngine } from "./rules.js";
import { LocationResolver } from "./locations.js";
import { AiDrafter } from "./ai.js";
import { processTicket } from "./pipeline.js";
import { runFollowUpSweep } from "./followups.js";

const zendesk = new ZendeskClient({
  subdomain: env.zendesk.subdomain,
  email: env.zendesk.email,
  apiToken: env.zendesk.apiToken,
  brand: env.brand,
});
const rules = new RulesEngine(RULES_PATH);
const locations = new LocationResolver(LOCATIONS_PATH);
const ai = new AiDrafter(env.ai);
// Loaded once at startup. Restart the process (or redeploy) after editing
// config/knowledge-base/** or config/locations.yaml so changes take effect.
const sharedKnowledgeBase = loadSharedKnowledgeBase();

const app = express();

// Keep the raw body around so we can verify Zendesk's HMAC signature - see
// README "Securing the webhook" section for how to get the signing secret.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody: Buffer }).rawBody = buf;
    },
  })
);

function verifyZendeskSignature(req: express.Request): boolean {
  if (!env.webhookSecret) return true; // signature check disabled - not recommended for production
  const signature = req.header("x-zendesk-webhook-signature");
  const timestamp = req.header("x-zendesk-webhook-signature-timestamp");
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
  if (!signature || !timestamp || !rawBody) return false;

  const hmac = crypto.createHmac("sha256", env.webhookSecret);
  hmac.update(timestamp + rawBody.toString("utf-8"));
  const expected = hmac.digest("base64");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false; // length mismatch etc.
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, mode: env.mode, brand: env.brand });
});

// Zendesk trigger -> webhook posts here whenever a ticket is created/updated
// with a public comment from the end user. Configure the trigger to send
// JSON body: { "ticket_id": "{{ticket.id}}" }
app.post("/webhooks/zendesk/ticket-updated", async (req, res) => {
  if (!verifyZendeskSignature(req)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const ticketId = Number(req.body?.ticket_id);
  if (!ticketId || Number.isNaN(ticketId)) {
    return res.status(400).json({ error: "missing or invalid ticket_id" });
  }

  // Respond immediately so Zendesk doesn't time out / retry; do the actual
  // work async. Errors are logged - wire this into your own alerting.
  res.status(202).json({ accepted: true, ticketId });

  try {
    const result = await processTicket(
      { zendesk, rules, locations, ai, sharedKnowledgeBase, loadLocationSnippet, mode: env.mode },
      ticketId
    );
    console.log(
      `[ticket ${ticketId}] rule=${result.ruleDecision.matchedRule} location=${result.matchedLocation ?? "none"} action=${result.finalAction} mode=${result.mode}`
    );
  } catch (err) {
    console.error(`[ticket ${ticketId}] pipeline failed:`, err);
  }
});

// Manual trigger for the private-event follow-up sweep (24h/72h/120h
// no-response emails - see src/followups.ts) - useful for testing without
// waiting for the interval below.
app.post("/internal/run-follow-up-sweep", async (_req, res) => {
  try {
    const result = await runFollowUpSweep({ zendesk });
    console.log(
      `[followups] manual sweep: checked=${result.checked} sent=${result.sent.length} errors=${result.errors.length}`
    );
    res.json(result);
  } catch (err) {
    console.error("[followups] manual sweep failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.listen(env.port, () => {
  console.log(`Zendesk support AI listening on port ${env.port} (mode=${env.mode}, brand=${env.brand})`);
});

// Private event follow-up poller (src/followups.ts) - runs every 30
// minutes, independent of the Zendesk webhook (nothing about "24 hours
// passed with no reply" is a ticket update Zendesk can notify us about, so
// this has to poll on its own schedule instead). 30 minutes keeps each
// stage's actual send time within half an hour of its 24h/72h/120h target,
// which is plenty precise for a "did you get my email" nudge. Runs once
// immediately on startup too, then on the interval, and errors are caught
// per-sweep so one bad run doesn't kill the interval - see runFollowUpSweep
// for per-ticket error isolation. Same pattern as Painting and Vino's
// src/index.ts.
const FOLLOW_UP_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

async function sweepOnce() {
  try {
    const result = await runFollowUpSweep({ zendesk });
    if (result.sent.length || result.errors.length) {
      console.log(
        `[followups] sweep: checked=${result.checked} sent=${result.sent.length} errors=${result.errors.length}`
      );
    }
    for (const e of result.errors) {
      console.error(`[followups] ticket ${e.ticketId} failed:`, e.error);
    }
  } catch (err) {
    console.error("[followups] sweep failed entirely:", err);
  }
}

// Deliberately NOT running a sweep here on startup. Railway restarts the
// process on every deploy, so a startup sweep meant each deploy fired
// another follow-up stage outside the 30-minute pacing - four deploys on
// 2026-09-24 sent four emails to the same customer inside an hour. The
// first sweep now happens one interval after boot, and
// POST /internal/run-follow-up-sweep is still there to trigger one by hand.
setInterval(sweepOnce, FOLLOW_UP_SWEEP_INTERVAL_MS);
