// Turns the model's line picks into a priced quote. All arithmetic happens here, in cents.
import { UNITS } from './ratecard.mjs';

export const GST_RATE = 0.1;
export const cents = (aud) => Math.round(Number(aud) * 100);
export const aud = (c) => (c / 100).toFixed(2);

function cleanQty(q, unit) {
  let n = Number(q);
  if (!Number.isFinite(n) || n <= 0) return null;
  n = Math.min(n, 1000);
  // Hours to the quarter hour, metres and km to one decimal, everything else whole.
  if (unit === 'hr') return Math.max(0.25, Math.round(n * 4) / 4);
  if (unit === 'm' || unit === 'km') return Math.round(n * 10) / 10;
  return Math.max(1, Math.round(n));
}

// lines: [{code, description, quantity, unit, custom_unit_price_aud, reasoning}]
// Returns { lines, dropped, totals }. Rate-card codes always use the card price and unit.
export function priceLines(rawLines, rateCard) {
  const byCode = new Map(rateCard.map((r) => [r.code, r]));
  const lines = [];
  const dropped = [];
  for (const raw of Array.isArray(rawLines) ? rawLines.slice(0, 40) : []) {
    const code = String(raw?.code || '').toUpperCase();
    const card = byCode.get(code);
    let unit, unitCents, needsPrice = false, name;
    if (card) {
      unit = card.unit; unitCents = cents(card.price); name = card.name;
    } else if (code === 'CUSTOM') {
      unit = UNITS.includes(raw?.unit) ? raw.unit : 'each';
      const p = Number(raw?.custom_unit_price_aud);
      if (!(p >= 0 && p <= 50000)) { dropped.push({ ...raw, why: 'no usable price' }); continue; }
      unitCents = cents(p); needsPrice = true; name = 'Not in price book';
    } else { dropped.push({ ...raw, why: `unknown code ${code}` }); continue; }
    const qty = cleanQty(raw?.quantity, unit);
    if (qty === null) { dropped.push({ ...raw, why: 'bad quantity' }); continue; }
    const description = String(raw?.description || name).trim().slice(0, 140) || name;
    lines.push({
      code: card ? code : 'CUSTOM', description, quantity: qty, unit,
      unit_cents: unitCents, total_cents: Math.round(unitCents * qty),
      needs_price: needsPrice, reasoning: String(raw?.reasoning || '').slice(0, 200),
    });
  }
  return { lines, dropped, totals: totalsOf(lines) };
}

export function totalsOf(lines, gst = true) {
  const subtotal = lines.reduce((s, l) => s + l.total_cents, 0);
  // GST per line, rounded per line, the way PayPal invoices compute item tax.
  const gstCents = gst ? lines.reduce((s, l) => s + Math.round(l.total_cents * GST_RATE), 0) : 0;
  return { subtotal_cents: subtotal, gst_cents: gstCents, total_cents: subtotal + gstCents };
}

// Deposit rounded to whole dollars, never more than the total.
export function depositOf(totalCents, percent) {
  const p = Math.min(100, Math.max(0, Number(percent) || 0));
  return Math.min(totalCents, Math.round((totalCents * p) / 100 / 100) * 100);
}

// Re-price a list of lines the tradie edited in the browser (description, qty, unit price may change).
export function repriceEdited(edited, rateCard) {
  const byCode = new Map(rateCard.map((r) => [r.code, r]));
  const lines = [];
  for (const e of Array.isArray(edited) ? edited.slice(0, 40) : []) {
    const card = byCode.get(String(e?.code || '').toUpperCase());
    const unit = card ? card.unit : UNITS.includes(e?.unit) ? e.unit : 'each';
    const qty = cleanQty(e?.quantity, unit);
    const unitCents = cents(e?.unit_price_aud);
    if (qty === null || !(unitCents >= 0 && unitCents <= 5000000)) continue;
    const description = String(e?.description || '').trim().slice(0, 140);
    if (!description) continue;
    lines.push({
      code: card ? card.code : 'CUSTOM', description, quantity: qty, unit, unit_cents: unitCents,
      total_cents: Math.round(unitCents * qty),
      needs_price: Boolean(e?.needs_price) && !e?.price_checked,
      reasoning: String(e?.reasoning || '').slice(0, 200),
    });
  }
  return { lines, totals: totalsOf(lines) };
}
