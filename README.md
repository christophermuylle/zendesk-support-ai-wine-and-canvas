# Zendesk Support AI

AI customer support automation for Zendesk: drafts and (once you trust it)
sends replies to incoming tickets, and sets ticket status (Solved / Pending)
based on rules you control. Built to replace a paid tool like eesel.ai with
something you own outright — the only recurring costs are Claude API usage
(pennies per ticket) and wherever you host this small service.

## How it works

```
Customer emails support
        |
        v
Zendesk ticket created/updated
        |
        v
Zendesk trigger fires -> webhook POST to this app
        |
        v
1. Fetch full ticket + conversation from Zendesk API
2. Run config/rules.yaml against the latest customer message
   -> decides: solve / pending / escalate, and whether a human MUST review
3. Ask Claude to draft a reply, grounded only in config/knowledge-base.md
4. Act:
   - MODE=draft (recommended to start): post the draft as an INTERNAL NOTE
     on the ticket for a human to read, edit if needed, and send
   - MODE=auto: post the reply directly to the customer and update the
     ticket status
```

Two files are the actual "brains" and are meant to be edited by you, not
code:

- **`config/knowledge-base.md`** — everything the AI is allowed to answer
  from. If it's not written here, the AI is instructed to say "let me
  check" instead of guessing.
- **`config/rules.yaml`** — the solve/pending/escalate logic. Plain
  keyword-matching rules, checked top to bottom, first match wins. Add,
  reorder, or edit rules with a text editor — no code changes needed.

## 1. Fill in your knowledge base and rules

Open `config/knowledge-base.md` and replace the `<!-- TODO -->` sections
with your real booking process, pricing, cancellation policy, licensee
details, etc.

Open `config/rules.yaml` and adjust to match how you actually want tickets
routed. It ships with a starting set for Painting & Vino / Wine and Canvas
(refunds and angry customers always go to a human; FAQs auto-solve;
licensee leads and booking questions go to pending with a qualifying
question). Test changes anytime with:

```
npm run test:mock
```

This runs 4 sample tickets through your actual rules + knowledge base
without touching real Zendesk data (and without an Anthropic API key, using
a fake canned reply, so it's free and safe to run repeatedly). Add
`ANTHROPIC_API_KEY=sk-... npm run test:mock` to also see real AI-drafted
replies for those sample tickets.

## 2. Get your Zendesk API token

1. Zendesk Admin Center → **Apps and integrations** → **APIs** → **Zendesk API**
2. Enable **Token access** if not already on
3. **Add API token**, name it (e.g. "support-ai"), copy it — Zendesk only
   shows it once
4. Note your subdomain too (from `https://YOURSUBDOMAIN.zendesk.com`)

## 3. Get a Claude API key

1. https://console.anthropic.com/ → **API Keys** → **Create Key**
2. Add a few dollars of credit — ticket drafting is cheap (a typical ticket
   costs a fraction of a cent to a few cents depending on conversation
   length)

## 4. Configure environment

```
cp .env.example .env
```

Fill in `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL` (the agent account the token
belongs to), `ZENDESK_API_TOKEN`, `ANTHROPIC_API_KEY`. Leave `MODE=draft`
for now — see step 7.

## 5. Run it locally first

```
npm install
npm run dev
```

This starts the webhook server on `http://localhost:3000`. `/health`
should return `{"ok":true,...}`. It isn't reachable by Zendesk yet — for
that you need it hosted somewhere with a public URL (step 6), or you can
tunnel your local server temporarily with a tool like `ngrok` for testing.

## 6. Where to host it

You don't need anything fancy — this is a small, mostly-idle web service.
Recommendation, cheapest to priciest:

- **Railway** (recommended) — connect this project's GitHub repo, it
  detects Node automatically, set the env vars from your `.env` in its
  dashboard, deploy. Free trial credit, then usage-based — realistically a
  few dollars a month for this workload, far less than eesel.ai.
- **Render** — same idea as Railway (Web Service, Node, free tier
  available but sleeps when idle, which adds latency to the first ticket
  after a quiet spell).
- **A cheap VPS** you already run (e.g. if you have one for another
  project) — `npm run build && npm start` behind `pm2` or a systemd
  service, with a reverse proxy (Caddy/nginx) for HTTPS.

Whichever you pick, you need: the app running continuously, reachable over
HTTPS at a public URL, with the same env vars as your local `.env`.

I can walk you through deploying to whichever option you pick, or set it up
directly if you connect the relevant account.

## 7. Securing the webhook

Zendesk can sign its webhook requests so you can verify they really came
from Zendesk (not just anyone who finds your URL). In Zendesk Admin Center
→ **Apps and integrations** → **Webhooks**, when you create the webhook
(next step) it generates a **Signing Secret** — copy it into
`ZENDESK_WEBHOOK_SECRET` in your `.env`. If you leave it blank, the app
still works but skips signature verification — fine for local testing, not
recommended once it's live and handling real customer data.

## 8. Create the Zendesk webhook + trigger

**Webhook** (Admin Center → Apps and integrations → Webhooks → Create webhook):
- Name: `Support AI`
- Endpoint URL: `https://YOUR-DEPLOYED-URL/webhooks/zendesk/ticket-updated`
- Request method: `POST`
- Request format: `JSON`
- Authentication: none needed (we use the signing secret instead — see
  step 7)

**Trigger** (Admin Center → Objects and rules → Business rules → Triggers →
Add trigger):
- Conditions: `Ticket is Created` OR (`Ticket: Status` changed AND `Type of
  update` is `Public comment`) — i.e. fire whenever the customer sends a
  new message
- Also add a condition `Ticket: Channel` is not `Support AI` (or similar)
  once you're in `MODE=auto`, so the bot doesn't trigger itself into a
  reply loop when it posts its own comment
- Action: **Notify webhook** → `Support AI` → JSON body:
  ```json
  { "ticket_id": "{{ticket.id}}" }
  ```

## 9. Test with real (low-stakes) tickets

With `MODE=draft`, send yourself a test email into the Zendesk support
address and confirm an internal note with the AI's suggested reply shows up
on the ticket within a few seconds. Iterate on `knowledge-base.md` and
`rules.yaml` based on what you see for a week or two of real traffic.

## 10. Flip to autonomous mode

Once you trust the drafts (accuracy, tone, and that rules route correctly),
set `MODE=auto` in your hosting provider's env vars and redeploy. The AI
will now reply to customers directly and set ticket status itself. Tickets
matched by a rule with `force_human_review: true` (refunds, upset
customers, and anything else you mark that way in `rules.yaml`) will still
always be held for a human, even in auto mode — that's by design, keep
money/reputation-risk tickets human-reviewed indefinitely if you'd like.

## Project structure

```
config/
  knowledge-base.md   <- what the AI is allowed to answer from (edit freely)
  rules.yaml           <- solve/pending/escalate logic (edit freely)
src/
  zendesk.ts            Zendesk API client
  rules.ts               loads + evaluates rules.yaml
  ai.ts                  Claude drafting
  pipeline.ts             ties fetch -> rules -> draft -> act together
  index.ts                Express webhook server (the live entry point)
  config.ts               env var loading
scripts/
  test-local.ts          offline test harness, see step 1
```

## Extending this

- **Multiple brands**: run two deployments (Wine and Canvas / Painting and
  Vino) each with its own `.env` (`BRAND=`), knowledge base, and rules —
  or point both at the same Zendesk if tickets are already
  distinguishable by tag/brand field and branch inside `rules.yaml`.
- **Smarter rules**: `rules.yaml` currently matches on keywords for
  simplicity and predictability. If keyword rules start feeling too rigid,
  the natural next step is an AI-based classification step before the
  rules engine — ask if you want that added.
- **Reporting**: every processed ticket is tagged (`faq_auto_answered`,
  `needs_human`, etc.) specifically so you can build a Zendesk view or
  dashboard filtering by these tags to see what the AI is handling vs.
  escalating.
