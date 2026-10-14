// Records the hackathon demo video: drives the real app (live OpenAI + PayPal sandbox) in Chrome,
// pays with PayPal's sandbox guest card checkout, narrates with Microsoft neural TTS (edge-tts),
// trims the AI waits and composites the PayPal popup over the page. Output: video/docket-demo.mp4
// Usage (Windows, Playwright + Chrome + python edge-tts + imageio-ffmpeg):
//   set DEMO_CARD=... & set DEMO_EXPIRY=MMYY & node scripts/record-demo.mjs
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { guestCardPay } from './paypal-guest-pay.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const PORT = 8799, BASE = `http://127.0.0.1:${PORT}`;
const W = 1440, H = 810;
const OUT = path.resolve('video'), AUD = path.join(OUT, 'audio');
fs.mkdirSync(AUD, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.webm')) fs.rmSync(path.join(OUT, f));
const FFMPEG = spawnSync('python', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const durationMs = (f) => { const m = spawnSync(FFMPEG, ['-i', f], { encoding: 'utf8' }).stderr.match(/Duration: (\d+):(\d+):([\d.]+)/); return Math.round(((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000); };
let n = 0;
function tts(text) {
  const file = path.join(AUD, `${String(++n).padStart(2, '0')}.mp3`);
  const spoken = text.replace(/GST/g, 'G S T').replace(/MIT/g, 'M I T');
  const r = spawnSync('python', ['-m', 'edge_tts', '--voice', 'en-AU-WilliamMultilingualNeural', '--rate=+4%', '--text', spoken, '--write-media', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('tts failed: ' + r.stderr);
  return { file, ms: durationMs(file), text };
}
const LINES = {
  open: 'Tradies quote on the back of a docket, then lose their evenings typing it up and chasing deposits. Docket goes from the ute to paid, with PayPal and AI.',
  notes: 'The sparky dictates the job on site. Docket reads it against his own price book.',
  draft: 'The AI picks the items and estimates the labour, and shows its working on every line. It never sets a price: the server prices each line from the book, with GST. Anything not in the book is flagged to check.',
  send: 'One tap creates a PayPal invoice, with the thirty percent deposit as the minimum payment, and a link for the customer.',
  customer: 'The customer sees the quote as a docket, including what the price assumes and what is not included.',
  pay: 'They approve, and pay the deposit with PayPal Checkout. This is the PayPal sandbox, with a test card.',
  booked: 'Docket captures the order and records it against the PayPal invoice. Deposit paid, and booked in.',
  variation: 'On the day, rats have chewed the cable to the garage. The tradie says so, and the AI prices a variation from the same book.',
  confirm: 'Nothing reaches the customer until the tradie confirms.',
  approve: 'The customer approves the extra work, and Docket raises a separate PayPal invoice for it.',
  done: 'Job done. One tap, and PayPal sends the customer a reminder for the balance.',
  balance: 'The balance covers the job and the variation, and is split across both PayPal invoices.',
  paid: 'Paid in full.',
  ask: 'Ask Docket is an agent with tools over the jobs and live PayPal status. It finds who still owes money, and drafts a friendly reminder, for the tradie to confirm.',
  trace: 'Every PayPal call is on the record.',
  close: 'Docket. From the ute to paid, with PayPal. Open source, under the MIT licence.',
};
console.log('rendering narration');
const clip = Object.fromEntries(Object.entries(LINES).map(([k, v]) => [k, tts(v)]));

const INIT = `(() => {
  const css = '#demoCap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);max-width:980px;padding:12px 22px;border-radius:10px;background:rgba(32,35,39,.9);color:#F7F7F4;font:500 19px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.35);z-index:99999;opacity:0;transition:opacity .25s;pointer-events:none}#demoCap.on{opacity:1}#demoNote{position:fixed;right:14px;bottom:6px;font:12px system-ui,sans-serif;color:#5D6168;z-index:99999;pointer-events:none}';
  const add = () => { if (document.getElementById('demoCap')) return; const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    const c = document.createElement('div'); c.id = 'demoCap'; document.body.appendChild(c);
    const t = document.createElement('div'); t.id = 'demoNote'; t.textContent = 'PayPal sandbox, live API calls. Notes typed in for the demo. AI waits shortened in editing.'; document.body.appendChild(t); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', add) : add();
})();`;

const srv = spawn(process.execPath, ['scripts/dev-live.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' });
await sleep(2000);
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: W, height: H } } });
await ctx.addInitScript(INIT);
const p = await ctx.newPage();
const t0 = Date.now(); const audio = []; const cuts = []; const pops = [];

// Seed one earlier job that's still waiting on its deposit, so Ask Docket has someone to chase.
await p.goto(BASE);
{
  const r = await p.request.post(`${BASE}/api/draft`, { data: { notes: 'Mr and Mrs Nguyen, nguyen.family@example.com, Glenella. Rental going on the market, need 240V interconnected smoke alarms: 3 bedrooms, hallway and living room. Old 9V alarms to come out.' } });
  const job = (await r.text()).trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.step === 'done').job;
  await p.request.patch(`${BASE}/api/jobs/${job.id}`, { data: { lines: job.quote.lines.map((l) => ({ ...l, unit_price_aud: l.unit_cents / 100, price_checked: true })) } });
  await p.request.post(`${BASE}/api/jobs/${job.id}/send`);
}
await p.goto(BASE, { waitUntil: 'networkidle' });
await sleep(1200);
const tStart = Date.now() - t0;

const cap = (t) => p.evaluate((x) => { const c = document.getElementById('demoCap'); if (c) { c.textContent = x || ''; c.classList.toggle('on', !!x); } }, t).catch(() => {});
async function say(key, extra = 300) { const c = clip[key]; await cap(c.text); audio.push({ file: c.file, at: Date.now() - t0 }); await sleep(c.ms + extra); await cap(''); }
async function sayWhile(key, action) { const c = clip[key]; await cap(c.text); audio.push({ file: c.file, at: Date.now() - t0 }); const s = Date.now(); await action(); const left = c.ms - (Date.now() - s); if (left > 0) await sleep(left + 300); await cap(''); }
const cutFrom = () => Date.now() - t0;
const cutTo = (from) => cuts.push({ from: from + 1200, to: Date.now() - t0 - 300 });
const smooth = (sel) => p.locator(sel).first().evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' })).catch(() => {});
async function pay() {
  const card = { card: process.env.DEMO_CARD, expiry: process.env.DEMO_EXPIRY };
  await p.locator('#paypal-buttons').scrollIntoViewIfNeeded(); await sleep(800);
  let start;
  await guestCardPay(p, { slow: 35, card, onPopup: () => { start = Date.now() - t0; } });
  pops.push({ start, end: Date.now() - t0 });
  await p.waitForSelector('.rubber.land', { timeout: 30000 });
  await sleep(600);
}

// 1. Open and dictate
await say('open', 400);
await sayWhile('notes', async () => {
  await p.locator('#notes').click();
  await p.locator('#notes').pressSequentially('Jane Citizen, jane@example.com, Andergrove. Swap 6 old halogen downlights in the kitchen for LED, she has a dimmer. Add 2 double power points in the garage on the back wall.', { delay: 12 });
});
await p.locator('#draftBtn').click();
let from = cutFrom();
await p.waitForSelector('#qTitle', { timeout: 90000 });
cutTo(from);
await sleep(600);
await sayWhile('draft', async () => {
  await sleep(1800); await p.mouse.wheel(0, 300); await sleep(2200); await p.mouse.wheel(0, 350); await sleep(1500);
  for (const f of await p.locator('.flag').all()) { await f.scrollIntoViewIfNeeded(); await sleep(700); await f.click(); }
});
// 2. Send via PayPal
await sayWhile('send', async () => {
  const btn = p.getByRole('button', { name: 'Send quote via PayPal' });
  await btn.scrollIntoViewIfNeeded(); await sleep(600); await btn.click();
  await p.waitForSelector('.linkbox', { timeout: 60000 });
  await sleep(500); await smooth('.linkbox');
});
const link = await p.locator('.linkbox code').textContent();
const tradieUrl = BASE + '/';
// 3. Customer view + deposit
await p.goto(link, { waitUntil: 'networkidle' });
await sleep(500);
await sayWhile('customer', async () => { await sleep(1500); await p.mouse.wheel(0, 380); await sleep(2200); await p.mouse.wheel(0, 380); });
const payClip = clip.pay; await cap(payClip.text); audio.push({ file: payClip.file, at: Date.now() - t0 });
await pay();
await cap('');
await p.locator('.docket').scrollIntoViewIfNeeded();
await smooth('.settle'); await sleep(400);
await say('booked', 400);
// 4. Variation
await p.goto(tradieUrl, { waitUntil: 'networkidle' }); await sleep(600);
await p.locator('.jobs button').first().click(); await sleep(900);
await sayWhile('variation', async () => {
  await p.getByRole('button', { name: 'Add a variation' }).click(); await sleep(500);
  await p.locator('#varNote').pressSequentially('Rats have chewed the cable to the garage, need to replace about 15 m of it.', { delay: 14 });
  await sleep(300);
});
await p.getByRole('button', { name: 'Draft variation' }).click();
from = cutFrom();
await p.waitForSelector('.card button.primary', { timeout: 90000 });
cutTo(from);
await p.locator('.card').last().scrollIntoViewIfNeeded(); await sleep(400);
await sayWhile('confirm', async () => { await sleep(1800); await p.locator('.card button.primary').last().click(); await p.waitForSelector('.card.done', { timeout: 60000 }); });
await p.goto(link, { waitUntil: 'networkidle' }); await sleep(500);
await smooth('.var'); await sleep(800);
await sayWhile('approve', async () => {
  await sleep(1500);
  await p.getByRole('button', { name: /Approve the extra/ }).click();
  await p.waitForSelector('text=You approved this variation', { timeout: 60000 });
  await smooth('.var'); await sleep(800);
});
// 5. Job done -> balance
await p.goto(tradieUrl, { waitUntil: 'networkidle' }); await sleep(500);
await p.locator('.jobs button').first().click(); await sleep(900);
await sayWhile('done', async () => {
  const btn = p.locator('button.stamp'); await btn.scrollIntoViewIfNeeded(); await sleep(1000); await btn.click();
  await p.waitForSelector('#toast:not([hidden])', { timeout: 60000 });
});
await p.goto(link, { waitUntil: 'networkidle' }); await sleep(400);
const balClip = clip.balance; await cap(balClip.text); audio.push({ file: balClip.file, at: Date.now() - t0 });
await pay();
await cap('');
await smooth('.settle'); await sleep(300);
await say('paid', 900);
// 6. Ask Docket
await p.goto(tradieUrl, { waitUntil: 'networkidle' }); await sleep(500);
await p.locator('#askIn').scrollIntoViewIfNeeded();
await p.locator('#askIn').pressSequentially('Who still owes me money? Chase them.', { delay: 25 });
await p.locator('#askBtn').click();
from = cutFrom();
await p.waitForSelector('.card:not(.done) button.primary', { timeout: 90000 });
cutTo(from);
await p.locator('.card').last().scrollIntoViewIfNeeded();
await sayWhile('ask', async () => { await sleep(4000); await p.locator('.card:not(.done) button.primary').last().click(); await p.waitForSelector('.card.done', { timeout: 60000 }); });
// 7. Trace + close
await p.locator('.jobs button').nth(1).click().catch(() => {}); await sleep(800);
await sayWhile('trace', async () => { const d = p.locator('details.trace'); await d.scrollIntoViewIfNeeded(); await d.locator('summary').click(); await sleep(400); await smooth('details.trace'); });
await say('close', 1400);
const tEnd = Date.now() - t0;

const raw = await p.video().path();
await ctx.close();
await b.close(); srv.kill();
// Popup videos: every .webm in OUT that isn't the main one, in creation order.
const others = fs.readdirSync(OUT).filter((f) => f.endsWith('.webm') && path.join(OUT, f) !== raw).map((f) => path.join(OUT, f)).sort((a, c) => fs.statSync(a).mtimeMs - fs.statSync(c).mtimeMs);
console.log('popups', pops, others.length);
fs.writeFileSync(path.join(OUT, 'timings.json'), JSON.stringify({ raw, others, tStart, tEnd, cuts, audio, pops }, null, 1));

// ---- edit ----
const keeps = []; let cursor = tStart;
for (const c of cuts.filter((c) => c.to > c.from)) { keeps.push([cursor, c.from]); cursor = c.to; }
keeps.push([cursor, tEnd]);
const shift = (at) => at - tStart - cuts.filter((c) => c.to <= at).reduce((a, c) => a + (c.to - c.from), 0);
const total = keeps.reduce((a, [s, e]) => a + (e - s), 0);
const S = 1080 / H;
const outFile = path.join(OUT, 'docket-demo.mp4');
const inputs = ['-i', raw];
const usePops = pops.slice(0, others.length).map((x, i) => ({ ...x, file: others[i] }));
usePops.forEach((x) => inputs.push('-i', x.file));
const aBase = 1 + usePops.length;
audio.forEach((a) => inputs.push('-i', a.file));
const f = [];
keeps.forEach(([s, e], i) => f.push(`[0:v]trim=start=${(s / 1000).toFixed(3)}:end=${(e / 1000).toFixed(3)},setpts=PTS-STARTPTS[v${i}]`));
f.push(`${keeps.map((_, i) => `[v${i}]`).join('')}concat=n=${keeps.length}:v=1:a=0,scale=1920:1080:flags=lanczos[base0]`);
usePops.forEach((x, i) => {
  const st = (shift(x.start) / 1000).toFixed(3), en = (shift(x.end) / 1000).toFixed(3);
  // Popup pages are recorded unscaled in the top-left corner of the W x H frame.
  f.push(`[${i + 1}:v]crop=568:750:0:0,scale=-2:1000,setpts=PTS-STARTPTS+${st}/TB[p${i}]`);
  f.push(`[base${i}]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.45:t=fill:enable='between(t,${st},${en})'[d${i}]`);
  f.push(`[d${i}][p${i}]overlay=x=(W-w)/2:y=40:eof_action=pass:enable='between(t,${st},${en})'[base${i + 1}]`);
});
const vOut = `base${usePops.length}`;
audio.forEach((x, i) => { const d = Math.max(0, Math.round(shift(x.at))); f.push(`[${aBase + i}:a]adelay=${d}|${d}[a${i}]`); });
f.push(`${audio.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audio.length}:normalize=0:duration=longest,apad[aout]`);
const r = spawnSync(FFMPEG, ['-y', ...inputs, '-filter_complex', f.join(';'), '-map', `[${vOut}]`, '-map', '[aout]', '-t', (total / 1000).toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outFile], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr.slice(-2500)); process.exit(1); }
console.log(`video: ${outFile} ${(total / 1000).toFixed(1)} s (raw ${((tEnd - tStart) / 1000).toFixed(1)} s, ${cuts.length} waits trimmed, ${usePops.length} popups)`);
