// Live check of every PayPal call in the job flow except buyer checkout (which needs a person to approve).
// Uses the canned quote (no AI), sends a real sandbox invoice, records the deposit, adds and approves a variation,
// marks the job complete (PayPal reminder), records the balance, and confirms every invoice ends PAID.
// Usage: node scripts/dev-live.mjs is NOT needed; run: node scripts/paypal-flow-check.mjs
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const dir = process.env.SECRETS_DIR || 'D:/GameDevelopment/.secrets';
const f = path.join(dir, 'paypal.env');
if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0) process.env[l.slice(0, i).trim()] ||= l.slice(i + 1).trim(); }
process.env.LLM_MOCK = '1';
const J = await import('../src/jobs.mjs');
const { paypal } = await import('../src/paypal.mjs');

const ws = J.workspace();
let job = await J.draftQuote(ws, 'Jane Citizen, jane@example.com, Andergrove. Swap 6 old halogen downlights for LED, has a dimmer. 2 double power points in the garage.');
job.quote.lines.forEach((l) => { l.needs_price = false; });
await J.sendQuote(ws, job);
console.log('sent', job.invoice.number, job.invoice.status, J.fmt(job.quote.totals.total_cents), 'deposit', J.fmt(job.quote.deposit_cents));

// Stand-in for the buyer's checkout: record the deposit the way captureOrder does.
const dep = job.quote.deposit_cents;
await paypal.recordPayment(job.invoice.id, { cents: dep, captureId: 'TEST-CAPTURE-DEP', note: 'flow check' });
job.payments.push({ kind: 'deposit', cents: dep, capture_id: 'TEST-CAPTURE-DEP', order_id: 'n/a', at: new Date().toISOString(), splits: [{ invoice_id: job.invoice.id, cents: dep }] });
job.status = 'booked';
await J.refreshInvoices(job);
console.log('after deposit', job.invoice.status, 'paid', J.fmt(job.invoice.paid_cents), 'due', J.fmt(job.invoice.due_cents));

const d = await J.draftVariation(ws, job, 'Rats chewed the cable to the garage, replace about 15 m');
const v = J.addVariation(job, d);
await J.answerVariation(ws, job, v.id, true);
console.log('variation', v.invoice.number, v.invoice.status, J.fmt(v.totals.total_cents));

await J.markComplete(ws, job, '');
const pos = J.position(job);
console.log('complete; balance', J.fmt(pos.owing_cents));

// Balance split across both invoices, as captureOrder does.
const left = pos.owing_cents;
const mainDue = job.quote.totals.total_cents - dep;
const splits = [{ invoice_id: job.invoice.id, cents: mainDue }, { invoice_id: v.invoice.id, cents: left - mainDue }];
for (const s of splits) await paypal.recordPayment(s.invoice_id, { cents: s.cents, captureId: 'TEST-CAPTURE-BAL', note: 'flow check' });
job.payments.push({ kind: 'balance', cents: left, capture_id: 'TEST-CAPTURE-BAL', order_id: 'n/a', at: new Date().toISOString(), splits });
await J.refreshInvoices(job);
console.log('final main', job.invoice.status, J.fmt(job.invoice.paid_cents), '| variation', v.invoice.status, J.fmt(v.invoice.paid_cents));
for (const t of job.trace) console.log('  ', t.op.padEnd(15), t.ok ? 'ok ' : 'ERR', String(t.ms).padStart(5), 'ms', t.detail);
const done = (st) => ['PAID', 'MARKED_AS_PAID'].includes(st);
process.exit(done(job.invoice.status) && done(v.invoice.status) ? 0 : 1);
