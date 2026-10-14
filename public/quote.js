// Customer quote page: read the quote, approve variations, pay with PayPal.
import { money, el, when, docketHead, linesTable, totalsBlock, notesGrid, stampLayer } from './docket.js';

const token = location.pathname.split('/').pop();
const $ = (s) => document.querySelector(s);
let cfg = null, q = null, sdk = null;

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'That didn\'t work. Please try again.');
  return j;
}

function loadSdk() {
  if (sdk) return sdk;
  sdk = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.paypal_client_id)}&currency=${cfg.currency}&intent=capture&components=buttons&enable-funding=card&buyer-country=AU&locale=en_AU`;
    s.onload = () => resolve(window.paypal); s.onerror = () => reject(new Error('PayPal checkout could not load. Check your connection and refresh.'));
    document.head.append(s);
  });
  return sdk;
}

function render(land) {
  document.title = `${q.quote.title}: quote from ${q.business.name}`;
  const d = el('article', { class: 'docket' }, docketHead(q.business, q.ref, q.invoice?.number));
  d.append(el('h2', { text: q.quote.title }), el('div', { class: 'for', text: `For ${q.customer.name}${q.customer.site_address ? `, ${q.customer.site_address}` : ''}` }));
  d.append(el('p', { text: q.quote.summary }), linesTable(q.quote.lines), el('div', { class: 'settle' }, stampLayer(q.status, q.payments, land), totalsBlock(q.quote.totals, { percent: q.quote.deposit_percent, cents: q.quote.deposit_cents })));
  const n = notesGrid(q.quote); if (n) d.append(n);
  for (const v of q.variations) d.append(variationBlock(v));
  $('#docket').replaceChildren(d);
  renderPay();
  renderHistory();
}

function variationBlock(v) {
  const box = el('div', { class: 'var' }, el('h3', { text: `Variation V${v.n}: ${v.title}` }), el('p', { text: v.reason }), linesTable(v.lines), totalsBlock(v.totals));
  if (v.status === 'pending') {
    const msg = el('p', { class: 'small', 'aria-live': 'polite' });
    const yes = el('button', { class: 'btn primary', type: 'button', text: `Approve the extra ${money(v.totals.total_cents)}` });
    const no = el('button', { class: 'btn ghost', type: 'button', text: 'Decline' });
    const answer = async (approve) => {
      yes.disabled = no.disabled = true; msg.textContent = approve ? 'Adding it to your PayPal invoice…' : '';
      try { q = await api('POST', `/api/q/${token}/variation`, { id: v.id, approve }); render(); }
      catch (e) { msg.className = 'err-msg small'; msg.textContent = e.message; yes.disabled = no.disabled = false; }
    };
    yes.addEventListener('click', () => answer(true)); no.addEventListener('click', () => answer(false));
    box.append(el('p', { class: 'small muted', text: 'Approving adds this to the job. You pay it with the balance when the work is done.' }), el('div', { class: 'row' }, yes, no), msg);
  } else box.append(el('p', {}, el('strong', { text: v.status === 'approved' ? 'You approved this variation.' : 'You declined this variation.' })));
  return box;
}

async function renderPay() {
  const pay = $('#pay'); pay.hidden = false; pay.replaceChildren();
  const p = q.position;
  if (q.status === 'paid') { pay.append(el('h2', { text: 'All paid. Thank you!' }), el('p', { text: `${money(p.paid_cents)} received through PayPal.` })); return; }
  if (!p.due_kind) {
    pay.append(el('h2', { text: q.status === 'booked' ? 'You\'re booked in' : 'Nothing to pay right now' }),
      el('p', { text: q.status === 'booked' ? `Deposit received. ${q.business.name} will ask for the balance of ${money(p.owing_cents)} when the job is done.` : 'Check back soon.' }));
    if (q.variations.some((v) => v.status === 'pending')) pay.append(el('p', {}, el('strong', { text: 'There is a variation above waiting for your answer.' })));
    return;
  }
  const deposit = p.due_kind === 'deposit';
  pay.append(el('h2', { text: deposit ? 'Approve and pay the deposit' : 'Job done: pay the balance' }),
    el('div', { class: 'big', text: money(p.due_now_cents) }),
    el('p', { class: 'muted', text: deposit ? `${q.quote.deposit_percent}% of ${money(p.contract_cents)} secures your booking. The rest is due when the job's finished.` : `${money(p.contract_cents)} total including any approved variations, less ${money(p.paid_cents)} already paid.` }));
  const holder = el('div', { id: 'paypal-buttons' }); const msg = el('p', { class: 'small', 'aria-live': 'polite' });
  pay.append(holder, msg, el('div', { class: 'sandbox-note' }, 'Demo: this is PayPal\'s sandbox. Log in with a PayPal sandbox buyer account, or choose card and use a sandbox test card. Nothing real is charged.'));
  const createOrder = async () => (await api('POST', `/api/q/${token}/order`, { kind: p.due_kind })).id;
  const onApprove = async (orderId) => {
    msg.className = 'small'; msg.textContent = 'Confirming with PayPal…';
    q = await api('POST', `/api/q/${token}/capture`, { order_id: orderId });
    render(deposit ? 'DEPOSIT PAID' : 'PAID IN FULL');
    $('#docket').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  if (cfg.paypal_mock) {
    const b = el('button', { class: 'btn primary block', type: 'button', text: `Pay ${money(p.due_now_cents)} with PayPal (mock)` });
    b.addEventListener('click', async () => { b.disabled = true; try { await onApprove(await createOrder()); } catch (e) { msg.className = 'err-msg small'; msg.textContent = e.message; b.disabled = false; } });
    holder.append(b); return;
  }
  try {
    const paypal = await loadSdk();
    await paypal.Buttons({
      style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'pay' },
      createOrder,
      onApprove: async (data) => { try { await onApprove(data.orderID); } catch (e) { msg.className = 'err-msg small'; msg.textContent = e.message; } },
      onCancel: () => { msg.className = 'small muted'; msg.textContent = 'Payment cancelled. Nothing was charged.'; },
      onError: (e) => { msg.className = 'err-msg small'; msg.textContent = 'PayPal hit a problem. Please try again.'; console.error(e); },
    }).render(holder);
  } catch (e) { msg.className = 'err-msg small'; msg.textContent = e.message; }
}

function renderHistory() {
  const h = $('#history');
  const items = [...q.events].reverse();
  if (!items.length) { h.hidden = true; return; }
  h.hidden = false;
  h.replaceChildren(el('h3', { text: 'History' }), el('ol', { class: 'timeline' }, items.map((e) => el('li', {}, el('time', { datetime: e.at, text: when(e.at) }), el('span', { text: e.text })))));
  if (q.invoice?.payer_link) h.append(el('p', { class: 'small', style: 'margin-top:10px' }, el('a', { href: q.invoice.payer_link, target: '_blank', rel: 'noopener' }, `See PayPal invoice #${q.invoice.number}`)));
}

(async () => {
  try {
    [cfg, q] = await Promise.all([api('GET', '/api/config'), api('GET', `/api/q/${token}`)]);
    render();
  } catch (e) { $('#docket').replaceChildren(el('div', { class: 'panel' }, el('h2', { text: 'Quote not found' }), el('p', { text: e.message }))); }
})();
