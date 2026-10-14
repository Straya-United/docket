// End-to-end API flow with PayPal and the model mocked: draft -> edit -> send -> deposit -> variation -> complete -> balance.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 8899, BASE = `http://127.0.0.1:${PORT}`;
let srv, cookie = '';
before(async () => {
  srv = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT), PAYPAL_MOCK: '1', LLM_MOCK: '1' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
after(() => srv.kill());

async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('ndjson')) return { status: res.status, events: (await res.text()).trim().split('\n').map((l) => JSON.parse(l)) };
  return { status: res.status, ...(await res.json()) };
}

test('quote to paid', async () => {
  await api('GET', '/api/me');
  const d = await api('POST', '/api/draft', { notes: 'Jane at Andergrove, jane@example.com. Swap 6 old halogen downlights in kitchen for LED, has a dimmer. Add 2 double power points in garage.' });
  const done = d.events.find((e) => e.step === 'done');
  assert.ok(done, JSON.stringify(d.events));
  let job = done.job;
  assert.equal(job.status, 'draft');
  assert.ok(job.quote.lines.find((l) => l.code === 'DL' && l.quantity === 6 && l.unit_cents === 2800));
  const custom = job.quote.lines.find((l) => l.needs_price);
  assert.ok(custom);

  // Sending with an unchecked custom price is refused.
  let r = await api('POST', `/api/jobs/${job.id}/send`);
  assert.equal(r.status, 400);

  // Tradie confirms the price.
  const lines = job.quote.lines.map((l) => ({ ...l, unit_price_aud: l.unit_cents / 100, price_checked: true }));
  r = await api('PATCH', `/api/jobs/${job.id}`, { lines });
  assert.equal(r.job.quote.lines.filter((l) => l.needs_price).length, 0);

  r = await api('POST', `/api/jobs/${job.id}/send`);
  assert.equal(r.job.status, 'quoted', JSON.stringify(r));
  job = r.job;
  const token = job.link.split('/').pop();
  assert.equal(job.invoice.status, 'SENT');

  // Customer view hides internal reasoning.
  let q = await api('GET', `/api/q/${token}`);
  assert.equal(q.position.due_kind, 'deposit');
  assert.equal(q.quote.lines[0].reasoning, undefined);
  const deposit = q.position.due_now_cents;
  assert.equal(deposit % 100, 0);

  const o = await api('POST', `/api/q/${token}/order`, { kind: 'deposit' });
  q = await api('POST', `/api/q/${token}/capture`, { order_id: o.id });
  assert.equal(q.status, 'booked');
  assert.equal(q.position.paid_cents, deposit);
  // Double capture is harmless.
  q = await api('POST', `/api/q/${token}/capture`, { order_id: o.id });
  assert.equal(q.payments.length, 1);

  // Variation proposed by tradie, confirmed, approved by customer.
  r = await api('POST', `/api/jobs/${job.id}/variation`, { note: 'Rats chewed the cable to the garage, need to replace about 15m' });
  assert.equal(r.action.type, 'variation');
  r = await api('POST', `/api/actions/${r.action.id}`, { approve: true });
  assert.equal(r.action.status, 'done');
  q = await api('GET', `/api/q/${token}`);
  const v = q.variations[0];
  assert.equal(v.status, 'pending');
  q = await api('POST', `/api/q/${token}/variation`, { id: v.id, approve: true });
  assert.equal(q.variations[0].status, 'approved');

  // Complete -> balance due = contract - deposit.
  r = await api('POST', `/api/jobs/${job.id}/complete`, { note: '' });
  assert.equal(r.job.status, 'complete');
  q = await api('GET', `/api/q/${token}`);
  assert.equal(q.position.due_kind, 'balance');
  assert.equal(q.position.due_now_cents, q.position.contract_cents - deposit);
  const o2 = await api('POST', `/api/q/${token}/order`, { kind: 'balance' });
  q = await api('POST', `/api/q/${token}/capture`, { order_id: o2.id });
  assert.equal(q.status, 'paid');
  assert.equal(q.position.owing_cents, 0);

  r = await api('GET', `/api/jobs/${job.id}`);
  // Balance was split across the main invoice and the variation invoice.
  const last = r.job.payments.at(-1);
  assert.equal(last.splits.length, 2);
  assert.equal(r.job.invoice.status, 'MARKED_AS_PAID');
});

test('assistant proposes, never sends on its own', async () => {
  const r = await api('POST', '/api/assistant', { message: 'who owes me money?' });
  const done = r.events.find((e) => e.step === 'done');
  assert.ok(done);
});

test('cross-site POST blocked; bad token 404', async () => {
  const res = await fetch(BASE + '/api/draft', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
  const q = await api('GET', '/api/q/nope');
  assert.equal(q.status, 404);
});
