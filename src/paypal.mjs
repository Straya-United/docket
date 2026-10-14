// PayPal REST client (sandbox): Invoicing v2 for the paperwork, Orders v2 for taking money on the quote page.
// PAYPAL_MOCK=1 swaps in an in-memory imitation so the app can be developed without credentials.
import { randomUUID } from 'node:crypto';
import { aud } from './quote.mjs';

const BASE = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
export const CURRENCY = 'AUD';
export const isMock = process.env.PAYPAL_MOCK === '1';
export const clientId = () => (isMock ? 'mock' : process.env.PAYPAL_CLIENT_ID || '');

export class PayPalError extends Error {
  constructor(status, body, op) {
    const d = body?.details?.[0];
    super(`PayPal ${op} failed (${status}): ${d?.issue || body?.name || 'error'}${d?.description ? ` - ${d.description}` : body?.message ? ` - ${body.message}` : ''}`);
    this.status = status; this.body = body; this.op = op;
    this.debugId = body?.debug_id;
  }
}

let token = null;
async function accessToken() {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(res.status, body, 'auth');
  token = { value: body.access_token, exp: Date.now() + body.expires_in * 1000 };
  return token.value;
}

// Every call is logged to the job trace so the UI can show exactly what PayPal was asked.
async function call(op, method, path, payload, { idempotency } = {}) {
  const t0 = Date.now();
  const headers = { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', prefer: 'return=representation' };
  if (idempotency) headers['paypal-request-id'] = idempotency;
  const res = await fetch(BASE + path, { method, headers, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
  const ms = Date.now() - t0;
  if (!res.ok) throw Object.assign(new PayPalError(res.status, body, op), { ms });
  return { body, status: res.status, ms };
}

const money = (c) => ({ currency_code: CURRENCY, value: aud(c) });
const UOM = { hr: 'HOURS', each: 'QUANTITY', m: 'QUANTITY', km: 'QUANTITY', lot: 'QUANTITY' };

export function invoicePayload(job, business, { lines, number, note }) {
  const [given, ...rest] = (job.customer.name || 'Customer').trim().split(/\s+/);
  return {
    detail: {
      currency_code: CURRENCY,
      ...(number ? { invoice_number: number } : {}),
      reference: `Docket job ${job.ref}`,
      note: (note || job.quote.summary || '').slice(0, 4000),
      terms_and_conditions: [
        `Deposit of ${job.quote.deposit_percent}% secures the booking; balance due on completion.`,
        ...(job.quote.exclusions || []).map((e) => `Excludes: ${e}`),
      ].join('\n').slice(0, 4000),
      memo: `Created by Docket from tradie notes. Job ${job.ref}.`,
    },
    invoicer: { business_name: business.name.slice(0, 300) },
    primary_recipients: [{
      billing_info: {
        name: { given_name: given.slice(0, 140), surname: rest.join(' ').slice(0, 140) || undefined },
        ...(job.customer.email ? { email_address: job.customer.email } : {}),
        ...(job.customer.site_address ? { additional_info: job.customer.site_address.slice(0, 40) } : {}),
      },
    }],
    items: lines.map((l) => ({
      name: l.description.slice(0, 200),
      quantity: String(l.quantity),
      unit_amount: money(l.unit_cents),
      unit_of_measure: UOM[l.unit] || 'QUANTITY',
      tax: { name: 'GST', percent: '10' },
    })),
    configuration: {
      allow_tip: false,
      tax_calculated_after_discount: true,
      tax_inclusive: false,
      partial_payment: { allow_partial_payment: true, minimum_amount_due: money(job.quote.deposit_cents) },
    },
  };
}

export function summariseInvoice(inv) {
  const href = (inv.links || []).find((l) => l.rel === 'payer-view')?.href || inv.detail?.metadata?.recipient_view_url || null;
  return {
    id: inv.id,
    number: inv.detail?.invoice_number,
    status: inv.status,
    total_cents: Math.round(Number(inv.amount?.value || 0) * 100),
    paid_cents: Math.round(Number(inv.payments?.paid_amount?.value || 0) * 100),
    due_cents: Math.round(Number(inv.due_amount?.value || 0) * 100),
    payer_link: href,
  };
}

// ---------- real API ----------
const real = {
  async createInvoice(payload) {
    const r = await call('create invoice', 'POST', '/v2/invoicing/invoices', payload, { idempotency: randomUUID() });
    let inv = r.body;
    // Without return=representation support PayPal answers with just a link; fetch the invoice.
    if (!inv.id && inv.href) inv = (await call('get invoice', 'GET', new URL(inv.href).pathname)).body;
    return { invoice: inv, ms: r.ms };
  },
  async sendInvoice(id, note) {
    const r = await call('send invoice', 'POST', `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: true, send_to_invoicer: false, ...(note ? { note } : {}) }, { idempotency: randomUUID() });
    return { payer_link: r.body.href || null, ms: r.ms };
  },
  async getInvoice(id) { const r = await call('get invoice', 'GET', `/v2/invoicing/invoices/${id}`); return { invoice: r.body, ms: r.ms }; },
  async recordPayment(id, { cents: c, captureId, note }) {
    const r = await call('record payment', 'POST', `/v2/invoicing/invoices/${id}/payments`, {
      // payment_id is for PayPal transactions on the invoice itself; an Orders capture id makes PayPal answer RESOURCE_NOT_FOUND,
      // so the capture id goes in the note instead.
      method: 'PAYPAL', payment_date: new Date().toISOString().slice(0, 10), amount: money(c), note: `PayPal Checkout capture ${captureId}. ${note || ''}`.slice(0, 2000),
    });
    return { payment_id: r.body.payment_id, ms: r.ms };
  },
  async remind(id, { subject, note }) {
    const r = await call('send reminder', 'POST', `/v2/invoicing/invoices/${id}/remind`, { subject: subject.slice(0, 4000), note: note.slice(0, 4000), send_to_invoicer: false });
    return { ms: r.ms };
  },
  async createOrder({ cents: c, description, invoiceId, customId }) {
    const r = await call('create order', 'POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: customId, custom_id: customId, invoice_id: invoiceId, description: description.slice(0, 127), soft_descriptor: 'DOCKETDEMO', amount: money(c) }],
      payment_source: { paypal: { experience_context: { brand_name: 'Docket demo', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', locale: 'en-AU' } } },
    }, { idempotency: randomUUID() });
    return { id: r.body.id, status: r.body.status, ms: r.ms };
  },
  async captureOrder(orderId) {
    const r = await call('capture order', 'POST', `/v2/checkout/orders/${orderId}/capture`, {}, { idempotency: `cap-${orderId}` });
    const cap = r.body.purchase_units?.[0]?.payments?.captures?.[0];
    return {
      status: r.body.status, capture_id: cap?.id, capture_status: cap?.status,
      cents: Math.round(Number(cap?.amount?.value || 0) * 100),
      custom_id: r.body.purchase_units?.[0]?.custom_id || cap?.custom_id,
      payer: r.body.payer?.name ? `${r.body.payer.name.given_name || ''} ${r.body.payer.name.surname || ''}`.trim() : null,
      ms: r.ms,
    };
  },
  async getOrder(orderId) { const r = await call('get order', 'GET', `/v2/checkout/orders/${orderId}`); return r.body; },
};

// ---------- mock (no network) ----------
const mem = { invoices: new Map(), orders: new Map(), n: 1000 };
function mockTotals(inv) {
  let total = 0;
  for (const it of inv.items) { const line = Math.round(Number(it.unit_amount.value) * 100 * Number(it.quantity)); total += line + Math.round(line * 0.1); }
  const paid = (inv._payments || []).reduce((s, p) => s + p, 0);
  inv.amount = { currency_code: CURRENCY, value: aud(total) };
  inv.payments = { paid_amount: { currency_code: CURRENCY, value: aud(paid) } };
  inv.due_amount = { currency_code: CURRENCY, value: aud(total - paid) };
  // Like the real API: payments recorded with record-payment end as MARKED_AS_PAID.
  if (inv.status !== 'DRAFT') inv.status = paid === 0 ? 'SENT' : paid >= total ? 'MARKED_AS_PAID' : 'PARTIALLY_PAID';
  return inv;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mock = {
  async createInvoice(payload) {
    await wait(40);
    const id = `INV2-MOCK-${randomUUID().slice(0, 8).toUpperCase()}`;
    const inv = { ...structuredClone(payload), id, status: 'DRAFT', _payments: [] };
    inv.detail.invoice_number = inv.detail.invoice_number || String(++mem.n);
    mem.invoices.set(id, mockTotals(inv));
    return { invoice: structuredClone(inv), ms: 40 };
  },
  async sendInvoice(id) { const inv = mem.invoices.get(id); inv.status = 'SENT'; mockTotals(inv); return { payer_link: `https://www.sandbox.paypal.com/invoice/p/#${id}`, ms: 30 }; },
  async getInvoice(id) { const inv = mem.invoices.get(id); if (!inv) throw new PayPalError(404, { name: 'RESOURCE_NOT_FOUND' }, 'get invoice'); return { invoice: structuredClone(mockTotals(inv)), ms: 20 }; },
  async recordPayment(id, { cents: c }) { const inv = mem.invoices.get(id); inv._payments.push(c); mockTotals(inv); return { payment_id: `EXTR-${randomUUID().slice(0, 8)}`, ms: 30 }; },
  async remind(id) { if (!mem.invoices.get(id)) throw new PayPalError(404, {}, 'send reminder'); return { ms: 25 }; },
  async createOrder({ cents: c, customId }) { const id = `MOCKORDER${randomUUID().slice(0, 8).toUpperCase()}`; mem.orders.set(id, { c, customId, status: 'CREATED' }); return { id, status: 'CREATED', ms: 30 }; },
  async captureOrder(orderId) {
    const o = mem.orders.get(orderId);
    if (!o) throw new PayPalError(404, { name: 'RESOURCE_NOT_FOUND' }, 'capture order');
    if (o.status === 'COMPLETED') throw new PayPalError(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }, 'capture order');
    o.status = 'COMPLETED';
    return { status: 'COMPLETED', capture_id: `MOCKCAP${orderId.slice(-6)}`, capture_status: 'COMPLETED', cents: o.c, custom_id: o.customId, payer: 'Sandbox Buyer', ms: 50 };
  },
  async getOrder(orderId) { return mem.orders.get(orderId) || null; },
};

export const paypal = isMock ? mock : real;

export async function paypalReady() {
  if (isMock) return 'mock';
  try { await accessToken(); return 'ok'; } catch (e) { return `error: ${e.message}`; }
}
