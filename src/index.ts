import crypto from "node:crypto";
import express from "express";
import { env, loadSharedKnowledgeBase, loadLocationSnippet, RULES_PATH, LOCATIONS_PATH } from "./config.js";
import { ZendeskClient } from "./zendesk.js";
import { RulesEngine } from "./rules.js";
import { LocationResolver } from "./locations.js";
import { AiDrafter } from "./ai.js";
import { processTicket } from "./pipeline.js";

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

app.listen(env.port, () => {
  console.log(`Zendesk support AI listening on port ${env.port} (mode=${env.mode}, brand=${env.brand})`);
});
