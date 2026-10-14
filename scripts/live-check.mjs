// Live API check against a running Docket (default http://127.0.0.1:8791): real model + real PayPal sandbox.
// Drafts each sample job, sends one as a PayPal invoice, asks the assistant. Payments need a browser (buyer approval).
const BASE = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'http://127.0.0.1:8791';
let cookie = '';
async function api(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  if ((res.headers.get('content-type') || '').includes('ndjson')) return (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  const j = await res.json(); if (!res.ok) throw new Error(`${p}: ${j.error}`); return j;
}
const SAMPLES = [
  'Jane Citizen, jane@example.com, Andergrove. Swap 6 old halogen downlights in the kitchen for LED, she has a dimmer on them. Add 2 double power points in the garage on the back wall. Easy roof access.',
  'Mr and Mrs Nguyen, nguyen.family@example.com, Glenella. Rental going on the market, need 240V interconnected smoke alarms to meet QLD rules: 3 bedrooms, hallway and living room. Existing old 9V alarms to come out. Two-storey.',
  'Dave, dave.p@example.com, Eimeo. Install 3 ceiling fans he has bought himself in the bedrooms, existing light points. Plus a weatherproof double power point out on the deck for the bbq. About 40 km from the shop.',
];
console.log('health', await api('GET', '/api/health'));
await api('GET', '/api/me');
let first;
for (const notes of SAMPLES) {
  const t0 = Date.now();
  const ev = await api('POST', '/api/draft', { notes });
  const done = ev.find((e) => e.step === 'done'); const err = ev.find((e) => e.step === 'error');
  if (!done) { console.log('DRAFT FAILED', err?.error); continue; }
  const j = done.job; first ||= j;
  console.log(`\n${j.ref} ${j.quote.title} | ${j.customer.name} <${j.customer.email}> ${j.customer.site_address} | ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const l of j.quote.lines) console.log(`  ${l.code.padEnd(7)} ${String(l.quantity).padStart(5)} ${l.unit.padEnd(4)} ${(l.total_cents / 100).toFixed(2).padStart(8)}  ${l.description}${l.needs_price ? '  [CHECK PRICE]' : ''}  // ${l.reasoning}`);
  if (j.quote.dropped.length) console.log('  dropped:', JSON.stringify(j.quote.dropped));
  console.log(`  total $${(j.quote.totals.total_cents / 100).toFixed(2)} deposit $${(j.quote.deposit_cents / 100).toFixed(2)}`);
  console.log('  assumptions:', j.quote.assumptions.join(' | '));
  console.log('  exclusions:', j.quote.exclusions.join(' | '));
  console.log('  questions:', j.quote.questions.join(' | '));
}
if (process.argv.includes('--send') && first) {
  const lines = first.quote.lines.map((l) => ({ ...l, unit_price_aud: l.unit_cents / 100, price_checked: true }));
  await api('PATCH', `/api/jobs/${first.id}`, { lines });
  const s = await api('POST', `/api/jobs/${first.id}/send`);
  console.log('\nSENT', s.job.ref, s.job.invoice, '\n  customer page:', BASE + s.job.link);
  for (const t of s.job.trace) console.log('  paypal', t.op, t.ok, t.ms, t.detail);
}
const a = await api('POST', '/api/assistant', { message: 'Who still owes me money, and is anything waiting on the customer?' });
for (const e of a) console.log('assistant', e.step, e.name || '', e.reply || e.error || '', e.actions ? JSON.stringify(e.actions.map((x) => x.summary)) : '');
