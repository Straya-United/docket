// Docket tradie app.
import { money, el, qty, when, docketHead, linesTable, totalsBlock, notesGrid, stampLayer } from './docket.js';

const $ = (s) => document.querySelector(s);
const state = { me: null, job: null, sel: null };
const STATUS = { draft: 'Draft', quoted: 'Waiting on deposit', booked: 'Booked', complete: 'Balance due', paid: 'Paid' };
const UNITS = ['hr', 'each', 'm', 'km', 'lot'];

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'That didn\'t work. Try again.');
  return j;
}
async function readStream(res, onEvent) {
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'That didn\'t work. Try again.'); }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onEvent(JSON.parse(line)); }
  }
}

// ---------- workspace ----------
async function loadMe() {
  state.me = await api('GET', '/api/me');
  const { totals, jobs, business } = state.me;
  $('#bizName').textContent = business.name;
  $('#tOwing').textContent = money(totals.owing_cents);
  $('#tWaiting').textContent = money(totals.awaiting_approval_cents);
  $('#tPaid').textContent = money(totals.paid_cents);
  const list = $('#jobs'); list.replaceChildren();
  if (!jobs.length) list.append(el('li', { class: 'empty', text: 'No jobs yet. Draft one above, or tap an example.' }));
  for (const j of jobs) {
    list.append(el('li', {}, el('button', { type: 'button', 'aria-current': j.id === state.sel ? 'true' : 'false', onclick: () => openJob(j.id) },
      el('span', { class: 'ref', text: j.ref }), el('span', { class: 'who', text: j.customer.name || 'No name yet' }),
      el('span', { class: 'amt', text: j.owing_cents && j.status !== 'draft' && j.status !== 'quoted' ? `${money(j.owing_cents)} owing` : money(j.total_cents) }),
      el('span', { class: 'what' }, el('span', { class: `pill ${j.status}`, text: STATUS[j.status] + (j.pending_variations ? ' + variation' : '') }), ' ', j.title))));
  }
  renderPriceBook();
}

// ---------- drafting ----------
const steps = $('#steps');
function step(text, cls = 'active') { steps.querySelectorAll('li.active').forEach((li) => { li.className = 'done'; }); const li = el('li', { class: cls, text }); steps.append(li); return li; }
document.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => { $('#notes').value = b.dataset.ex; $('#notes').focus(); }));

$('#draftForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const notes = $('#notes').value.trim();
  if (notes.length < 15) { $('#notes').focus(); return; }
  stopMic();
  const btn = $('#draftBtn'); btn.disabled = true; btn.textContent = 'Drafting…';
  steps.replaceChildren();
  try {
    const res = await fetch('/api/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes }) });
    await readStream(res, (ev) => {
      if (ev.step === 'thinking') step(ev.text);
      else if (ev.step === 'model') step(`AI picked ${ev.lines} lines in ${(ev.ms / 1000).toFixed(1)} s`, 'done');
      else if (ev.step === 'priced') step(ev.text, 'done');
      else if (ev.step === 'done') { step('Quote ready to check', 'done'); state.sel = ev.job.id; state.job = ev.job; renderJob(); loadMe(); }
      else if (ev.step === 'error') throw new Error(ev.error);
    });
  } catch (err) { step(err.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Draft the quote'; }
});

// Dictation (Chrome / Edge / Safari).
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function stopMic() { if (rec) { rec.stop(); rec = null; $('#mic').setAttribute('aria-pressed', 'false'); } }
if (!SR) $('#mic').hidden = true;
$('#mic').addEventListener('click', () => {
  if (rec) return stopMic();
  rec = new SR(); rec.lang = 'en-AU'; rec.continuous = true; rec.interimResults = true;
  const base = $('#notes').value ? $('#notes').value.trimEnd() + ' ' : '';
  rec.onresult = (e) => { let t = ''; for (const r of e.results) t += r[0].transcript; $('#notes').value = base + t; };
  rec.onend = () => stopMic();
  rec.onerror = () => stopMic();
  rec.start(); $('#mic').setAttribute('aria-pressed', 'true');
});

let toastTimer;
function toast(text, err = false) { const t = $('#toast'); t.textContent = text; t.className = err ? 'toast err' : 'toast'; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000); }

// ---------- job view ----------
async function openJob(id) {
  state.sel = id;
  state.job = (await api('GET', `/api/jobs/${id}`)).job;
  renderJob(); loadMe();
  if (matchMedia('(max-width: 900px)').matches) $('#jobView').scrollIntoView({ behavior: 'smooth' });
}

function renderJob(land) {
  const j = state.job; const v = $('#jobView'); v.replaceChildren();
  if (!j) return;
  const biz = state.me?.business || { name: '', location: '' };
  if (j.status === 'draft') return v.append(draftEditor(j, biz));
  const d = el('article', { class: 'docket' }, docketHead(biz, j.ref, j.invoice?.number));
  d.append(el('h2', { text: j.quote.title }), el('div', { class: 'for', text: `For ${j.customer.name}${j.customer.site_address ? `, ${j.customer.site_address}` : ''} (${j.customer.email})` }));
  d.append(el('p', { text: j.quote.summary }), linesTable(j.quote.lines, { showWhy: true }), el('div', { class: 'settle' }, stampLayer(j.status, j.payments, land), totalsBlock(j.quote.totals, { percent: j.quote.deposit_percent, cents: j.quote.deposit_cents })));
  for (const vr of j.variations) {
    d.append(el('div', { class: 'var' }, el('h3', { text: `Variation V${vr.n}: ${vr.title} (${vr.status === 'pending' ? 'waiting on customer' : vr.status})` }), el('p', { class: 'small', text: vr.reason }), linesTable(vr.lines, { showWhy: true }), totalsBlock(vr.totals)));
  }
  const n = notesGrid(j.quote); if (n) d.append(n);
  v.append(d, jobPanel(j));
}

function jobPanel(j) {
  const p = j.position;
  const link = location.origin + j.link;
  const panel = el('div', { class: 'panel stack', style: 'margin-top:20px' });
  panel.append(el('div', { class: 'row', style: 'justify-content:space-between' },
    el('h3', { text: `${STATUS[j.status]}: ${money(p.paid_cents)} paid of ${money(p.contract_cents)}` }),
    el('span', { class: `pill ${j.status}`, text: j.invoice ? `PayPal ${j.invoice.status.replace(/_/g, ' ').toLowerCase()}` : '' })));
  panel.append(el('div', { class: 'linkbox' }, el('code', { text: link }),
    el('button', { class: 'btn small ghost', type: 'button', onclick: async (e) => { await navigator.clipboard?.writeText(link).catch(() => {}); e.target.textContent = 'Copied'; } }, 'Copy'),
    el('a', { class: 'btn small', href: j.link, target: '_blank', rel: 'noopener' }, 'Open customer page')));
  if (j.invoice?.payer_link) panel.append(el('p', { class: 'small muted' }, 'PayPal also emailed the invoice. ', el('a', { href: j.invoice.payer_link, target: '_blank', rel: 'noopener' }, `View invoice #${j.invoice.number} on PayPal`), '.'));

  const msg = el('p', { class: 'small', 'aria-live': 'polite' });
  const run = async (btn, fn, ok) => { btn.disabled = true; msg.className = 'small'; msg.textContent = 'Working…'; try { await fn(); msg.textContent = ''; toast(ok); } catch (e) { msg.className = 'err-msg small'; msg.textContent = e.message; } finally { btn.disabled = false; } };
  const acts = el('div', { class: 'actions' });
  if (j.status === 'booked' || j.status === 'quoted') {
    const varBox = el('div', { class: 'stack', hidden: true, style: 'width:100%' },
      el('label', { for: 'varNote', text: 'What extra work did you find?' }),
      el('textarea', { id: 'varNote', style: 'min-height:80px', placeholder: 'e.g. Rats have chewed the cable to the garage, need to replace about 15 m.' }));
    const go = el('button', { class: 'btn primary', type: 'button', text: 'Draft variation' });
    go.addEventListener('click', () => run(go, async () => {
      const r = await api('POST', `/api/jobs/${j.id}/variation`, { note: $('#varNote').value });
      chatCard(r.action); $('#askH').scrollIntoView({ behavior: 'smooth' });
    }, 'Variation drafted. Check it under Ask Docket and confirm to send it.'));
    varBox.append(go);
    acts.append(el('button', { class: 'btn ghost', type: 'button', onclick: () => { varBox.hidden = !varBox.hidden; } }, 'Add a variation'));
    if (j.status === 'booked') {
      const done = el('button', { class: 'btn stamp', type: 'button', text: `Job done: request ${money(p.owing_cents)}` });
      done.addEventListener('click', () => run(done, async () => { state.job = (await api('POST', `/api/jobs/${j.id}/complete`, {})).job; renderJob(); loadMe(); }, 'Balance requested through PayPal.'));
      acts.append(done);
    }
    panel.append(acts, varBox);
  } else panel.append(acts);
  if (['quoted', 'complete'].includes(j.status)) {
    const rem = el('button', { class: 'btn ghost', type: 'button', text: 'Send PayPal reminder' });
    rem.addEventListener('click', () => run(rem, async () => { state.job = (await api('POST', `/api/jobs/${j.id}/remind`, {})).job; renderJob(); }, 'Reminder sent through PayPal.'));
    acts.append(rem);
  }
  const ref = el('button', { class: 'btn ghost', type: 'button', text: 'Refresh from PayPal' });
  ref.addEventListener('click', () => run(ref, async () => { state.job = (await api('POST', `/api/jobs/${j.id}/refresh`)).job; renderJob(); loadMe(); }, 'Up to date with PayPal.'));
  acts.append(ref);
  panel.append(msg);

  panel.append(el('h3', { text: 'What happened' }), el('ol', { class: 'timeline' }, [...j.events].reverse().map((e) => el('li', {}, el('time', { datetime: e.at, text: when(e.at) }), el('span', {}, el('span', { class: `who-${e.who}`, text: { paypal: 'PayPal', customer: 'Customer', tradie: 'You', docket: 'Docket' }[e.who] + ': ' }), e.text)))));
  panel.append(el('details', { class: 'trace' }, el('summary', { text: `PayPal API calls (${j.trace.length})` }),
    el('ol', {}, j.trace.map((t) => el('li', { class: t.ok ? '' : 'fail' }, el('b', { text: t.op }), ` ${t.ok ? 'ok' : 'failed'}${t.ms ? `, ${t.ms} ms` : ''}: ${t.detail}${t.debug_id ? ` (debug ${t.debug_id})` : ''}`)))));
  return panel;
}

// ---------- draft editor ----------
function draftEditor(j, biz) {
  const wrap = el('div');
  const d = el('article', { class: 'docket' }, docketHead(biz, j.ref, null));
  const f = (id, label, val, type = 'text') => el('div', {}, el('label', { for: id, text: label }), el('input', { id, type, value: val || '' }));
  d.append(el('div', { style: 'margin-top:16px' }, el('label', { for: 'qTitle', class: 'sr', text: 'Job title' }), el('input', { id: 'qTitle', class: 'title-in', value: j.quote.title })));
  d.append(el('div', { class: 'fields', style: 'margin-top:10px' }, f('cName', 'Customer', j.customer.name), f('cEmail', 'Email (PayPal sends the invoice here)', j.customer.email, 'email'), f('cSite', 'Site', j.customer.site_address)));
  d.append(el('div', { style: 'margin-top:10px' }, el('label', { for: 'qSum', text: 'What the customer reads' }), el('textarea', { id: 'qSum', style: 'min-height:70px' }, j.quote.summary)));

  const tbody = el('tbody');
  const table = el('table', { class: 'lines' }, el('thead', {}, el('tr', {}, el('th', { text: 'Work and materials' }), el('th', { class: 'r', text: 'Qty' }), el('th', { class: 'r', text: 'Rate ex GST' }), el('th', { class: 'r', text: 'Amount' }), el('th', {}))), tbody);
  const tpl = $('#lineTpl');
  const rows = j.quote.lines.map((l) => ({ ...l, unit_price_aud: l.unit_cents / 100 }));
  const totalsHost = el('div');
  function recalc() {
    let sub = 0, gst = 0;
    tbody.querySelectorAll('tr').forEach((tr, i) => {
      const r = rows[i]; const c = Math.round(Number(r.unit_price_aud) * 100 * Number(r.quantity));
      tr.querySelector('.t').textContent = money(c || 0); sub += c || 0; gst += Math.round((c || 0) * 0.1);
    });
    const total = sub + gst; const pct = j.quote.deposit_percent; const dep = Math.min(total, Math.round(total * pct / 100 / 100) * 100);
    totalsHost.replaceChildren(totalsBlock({ subtotal_cents: sub, gst_cents: gst, total_cents: total }, { percent: pct, cents: dep }));
  }
  function drawRows() {
    tbody.replaceChildren();
    rows.forEach((r, i) => {
      const tr = tpl.content.firstElementChild.cloneNode(true);
      const d1 = tr.querySelector('.d'), q = tr.querySelector('.q'), p = tr.querySelector('.p');
      d1.value = r.description; q.value = r.quantity; p.value = Number(r.unit_price_aud).toFixed(2);
      tr.querySelector('.u').textContent = r.unit === 'each' ? 'ea' : r.unit;
      tr.querySelector('.why').textContent = r.reasoning ? `AI: ${r.reasoning}` : '';
      if (r.needs_price && !r.price_checked) {
        const flag = el('button', { type: 'button', class: 'flag', title: 'Not in your price book. Check the rate, then tap.' }, 'Check price');
        flag.addEventListener('click', () => { r.price_checked = true; flag.remove(); });
        tr.querySelector('td').append(el('br'), flag);
      }
      if (r.code !== 'CUSTOM') p.readOnly = false;
      d1.addEventListener('input', () => { r.description = d1.value; });
      q.addEventListener('input', () => { r.quantity = q.value; recalc(); });
      p.addEventListener('input', () => { r.unit_price_aud = p.value; r.price_checked = true; recalc(); });
      tr.querySelector('.x').addEventListener('click', () => { rows.splice(i, 1); drawRows(); });
      tbody.append(tr);
    });
    recalc();
  }
  drawRows();
  const addSel = el('select', { 'aria-label': 'Add an item from your price book' }, el('option', { value: '', text: 'Add from price book…' }), (state.me?.rate_card || []).map((r) => el('option', { value: r.code, text: `${r.name} ($${r.price.toFixed(2)}/${r.unit})` })));
  addSel.addEventListener('change', () => { const r = state.me.rate_card.find((x) => x.code === addSel.value); if (r) { rows.push({ code: r.code, description: r.name, quantity: 1, unit: r.unit, unit_price_aud: r.price, reasoning: '' }); drawRows(); } addSel.value = ''; });
  d.append(table, el('div', { style: 'max-width:340px; margin:8px 0 14px' }, addSel), totalsHost);
  const n = notesGrid(j.quote); if (n) d.append(n);
  if (j.quote.dropped?.length) d.append(el('p', { class: 'small', style: 'margin-top:12px' }, `Left out ${j.quote.dropped.length} line(s) the AI suggested that weren't in your price book without a usable price.`));
  wrap.append(d);

  const msg = el('p', { class: 'small', 'aria-live': 'polite' });
  const payload = () => ({ title: $('#qTitle').value, summary: $('#qSum').value, customer: { name: $('#cName').value, email: $('#cEmail').value, site_address: $('#cSite').value }, lines: rows.map((r) => ({ ...r, unit_price_aud: Number(r.unit_price_aud) })) });
  const send = el('button', { class: 'btn primary', type: 'button', text: 'Send quote via PayPal' });
  send.addEventListener('click', async () => {
    send.disabled = true; msg.className = 'small'; msg.textContent = 'Creating the PayPal invoice…';
    try {
      await api('PATCH', `/api/jobs/${j.id}`, payload());
      state.job = (await api('POST', `/api/jobs/${j.id}/send`)).job; renderJob(); loadMe();
    } catch (e) { msg.className = 'err-msg small'; msg.textContent = e.message; send.disabled = false; }
  });
  const save = el('button', { class: 'btn ghost', type: 'button', text: 'Save draft' });
  save.addEventListener('click', async () => { try { state.job = (await api('PATCH', `/api/jobs/${j.id}`, payload())).job; msg.className = 'ok-msg small'; msg.textContent = 'Saved.'; loadMe(); } catch (e) { msg.className = 'err-msg small'; msg.textContent = e.message; } });
  const del = el('button', { class: 'btn ghost', type: 'button', text: 'Delete draft' });
  del.addEventListener('click', async () => { await api('DELETE', `/api/jobs/${j.id}`); state.job = null; state.sel = null; $('#jobView').replaceChildren(); loadMe(); });
  wrap.append(el('div', { class: 'panel', style: 'margin-top:20px' }, el('p', { class: 'small muted', text: 'Check the lines, then send. PayPal creates the invoice and emails it; your customer approves and pays the deposit from the link.' }), el('div', { class: 'actions' }, send, save, del), msg));
  return wrap;
}

// ---------- price book ----------
function renderPriceBook() {
  const body = $('#rcBody'); if (body.dataset.dirty === '1') return;
  body.replaceChildren();
  $('#depPct').value = state.me.business.deposit_percent;
  for (const r of state.me.rate_card) body.append(rcRow(r));
}
function rcRow(r = { code: '', name: '', unit: 'each', price: 0 }) {
  const tr = el('tr', {},
    el('td', { class: 'c' }, el('input', { value: r.code, 'aria-label': 'Code', 'data-k': 'code' })),
    el('td', {}, el('input', { value: r.name, 'aria-label': 'Item', 'data-k': 'name' })),
    el('td', { class: 'u' }, el('select', { 'aria-label': 'Unit', 'data-k': 'unit' }, UNITS.map((u) => el('option', { value: u, text: u, selected: u === r.unit })))),
    el('td', { class: 'p' }, el('input', { type: 'number', step: '0.01', min: '0', value: r.price, 'aria-label': 'Price ex GST', 'data-k': 'price' })));
  tr.addEventListener('input', () => { $('#rcBody').dataset.dirty = '1'; });
  return tr;
}
$('#rcAdd').addEventListener('click', () => { $('#rcBody').append(rcRow()); $('#rcBody').dataset.dirty = '1'; });
$('#rcSave').addEventListener('click', async () => {
  const rows = [...$('#rcBody').querySelectorAll('tr')].map((tr) => Object.fromEntries([...tr.querySelectorAll('[data-k]')].map((i) => [i.dataset.k, i.value])));
  try {
    await api('PUT', '/api/ratecard', { rate_card: rows, deposit_percent: Number($('#depPct').value) });
    $('#rcBody').dataset.dirty = ''; $('#rcMsg').className = 'ok-msg small'; $('#rcMsg').textContent = 'Saved.'; loadMe();
  } catch (e) { $('#rcMsg').className = 'err-msg small'; $('#rcMsg').textContent = e.message; }
});

// ---------- Ask Docket ----------
const chat = $('#chat');
const TOOL = { list_jobs: 'Looked at your jobs', check_paypal: 'Checked PayPal', propose_reminder: 'Drafted a reminder', propose_variation: 'Drafted a variation', propose_complete: 'Drafted a completion' };
function say(text, who) { const m = el('div', { class: `msg ${who}`, text }); chat.append(m); chat.scrollTop = chat.scrollHeight; return m; }
function chatCard(a) {
  const c = el('div', { class: 'card' }, el('p', {}, el('strong', { text: a.summary })));
  if (a.preview?.note) c.append(el('p', { class: 'note', text: a.preview.note }));
  if (a.preview?.lines) {
    c.append(el('p', { class: 'small', text: a.preview.reason }), el('ul', {}, a.preview.lines.map((l) => el('li', { text: `${qty(l)} ${l.description}: ${money(l.total_cents)}${l.needs_price ? ' (check price)' : ''}` }))), el('p', {}, el('strong', { text: `Total ${money(a.preview.totals.total_cents)} inc GST` })));
  }
  const yes = el('button', { class: 'btn primary small', type: 'button', text: a.type === 'variation' ? 'Confirm: send to customer' : a.type === 'complete' ? 'Confirm: request balance' : 'Confirm: send reminder' });
  const no = el('button', { class: 'btn ghost small', type: 'button', text: 'Cancel' });
  const out = el('span', { class: 'small', 'aria-live': 'polite' });
  const answer = async (approve) => {
    yes.disabled = no.disabled = true;
    try {
      await api('POST', `/api/actions/${a.id}`, { approve });
      c.classList.add('done'); out.className = approve ? 'ok-msg small' : 'small muted'; out.textContent = approve ? 'Done.' : 'Cancelled.';
      yes.remove(); no.remove(); await loadMe(); if (state.sel) openJob(state.sel);
    } catch (e) { out.className = 'err-msg small'; out.textContent = e.message; yes.disabled = no.disabled = false; }
  };
  yes.addEventListener('click', () => answer(true)); no.addEventListener('click', () => answer(false));
  c.append(el('div', { class: 'row' }, yes, no, out));
  chat.append(c); chat.scrollTop = chat.scrollHeight;
}
async function ask(text) {
  say(text, 'me');
  const btn = $('#askBtn'); btn.disabled = true;
  const thinking = el('div', { class: 'toolline', text: 'Thinking…' }); chat.append(thinking);
  try {
    const res = await fetch('/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text }) });
    await readStream(res, (ev) => {
      if (ev.step === 'tool') chat.insertBefore(el('div', { class: 'toolline' }, el('b', { text: TOOL[ev.name] || ev.name }), ev.args?.job_ref ? ` ${ev.args.job_ref}` : '', ev.ok ? '' : ' (no luck)'), thinking);
      else if (ev.step === 'done') { thinking.remove(); say(ev.reply, 'bot'); ev.actions.forEach(chatCard); }
      else if (ev.step === 'error') throw new Error(ev.error);
    });
  } catch (e) { thinking.remove(); say(e.message, 'bot'); }
  finally { btn.disabled = false; }
}
$('#askForm').addEventListener('submit', (e) => { e.preventDefault(); const t = $('#askIn').value.trim(); if (!t) return; $('#askIn').value = ''; ask(t); });
document.querySelectorAll('[data-ask]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.ask)));

// Refresh when the tab regains focus (the customer may have paid in another tab).
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadMe(); if (state.sel) openJob(state.sel).catch(() => {}); } });

loadMe().then(() => { for (const a of state.me.actions) chatCard(a); }).catch((e) => step(e.message, 'err'));
