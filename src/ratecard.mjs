// The tradie's price book. Prices are sell prices in AUD, excluding GST.
// The model may only pick items by code; the server prices every line from here.
export const UNITS = ['hr', 'each', 'm', 'km', 'lot'];

export const DEMO_BUSINESS = {
  name: 'Bright Spark Electrical (demo)',
  trade: 'electrician',
  location: 'Mackay QLD',
  licence: 'Demo licence 00000',
  deposit_percent: 30,
  gst_registered: true,
};

export const DEMO_RATE_CARD = [
  { code: 'LAB', name: 'Electrician labour', unit: 'hr', price: 98 },
  { code: 'APP', name: 'Apprentice labour', unit: 'hr', price: 55 },
  { code: 'CALL', name: 'Call-out fee', unit: 'each', price: 85 },
  { code: 'TRAV', name: 'Travel beyond 15 km', unit: 'km', price: 1.2 },
  { code: 'DL', name: 'LED downlight 10W tri-colour, supply', unit: 'each', price: 28 },
  { code: 'GPO', name: 'Double power point (GPO), supply', unit: 'each', price: 16 },
  { code: 'GPOWP', name: 'Weatherproof double power point, supply', unit: 'each', price: 42 },
  { code: 'SW', name: 'Light switch, supply', unit: 'each', price: 12 },
  { code: 'SMOKE', name: '240V interconnected smoke alarm, supply', unit: 'each', price: 89 },
  { code: 'FANINST', name: 'Ceiling fan install (customer-supplied fan)', unit: 'each', price: 145 },
  { code: 'RCBO', name: 'RCBO safety switch, supply', unit: 'each', price: 72 },
  { code: 'CABLE', name: 'TPS cable 2.5 mm², supply', unit: 'm', price: 3.2 },
  { code: 'CONDUIT', name: 'Conduit and fittings', unit: 'm', price: 4.5 },
  { code: 'SUND', name: 'Sundries (clips, connectors, fixings)', unit: 'lot', price: 25 },
  { code: 'DISP', name: 'Removal and disposal of old fittings', unit: 'lot', price: 30 },
  { code: 'CERT', name: 'Testing and electrical safety certificate', unit: 'lot', price: 45 },
];

// Accept an edited rate card from the browser, keeping only sane rows.
export function cleanRateCard(rows) {
  if (!Array.isArray(rows)) return null;
  const seen = new Set();
  const out = [];
  for (const r of rows.slice(0, 60)) {
    const code = String(r?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    const name = String(r?.name || '').trim().slice(0, 80);
    const unit = UNITS.includes(r?.unit) ? r.unit : null;
    const price = Math.round(Number(r?.price) * 100) / 100;
    if (!code || code === 'CUSTOM' || seen.has(code) || !name || !unit || !(price >= 0 && price <= 100000)) continue;
    seen.add(code);
    out.push({ code, name, unit, price });
  }
  return out.length ? out : null;
}
