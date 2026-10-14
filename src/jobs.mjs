// Docket's job workflow: draft quote -> send (PayPal invoice) -> deposit (PayPal order) -> variations -> balance -> paid.
// Workspaces live in memory; PayPal holds the invoices and payments.
import { randomBytes, randomUUID } from 'node:crypto';
import { DEMO_BUSINESS, DEMO_RATE_CARD } from './ratecard.mjs';
import { priceLines, repriceEdited, depositOf, totalsOf, aud } from './quote.mjs';
import { llmJson } from './llm.mjs';
import { QUOTE_SCHEMA, VARIATION_SCHEMA, quoteSystem, variationSystem, mockQuote, mockVariation } from './prompts.mjs';
import { paypal, invoicePayload, summariseInvoice, PayPalError } from './paypal.mjs';

const workspaces = new Map();
const tokens = new Map(); // customer token -> { ws, jobId }
const orders = new Map(); // PayPal order id -> { ws, jobId, kind, cents, splits }
const WS_TTL = 14 * 24 * 3600 * 1000;

export function workspace(id) {
  let ws = id && workspaces.get(id);
  if (!ws) {
    id = randomBytes(16).toString('hex');
    ws = { id, business: { ...DEMO_BUSINESS }, rateCard: structuredClone(DEMO_RATE_CARD), jobs: new Map(), actions: new Map(), chat: [], seq: 1040, at: Date.now() };
    workspaces.set(id, ws);
    if (workspaces.size > 2000) { const old = workspaces.keys().next().value; dropWorkspace(old); }
  }
  ws.at = Date.now();
  return ws;
}
function dropWorkspace(id) {
  const ws = workspaces.get(id); if (!ws) return;
  for (const j of ws.jobs.values()) tokens.delete(j.token);
  workspaces.delete(id);
}
setInterval(() => { const now = Date.now(); for (const [id, ws] of workspaces) if (now - ws.at > WS_TTL) dropWorkspace(id); }, 3600 * 1000).unref();

const now = () => new Date().toISOString();
function event(job, who, text) { job.events.push({ at: now(), who, text }); }
function trace(job, entry) { job.trace.push({ at: now(), ...entry }); if (job.trace.length > 80) job.trace.shift(); }
const $ = (c) => '$' + (c / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function getJob(ws, id) { const j = ws.jobs.get(id); if (!j) throw httpError(404, 'That job was not found.'); return j; }
export function findJob(ws, ref) {
  const r = String(ref || '').toUpperCase().replace(/^#/, '');
  for (const j of ws.jobs.values()) if (j.ref === r || j.id === ref) return j;
  return null;
}
export function httpError(code, message) { return Object.assign(new Error(message), { code, public: true }); }

// ---------- money position ----------
export function position(job) {
  const approvedVars = job.variations.filter((v) => v.status === 'approved');
  const contract = job.quote.totals.total_cents + approvedVars.reduce((s, v) => s + v.totals.total_cents, 0);
  const paid = job.payments.reduce((s, p) => s + p.cents, 0);
  let dueNow = 0, dueKind = null;
  if (job.status === 'quoted' && paid === 0) { dueNow = job.quote.deposit_cents; dueKind = 'deposit'; }
  else if (job.status === 'complete') { dueNow = Math.max(0, contract - paid); dueKind = 'balance'; }
  return { contract_cents: contract, paid_cents: paid, owing_cents: Math.max(0, contract - paid), due_now_cents: dueNow, due_kind: dueKind };
}

// ---------- 1. draft ----------
export async function draftQuote(ws, notes, onStep = () => {}) {
  onStep({ step: 'thinking', text: 'Reading your notes against the price book' });
  const t0 = Date.now();
  const raw = await llmJson({ system: quoteSystem(ws.business, ws.rateCard), user: `Job notes:\n"""${notes}"""`, name: 'quote_draft', schema: QUOTE_SCHEMA, mock: () => mockQuote(notes) });
  onStep({ step: 'model', ms: Date.now() - t0, lines: raw.lines.length });
  const priced = priceLines(raw.lines, ws.rateCard);
  if (!priced.lines.length) throw httpError(422, 'I could not turn those notes into quote lines. Add a bit more detail about the work.');
  onStep({ step: 'priced', text: `Priced ${priced.lines.length} lines from your price book${priced.dropped.length ? `, dropped ${priced.dropped.length}` : ''}` });
  const id = randomUUID();
  const job = {
    id, ref: `J${++ws.seq}`, created_at: now(), notes, status: 'draft',
    customer: { name: raw.customer.name.slice(0, 80), email: raw.customer.email.slice(0, 120), site_address: raw.customer.site_address.slice(0, 120) },
    quote: {
      title: raw.job_title.slice(0, 80), summary: raw.summary.slice(0, 700), lines: priced.lines, totals: priced.totals,
      deposit_percent: ws.business.deposit_percent, deposit_cents: depositOf(priced.totals.total_cents, ws.business.deposit_percent),
      assumptions: raw.assumptions.slice(0, 5).map((s) => s.slice(0, 160)), exclusions: raw.exclusions.slice(0, 5).map((s) => s.slice(0, 160)),
      questions: raw.questions.slice(0, 4).map((s) => s.slice(0, 160)), dropped: priced.dropped,
    },
    variations: [], payments: [], invoice: null, token: randomBytes(18).toString('base64url'), events: [], trace: [],
  };
  event(job, 'docket', `Drafted ${priced.lines.length} lines from your notes`);
  ws.jobs.set(id, job);
  tokens.set(job.token, { ws: ws.id, jobId: id });
  return job;
}

// ---------- 2. edit ----------
export function updateDraft(ws, job, patch) {
  if (job.status !== 'draft') throw httpError(409, 'This quote has already been sent. Use a variation for changes.');
  const c = patch.customer || {};
  job.customer = { name: String(c.name ?? job.customer.name).trim().slice(0, 80), email: String(c.email ?? job.customer.email).trim().slice(0, 120), site_address: String(c.site_address ?? job.customer.site_address).trim().slice(0, 120) };
  if (patch.title) job.quote.title = String(patch.title).slice(0, 80);
  if (patch.summary) job.quote.summary = String(patch.summary).slice(0, 700);
  if (Array.isArray(patch.lines)) {
    const r = repriceEdited(patch.lines, ws.rateCard);
    if (!r.lines.length) throw httpError(400, 'A quote needs at least one line.');
    job.quote.lines = r.lines; job.quote.totals = r.totals;
  }
  if (patch.deposit_percent !== undefined) job.quote.deposit_percent = Math.min(100, Math.max(0, Math.round(Number(patch.deposit_percent) || 0)));
  job.quote.deposit_cents = depositOf(job.quote.totals.total_cents, job.quote.deposit_percent);
  return job;
}

// ---------- 3. send: PayPal invoice ----------
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
export async function sendQuote(ws, job) {
  if (job.status !== 'draft') throw httpError(409, 'This quote was already sent.');
  if (!job.customer.name) throw httpError(400, 'Add the customer\'s name first.');
  if (!validEmail(job.customer.email)) throw httpError(400, 'Add the customer\'s email so PayPal can send the invoice.');
  if (job.quote.lines.some((l) => l.needs_price)) throw httpError(400, 'Check the prices marked "check price" first.');
  const payload = invoicePayload(job, ws.business, { lines: job.quote.lines });
  const created = await withTrace(job, 'create invoice', () => paypal.createInvoice(payload), (r) => `${r.invoice.id}, ${r.invoice.status}, total $${r.invoice.amount?.value}`);
  const sent = await withTrace(job, 'send invoice', () => paypal.sendInvoice(created.invoice.id), () => `sent to ${job.customer.email}`);
  const fresh = await withTrace(job, 'get invoice', () => paypal.getInvoice(created.invoice.id), (r) => `${r.invoice.status}, due $${r.invoice.due_amount?.value}`);
  job.invoice = { ...summariseInvoice(fresh.invoice), payer_link: sent.payer_link || summariseInvoice(fresh.invoice).payer_link };
  // PayPal's total is the record. If its rounding differs by a few cents, follow it.
  if (job.invoice.total_cents && Math.abs(job.invoice.total_cents - job.quote.totals.total_cents) <= 5) {
    job.quote.totals.total_cents = job.invoice.total_cents;
    job.quote.totals.gst_cents = job.invoice.total_cents - job.quote.totals.subtotal_cents;
  }
  job.status = 'quoted';
  event(job, 'paypal', `Invoice #${job.invoice.number} sent to ${job.customer.email} (${$(job.quote.totals.total_cents)} inc GST, ${job.quote.deposit_percent}% deposit to book)`);
  return job;
}

async function withTrace(job, op, fn, describe) {
  try {
    const r = await fn();
    trace(job, { op, ok: true, ms: r.ms ?? null, detail: describe ? describe(r) : '' });
    return r;
  } catch (e) {
    trace(job, { op, ok: false, ms: e.ms ?? null, detail: e.message, debug_id: e.debugId });
    if (e instanceof PayPalError) throw httpError(502, `PayPal said no to "${op}": ${e.message.replace(/^PayPal [^:]+: /, '')}`);
    throw e;
  }
}

// ---------- customer side ----------
export function byToken(token) {
  const t = tokens.get(String(token || ''));
  const ws = t && workspaces.get(t.ws);
  const job = ws && ws.jobs.get(t.jobId);
  if (!job) throw httpError(404, 'This quote link is no longer active.');
  return { ws, job };
}

export function customerView(ws, job) {
  const pos = position(job);
  return {
    business: { name: ws.business.name, location: ws.business.location, licence: ws.business.licence },
    ref: job.ref, status: job.status, customer: { name: job.customer.name, site_address: job.customer.site_address },
    quote: { title: job.quote.title, summary: job.quote.summary, lines: job.quote.lines.map(({ reasoning, needs_price, ...l }) => l), totals: job.quote.totals, deposit_percent: job.quote.deposit_percent, deposit_cents: job.quote.deposit_cents, assumptions: job.quote.assumptions, exclusions: job.quote.exclusions },
    variations: job.variations.map((v) => ({ id: v.id, n: v.n, title: v.title, reason: v.reason, lines: v.lines.map(({ reasoning, needs_price, ...l }) => l), totals: v.totals, status: v.status })),
    payments: job.payments.map((p) => ({ kind: p.kind, cents: p.cents, at: p.at, capture_id: p.capture_id, status: p.capture_status })),
    position: pos,
    invoice: job.invoice ? { number: job.invoice.number, status: job.invoice.status, payer_link: job.invoice.payer_link } : null,
    events: job.events.filter((e) => e.who !== 'docket').slice(-12),
  };
}

// Split a payment across the main invoice and approved variation invoices, oldest first.
function splitsFor(job, cents) {
  const out = [];
  let left = cents;
  const owe = (inv, total) => Math.max(0, total - job.payments.flatMap((p) => p.splits).filter((s) => s.invoice_id === inv).reduce((a, s) => a + s.cents, 0));
  const targets = [{ invoice_id: job.invoice.id, total: job.quote.totals.total_cents }, ...job.variations.filter((v) => v.status === 'approved' && v.invoice).map((v) => ({ invoice_id: v.invoice.id, total: v.totals.total_cents }))];
  for (const t of targets) { const take = Math.min(left, owe(t.invoice_id, t.total)); if (take > 0) { out.push({ invoice_id: t.invoice_id, cents: take }); left -= take; } }
  if (left > 0 && out.length) out[0].cents += left;
  return out;
}

export async function createOrder(ws, job, kind) {
  const pos = position(job);
  if (!pos.due_kind || pos.due_kind !== kind || pos.due_now_cents <= 0) throw httpError(409, 'Nothing is due on this quote right now.');
  const cents = pos.due_now_cents;
  const label = kind === 'deposit' ? `Deposit ${job.quote.deposit_percent}%` : 'Balance';
  const r = await withTrace(job, 'create order', () => paypal.createOrder({
    cents, description: `${ws.business.name}: ${job.quote.title} (${label})`,
    invoiceId: `${job.invoice.number}-${kind === 'deposit' ? 'DEP' : 'BAL'}-${randomBytes(3).toString('hex')}`, customId: `${job.id}:${kind}`,
  }), (o) => `${o.id} for ${$(cents)}`);
  orders.set(r.id, { ws: ws.id, jobId: job.id, kind, cents });
  return { id: r.id };
}

export async function captureOrder(ws, job, orderId) {
  const o = orders.get(orderId);
  if (!o || o.jobId !== job.id) throw httpError(404, 'That payment was not started from this quote.');
  if (o.done) return job;
  const cap = await withTrace(job, 'capture order', () => paypal.captureOrder(orderId), (c) => `${c.status}, capture ${c.capture_id} ${c.capture_status}`);
  if (cap.custom_id && cap.custom_id !== `${job.id}:${o.kind}`) throw httpError(409, 'Payment did not match this quote.');
  if (!['COMPLETED', 'PENDING'].includes(cap.capture_status)) throw httpError(402, `PayPal did not complete the payment (${cap.capture_status || cap.status}). Nothing was charged.`);
  o.done = true;
  const cents = cap.cents || o.cents;
  const splits = splitsFor(job, cents);
  const pay = { kind: o.kind, cents, capture_id: cap.capture_id, capture_status: cap.capture_status, order_id: orderId, at: now(), splits };
  job.payments.push(pay);
  for (const s of splits) {
    await withTrace(job, 'record payment', () => paypal.recordPayment(s.invoice_id, { cents: s.cents, captureId: cap.capture_id, note: `PayPal order ${orderId} (${o.kind}) via Docket` }), () => `${$(s.cents)} against ${s.invoice_id}`)
      .catch((e) => { s.record_error = e.message; });
  }
  await refreshInvoices(job).catch(() => {});
  if (o.kind === 'deposit') { job.status = 'booked'; event(job, 'customer', `Approved the quote and paid the ${$(cents)} deposit by PayPal${cap.capture_status === 'PENDING' ? ' (pending at PayPal)' : ''}`); }
  else { job.status = position(job).owing_cents <= 0 ? 'paid' : 'complete'; event(job, 'customer', `Paid the ${$(cents)} balance by PayPal${job.status === 'paid' ? '. Job fully paid.' : ''}`); }
  return job;
}

export async function refreshInvoices(job) {
  if (!job.invoice) return job;
  // Retry any payment that reached PayPal Checkout but failed to record on its invoice.
  for (const p of job.payments) for (const s of p.splits.filter((x) => x.record_error)) {
    await withTrace(job, 'record payment', () => paypal.recordPayment(s.invoice_id, { cents: s.cents, captureId: p.capture_id, note: `retry, order ${p.order_id}` }), () => `${$(s.cents)} against ${s.invoice_id} (retry)`)
      .then(() => { delete s.record_error; }).catch(() => {});
  }
  const r = await withTrace(job, 'get invoice', () => paypal.getInvoice(job.invoice.id), (x) => `${x.invoice.status}, paid $${x.invoice.payments?.paid_amount?.value || '0.00'}, due $${x.invoice.due_amount?.value}`);
  job.invoice = { ...summariseInvoice(r.invoice), payer_link: job.invoice.payer_link || summariseInvoice(r.invoice).payer_link };
  for (const v of job.variations.filter((x) => x.invoice)) {
    const rv = await withTrace(job, 'get invoice', () => paypal.getInvoice(v.invoice.id), (x) => `variation ${x.invoice.status}`);
    v.invoice = { ...summariseInvoice(rv.invoice), payer_link: v.invoice.payer_link };
  }
  return job;
}

// ---------- variations ----------
export async function draftVariation(ws, job, note) {
  if (!['booked', 'quoted'].includes(job.status)) throw httpError(409, 'Variations are for jobs that are booked and not yet finished.');
  const raw = await llmJson({ system: variationSystem(ws.business, ws.rateCard, job), user: `Tradie's note about the extra work:\n"""${note}"""`, name: 'variation_draft', schema: VARIATION_SCHEMA, mock: () => mockVariation(note) });
  const priced = priceLines(raw.lines, ws.rateCard);
  if (!priced.lines.length) throw httpError(422, 'I could not price that variation. Add a bit more detail.');
  return { title: raw.title.slice(0, 80), reason: raw.reason_for_customer.slice(0, 500), lines: priced.lines, totals: priced.totals, note };
}

export function addVariation(job, draft) {
  const v = { id: randomUUID(), n: job.variations.length + 1, ...draft, status: 'pending', created_at: now(), invoice: null };
  job.variations.push(v);
  event(job, 'tradie', `Sent variation V${v.n} "${v.title}" (${$(v.totals.total_cents)}) for approval`);
  return v;
}

export async function answerVariation(ws, job, variationId, approve) {
  const v = job.variations.find((x) => x.id === variationId);
  if (!v || v.status !== 'pending') throw httpError(409, 'That variation is not waiting for an answer.');
  if (!approve) { v.status = 'declined'; event(job, 'customer', `Declined variation V${v.n}`); return job; }
  const payload = invoicePayload({ ...job, quote: { ...job.quote, summary: `Variation V${v.n} to invoice #${job.invoice.number}: ${v.reason}`, deposit_cents: v.totals.total_cents, exclusions: [] } }, ws.business, { lines: v.lines });
  payload.detail.reference = `Docket job ${job.ref} variation V${v.n}`;
  payload.configuration.partial_payment = { allow_partial_payment: false };
  const created = await withTrace(job, 'create invoice', () => paypal.createInvoice(payload), (r) => `variation ${r.invoice.id}, total $${r.invoice.amount?.value}`);
  const sent = await withTrace(job, 'send invoice', () => paypal.sendInvoice(created.invoice.id), () => 'variation invoice sent');
  v.invoice = { ...summariseInvoice(created.invoice), status: 'SENT', payer_link: sent.payer_link };
  if (v.invoice.total_cents && Math.abs(v.invoice.total_cents - v.totals.total_cents) <= 5) v.totals.total_cents = v.invoice.total_cents;
  v.status = 'approved';
  event(job, 'customer', `Approved variation V${v.n} (${$(v.totals.total_cents)}). PayPal invoice #${v.invoice.number} added to the job.`);
  return job;
}

// ---------- completion and reminders ----------
export async function markComplete(ws, job, note) {
  if (job.status !== 'booked') throw httpError(409, job.status === 'quoted' ? 'The deposit has not been paid yet.' : 'This job is not in progress.');
  if (job.variations.some((v) => v.status === 'pending')) throw httpError(409, 'A variation is still waiting for the customer.');
  job.status = 'complete';
  const pos = position(job);
  await withTrace(job, 'send reminder', () => paypal.remind(job.invoice.id, {
    subject: `${job.quote.title}: job complete, balance ${$(pos.owing_cents)}`,
    note: (note || `All done. The balance of ${$(pos.owing_cents)} is now due. Thanks for having us.`).slice(0, 1000),
  }), () => 'balance reminder sent via PayPal');
  event(job, 'tradie', `Marked the job complete and asked for the ${$(pos.owing_cents)} balance`);
  return job;
}

export async function sendReminder(ws, job, note) {
  if (!job.invoice) throw httpError(409, 'This quote has not been sent yet.');
  const pos = position(job);
  if (pos.owing_cents <= 0) throw httpError(409, 'Nothing is owing on this job.');
  await withTrace(job, 'send reminder', () => paypal.remind(job.invoice.id, { subject: `Reminder: ${job.quote.title}`, note: note.slice(0, 1000) }), () => 'reminder sent via PayPal');
  event(job, 'tradie', `Sent a payment reminder via PayPal`);
  return job;
}

// ---------- tradie views ----------
export function jobCard(job) {
  const pos = position(job);
  return {
    id: job.id, ref: job.ref, status: job.status, created_at: job.created_at, customer: job.customer, title: job.quote.title,
    total_cents: pos.contract_cents, paid_cents: pos.paid_cents, owing_cents: pos.owing_cents,
    pending_variations: job.variations.filter((v) => v.status === 'pending').length,
    invoice: job.invoice && { number: job.invoice.number, status: job.invoice.status },
  };
}
export function jobDetail(job) { return { ...job, token: undefined, link: `/q/${job.token}`, position: position(job) }; }

export function totalsSummary(ws) {
  let owing = 0, paid = 0, quoted = 0;
  for (const j of ws.jobs.values()) { const p = position(j); paid += p.paid_cents; if (j.status === 'draft') continue; if (j.status === 'quoted') quoted += p.contract_cents; else owing += p.owing_cents; }
  return { owing_cents: owing, paid_cents: paid, awaiting_approval_cents: quoted };
}

export { totalsOf, aud, $ as fmt };
