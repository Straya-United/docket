// Shared rendering for the docket (used by the tradie app and the customer page).
export const money = (c) => '$' + (c / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : String(kid));
  return n;
};
const UNIT = { hr: 'hr', each: 'ea', m: 'm', km: 'km', lot: 'lot' };
export const qty = (l) => `${Number(l.quantity).toLocaleString('en-AU', { maximumFractionDigits: 2 })} ${UNIT[l.unit] || l.unit}`;
export const when = (iso) => new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function stampsFor(status, payments = []) {
  const s = [];
  if (status === 'paid') s.push(['PAID IN FULL', '']);
  else if (payments.some((p) => p.kind === 'deposit')) s.push(['DEPOSIT PAID', '']);
  if (['booked', 'complete', 'paid'].includes(status)) s.push(['APPROVED', 'carbon']);
  return s;
}

export function docketHead(biz, ref, invoiceNo) {
  return el('div', { class: 'docket-head' },
    el('div', {}, el('div', { class: 'biz', text: biz.name }), el('div', { class: 'small', text: `${biz.location}${biz.licence ? `, ${biz.licence}` : ''}` })),
    el('div', { class: 'docket-no' }, `No. ${ref.replace(/^J/, '')}`, el('small', { text: invoiceNo ? `PayPal invoice #${invoiceNo}` : 'Quote' })));
}

export function linesTable(lines, { showWhy = false } = {}) {
  return el('table', { class: 'lines' },
    el('thead', {}, el('tr', {}, el('th', { text: 'Work and materials' }), el('th', { class: 'r', text: 'Qty' }), el('th', { class: 'r', text: 'Rate' }), el('th', { class: 'r', text: 'Amount' }))),
    el('tbody', {}, lines.map((l) => el('tr', {},
      el('td', {}, l.description, showWhy && l.reasoning ? el('span', { class: 'why', text: l.reasoning }) : null),
      el('td', { class: 'r', text: qty(l) }), el('td', { class: 'r', text: money(l.unit_cents) }), el('td', { class: 'r', text: money(l.total_cents) })))));
}

export function totalsBlock(t, deposit) {
  return el('div', { class: 'totals' },
    el('div', {}, el('span', { text: 'Subtotal' }), el('span', { text: money(t.subtotal_cents) })),
    el('div', {}, el('span', { text: 'GST 10%' }), el('span', { text: money(t.gst_cents) })),
    el('div', { class: 'grand' }, el('span', { text: 'Total' }), el('span', { text: money(t.total_cents) })),
    deposit ? el('div', { class: 'dep' }, el('span', { text: `Deposit to book (${deposit.percent}%)` }), el('span', { text: money(deposit.cents) })) : null);
}

export function notesGrid(q) {
  const list = (title, items) => items?.length ? el('div', {}, el('h3', { text: title }), el('ul', {}, items.map((i) => el('li', { text: i })))) : null;
  const a = list('This price assumes', q.assumptions), b = list('Not included', q.exclusions), c = list('To confirm', q.questions);
  return (a || b || c) ? el('div', { class: 'notes-grid' }, a, b, c) : null;
}

export function stampLayer(status, payments, landKey) {
  const layer = el('div', { class: 'stamps', 'aria-hidden': 'true' });
  for (const [text, cls] of stampsFor(status, payments)) {
    const s = el('div', { class: `rubber ${cls}`, text });
    if (landKey && landKey === text) s.classList.add('land');
    layer.append(s);
  }
  return layer;
}
