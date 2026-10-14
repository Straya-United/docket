# Docket: quote to paid, for tradies

Docket turns the notes a tradie dictates in the ute into a priced quote, a **PayPal invoice** and a **PayPal checkout link**. The customer approves the quote and pays the deposit from that link. Extra work found on site goes through as a variation the customer approves on the same page. When the job's finished, the customer pays the balance there too. An AI offsider, **Ask Docket**, checks PayPal for what's owing and drafts reminders and variations. Nothing reaches a customer until the tradie taps Confirm.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (2026) by AppForge Digital. It runs entirely on the **PayPal sandbox**, so no real money moves.

**Live demo:** _Render URL goes here_ · **Video:** _YouTube link goes here_

## Who it's for

Sole traders and small trade businesses (electricians, plumbers, handymen) who lose evenings to writing up quotes and chasing deposits. Docket's demo business is a made-up electrician in Mackay, Queensland, so prices are in AUD with 10% GST.

## What it does

1. **Dictate or type the job.** Something like: "Jane at Andergrove, swap 6 halogen downlights for LED, 2 power points in the garage".
2. **AI drafts the quote from the tradie's own price book.** The model picks price-book items and estimates quantities and labour hours, explaining each one ("6 downlights × 20 min + set-up"). It also writes what the price assumes, what's excluded, and what to confirm on site. **The model never sets a price.** The server prices every line from the price book and does all the arithmetic and GST in cents. Anything the AI says isn't in the price book is flagged **Check price**, and the quote can't be sent until the tradie confirms it.
3. **Send via PayPal.** Docket creates and sends a **PayPal invoice** (Invoicing v2) with GST per line and a minimum partial payment equal to the deposit. It also gives the tradie a customer link.
4. **The customer approves and pays the deposit** on the quote page with **PayPal Checkout** (JS SDK buttons and the Orders v2 API: create and capture). Docket records the capture against the PayPal invoice (record payment), so the invoice shows **Partially paid** in PayPal.
5. **Variations.** "Rats chewed the cable to the garage, about 15 m": the AI drafts and prices the variation and the tradie confirms it. The customer approves it on their page, and Docket raises a separate PayPal invoice for it.
6. **Job done.** The tradie taps once. PayPal sends the customer a balance reminder, and the customer pays the balance on the same page. The payment is split across the main and variation invoices and recorded on each, so every PayPal invoice ends paid (PayPal shows invoices settled through record payment as **Marked as paid**).
7. **Ask Docket.** "Who still owes me?" and "Chase anyone who owes me". The agent uses function calling with tools that read the jobs and live PayPal invoice status. Its tools that act (reminders, variations, marking a job complete) only **propose** a card. The PayPal call happens only when the tradie taps Confirm.

Every PayPal call is listed on the job ("PayPal API calls"), with timing and PayPal debug IDs on failures.

## PayPal + AI, in detail

| PayPal | Used for |
|---|---|
| OAuth 2.0 client credentials | Server-side token, cached until expiry |
| Invoicing v2: create, send, get, record payment, remind | The quote becomes a real invoice with GST and a deposit minimum. Payments are recorded against it, and reminders are sent through it. |
| Orders v2: create, capture | Deposit and balance checkout from the quote page. `custom_id` ties each capture to the job and stage, and it's verified on capture. |
| JavaScript SDK (Buttons) | PayPal wallet and card checkout in AUD on the customer page |

| AI | Used for |
|---|---|
| OpenAI Responses API with strict JSON schema output | Drafting quotes and variations against the price book |
| OpenAI Responses API with function calling | Ask Docket: list jobs, check PayPal, propose reminder, propose variation, propose completion |

### Guard rails

- The model chooses items and quantities. The server owns prices, rounding, GST and deposits, and amounts sent to PayPal are always computed on the server.
- Custom (not in the price book) lines are blocked from sending until the tradie checks them.
- The agent cannot contact a customer or touch money. Its action tools create proposals only, and confirming is a separate request from the tradie's browser.
- Order capture checks that the order was created for this quote and stage, and a repeated capture is ignored.
- Customer links are random 144-bit tokens. Tradie workspaces sit behind an HttpOnly cookie, and cross-site POSTs are rejected.
- A strict Content Security Policy allows only PayPal's SDK domains. There are per-IP and daily caps on AI calls and per-IP caps on PayPal calls.
- The job notes are treated as data, and the prompts tell the model to ignore instructions inside them.

## Run it

Needs Node 22.19 or later. It has no npm dependencies.

```bash
# Offline: PayPal and the AI are both mocked
npm run dev:mock          # http://localhost:8791
npm test                  # end-to-end flow test with mocks

# Real sandbox
export PAYPAL_CLIENT_ID=...       # sandbox REST app with Invoicing enabled
export PAYPAL_CLIENT_SECRET=...
export OPENAI_API_KEY=...
export OPENAI_MODEL=gpt-5.6-terra # optional
npm start
```

In the PayPal developer dashboard, the sandbox app needs **Invoicing** ticked under its features. If you enable it after the app has already fetched a token, PayPal keeps returning the cached token without the new scope until it expires. `scripts/paypal-token-reset.mjs` ends that token.

`scripts/live-check.mjs [base-url] [--send]` drafts three sample jobs with the real model and optionally sends one as a PayPal invoice.
`scripts/paypal-flow-check.mjs` runs every PayPal call in the flow against the sandbox, standing in for the buyer's checkout: invoice create and send, deposit recorded, variation invoice, reminder, balance split across both invoices. Last run on 14 Oct 2026: all calls OK, and both invoices ended Marked as paid.

### Deploy

`render.yaml` is a Render Blueprint (a free Node web service). Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `OPENAI_API_KEY` as secrets. State is in memory per browser workspace, so a restart clears demo jobs. PayPal keeps the invoices.

## Testing it as a judge

1. Open the demo and tap an example job, or dictate one. Tap **Draft the quote**.
2. Tap any red **Check price** flag, then **Send quote via PayPal**.
3. **Open customer page** and pay the deposit with the PayPal sandbox buyer account listed on the Devpost submission, or with a sandbox test card.
4. Back in the tradie view, use **Add a variation**, then confirm it under Ask Docket and approve it on the customer page.
5. Tap **Job done**, then pay the balance on the customer page. Ask Docket: "Who still owes me money?"

## Project layout

```
server.mjs          HTTP server, routes, security headers, limits
src/jobs.mjs        job workflow: draft, send, orders, captures, variations, completion
src/paypal.mjs      PayPal REST client (Invoicing v2, Orders v2) + offline mock
src/assistant.mjs   Ask Docket agent: tools and confirm-to-act actions
src/llm.mjs         OpenAI Responses API: strict JSON and function-calling loop
src/prompts.mjs     prompts and JSON schemas
src/quote.mjs       pricing, GST, deposits (all in cents)
src/ratecard.mjs    demo business and price book
public/             tradie app (index.html, app.js), customer page (quote.html, quote.js)
```

## Licence

MIT. Business, customers and prices in the demo are fictional.
