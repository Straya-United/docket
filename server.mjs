// Docket web server: the tradie app, the customer quote page, and a JSON API.
// PayPal and the language model are only reached from here; keys never go to the browser.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as J from './src/jobs.mjs';
import { ask, confirm, publicAction } from './src/assistant.mjs';
import { paypalReady, clientId, isMock as paypalMock, CURRENCY } from './src/paypal.mjs';
import { llmMock } from './src/llm.mjs';
import { cleanRateCard } from './src/ratecard.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8791);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const AI_PER_IP_HOUR = Number(process.env.AI_PER_IP_HOUR || 30);
const AI_DAILY_CAP = Number(process.env.AI_DAILY_CAP || 400);

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.paypal.com https://www.sandbox.paypal.com",
  "frame-src https://www.paypal.com https://www.sandbox.paypal.com",
  "connect-src 'self' https://www.paypal.com https://www.sandbox.paypal.com https://*.paypal.com",
  "img-src 'self' data: https://*.paypal.com https://*.paypalobjects.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
function secure(res, req) {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=(self), payment=(self "https://www.paypal.com" "https://www.sandbox.paypal.com")');
  if (isHttps(req)) res.setHeader('strict-transport-security', 'max-age=15552000');
}
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';

// ---- limits ----
const hits = new Map();
function allow(key, max, windowMs = 3600_000) {
  const t = Date.now();
  const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (list.length >= max) return false;
  list.push(t); hits.set(key, list); return true;
}
let aiDay = { day: '', n: 0 };
function aiAllowed(ip) {
  const d = new Date().toISOString().slice(0, 10);
  if (aiDay.day !== d) aiDay = { day: d, n: 0 };
  if (aiDay.n >= AI_DAILY_CAP) return 'The demo has reached today\'s AI limit. Please try again tomorrow.';
  if (!allow(`ai:${ip}`, AI_PER_IP_HOUR)) return 'That\'s a lot of drafting from here this hour. Please try again later.';
  aiDay.n++; return null;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 3600_000)) hits.delete(k); }, 600_000).unref();

// ---- helpers ----
async function body(req, limit = 20000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Request too large.'), { code: 413, public: true }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Bad JSON.'), { code: 400, public: true }); }
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const ipOf = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'local';
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])); }
function wsFor(req, res) {
  const ws = J.workspace(cookies(req).dk_ws);
  if (cookies(req).dk_ws !== ws.id) res.setHeader('set-cookie', `dk_ws=${ws.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 86400}${isHttps(req) ? '; Secure' : ''}`);
  return ws;
}
// Browser POSTs must come from this site.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return false;
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; } }
  return true;
}
const stream = (res) => { res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }); return (ev) => res.write(JSON.stringify(ev) + '\n'); };
const publicMsg = (e) => (e.public ? e.message : /model error 429|rate/i.test(e.message) ? 'The AI is busy. Please try again in a minute.' : /model error/.test(e.message) ? 'The AI had a problem with that. Please try again.' : 'Something went wrong. Please try again.');

async function serveFile(res, file, cache = 'public, max-age=300') {
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': cache });
    res.end(data);
  } catch { json(res, 404, { error: 'not found' }); }
}

const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

// ---- tradie API ----
on('GET', '/api/health', async (req, res) => json(res, 200, { ok: true, paypal: await paypalReady(), llm: llmMock() ? 'mock' : process.env.OPENAI_API_KEY ? 'ok' : 'missing key' }));
on('GET', '/api/config', async (req, res) => json(res, 200, { paypal_client_id: clientId(), currency: CURRENCY, paypal_mock: paypalMock, llm_mock: llmMock() }));
on('GET', '/api/me', async (req, res) => {
  const ws = wsFor(req, res);
  json(res, 200, { business: ws.business, rate_card: ws.rateCard, jobs: [...ws.jobs.values()].reverse().map(J.jobCard), totals: J.totalsSummary(ws), actions: [...ws.actions.values()].filter((a) => a.status === 'proposed').map(publicAction) });
});
on('PUT', '/api/ratecard', async (req, res) => {
  const ws = wsFor(req, res);
  const b = await body(req, 40000);
  const rc = cleanRateCard(b.rate_card);
  if (!rc) return json(res, 400, { error: 'Each row needs a code, a name, a unit and a price.' });
  ws.rateCard = rc;
  if (b.deposit_percent !== undefined) ws.business.deposit_percent = Math.min(100, Math.max(0, Math.round(Number(b.deposit_percent) || 0)));
  json(res, 200, { rate_card: rc, business: ws.business });
});
on('POST', '/api/draft', async (req, res) => {
  const ws = wsFor(req, res);
  const notes = String((await body(req)).notes || '').trim().slice(0, 3000);
  if (notes.length < 15) return json(res, 400, { error: 'Tell me a bit more about the job first.' });
  const limited = aiAllowed(ipOf(req)); if (limited) return json(res, 429, { error: limited });
  const emit = stream(res);
  try { const job = await J.draftQuote(ws, notes, emit); emit({ step: 'done', job: J.jobDetail(job) }); }
  catch (e) { console.error('draft failed', e.message); emit({ step: 'error', error: publicMsg(e) }); }
  res.end();
});
on('GET', '/api/jobs/:id', async (req, res, p) => json(res, 200, { job: J.jobDetail(J.getJob(wsFor(req, res), p.id)) }));
on('PATCH', '/api/jobs/:id', async (req, res, p) => { const ws = wsFor(req, res); const job = J.updateDraft(ws, J.getJob(ws, p.id), await body(req, 40000)); json(res, 200, { job: J.jobDetail(job) }); });
on('DELETE', '/api/jobs/:id', async (req, res, p) => {
  const ws = wsFor(req, res); const job = J.getJob(ws, p.id);
  if (job.status !== 'draft') return json(res, 409, { error: 'Only unsent drafts can be deleted.' });
  ws.jobs.delete(job.id); json(res, 200, { ok: true });
});
on('POST', '/api/jobs/:id/send', async (req, res, p) => {
  const ws = wsFor(req, res);
  if (!allow(`pp:${ipOf(req)}`, 80)) return json(res, 429, { error: 'Too many PayPal requests from here. Try again later.' });
  json(res, 200, { job: J.jobDetail(await J.sendQuote(ws, J.getJob(ws, p.id))) });
});
on('POST', '/api/jobs/:id/refresh', async (req, res, p) => { const ws = wsFor(req, res); json(res, 200, { job: J.jobDetail(await J.refreshInvoices(J.getJob(ws, p.id))) }); });
on('POST', '/api/jobs/:id/complete', async (req, res, p) => { const ws = wsFor(req, res); const { note } = await body(req); json(res, 200, { job: J.jobDetail(await J.markComplete(ws, J.getJob(ws, p.id), String(note || ''))) }); });
on('POST', '/api/jobs/:id/remind', async (req, res, p) => {
  const ws = wsFor(req, res); const job = J.getJob(ws, p.id);
  const note = String((await body(req)).note || '').trim() || `Hi ${job.customer.name}, a friendly reminder that ${J.fmt(J.position(job).owing_cents)} is owing for ${job.quote.title}. Thanks!`;
  json(res, 200, { job: J.jobDetail(await J.sendReminder(ws, job, note)) });
});
on('POST', '/api/jobs/:id/variation', async (req, res, p) => {
  const ws = wsFor(req, res); const job = J.getJob(ws, p.id);
  const note = String((await body(req)).note || '').trim().slice(0, 800);
  if (note.length < 10) return json(res, 400, { error: 'Describe the extra work first.' });
  const limited = aiAllowed(ipOf(req)); if (limited) return json(res, 429, { error: limited });
  const proposed = [];
  const { tools } = await import('./src/assistant.mjs');
  const r = await tools(ws, proposed).find((t) => t.name === 'propose_variation').run({ job_ref: job.ref, description: note });
  if (r.error) return json(res, 422, { error: r.error });
  json(res, 200, { action: publicAction(proposed[0]) });
});
on('POST', '/api/assistant', async (req, res) => {
  const ws = wsFor(req, res);
  const message = String((await body(req)).message || '').trim().slice(0, 1000);
  if (!message) return json(res, 400, { error: 'Ask me something about your jobs.' });
  const limited = aiAllowed(ipOf(req)); if (limited) return json(res, 429, { error: limited });
  const emit = stream(res);
  try {
    const out = await ask(ws, message, (ev) => emit({ step: 'tool', name: ev.name, args: ev.args, ms: ev.ms, ok: !ev.result?.error }));
    emit({ step: 'done', ...out });
  } catch (e) { console.error('assistant failed', e.message); emit({ step: 'error', error: publicMsg(e) }); }
  res.end();
});
on('POST', '/api/actions/:id', async (req, res, p) => { const ws = wsFor(req, res); const { approve } = await body(req); json(res, 200, await confirm(ws, p.id, approve === true)); });

// ---- customer API ----
on('GET', '/api/q/:token', async (req, res, p) => { const { ws, job } = J.byToken(p.token); json(res, 200, J.customerView(ws, job)); });
on('POST', '/api/q/:token/order', async (req, res, p) => {
  if (!allow(`pp:${ipOf(req)}`, 80)) return json(res, 429, { error: 'Too many payment attempts. Try again later.' });
  const { ws, job } = J.byToken(p.token); const { kind } = await body(req);
  json(res, 200, await J.createOrder(ws, job, kind === 'balance' ? 'balance' : 'deposit'));
});
on('POST', '/api/q/:token/capture', async (req, res, p) => {
  const { ws, job } = J.byToken(p.token); const { order_id } = await body(req);
  await J.captureOrder(ws, job, String(order_id || ''));
  json(res, 200, J.customerView(ws, job));
});
on('POST', '/api/q/:token/variation', async (req, res, p) => {
  const { ws, job } = J.byToken(p.token); const { id, approve } = await body(req);
  await J.answerVariation(ws, job, String(id || ''), approve === true);
  json(res, 200, J.customerView(ws, job));
});

// ---- pages ----
on('GET', '/q/:token', async (req, res) => serveFile(res, path.join(PUBLIC, 'quote.html'), 'no-cache'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  secure(res, req);
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return json(res, 403, { error: 'Cross-site request blocked.' });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (m) return await r.fn(req, res, m.groups || {});
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'forbidden' });
    return serveFile(res, file, p.endsWith('.html') ? 'no-cache' : 'public, max-age=300');
  } catch (e) {
    if (!e.public) console.error(e);
    if (!res.headersSent) json(res, e.code && e.public ? e.code : 500, { error: publicMsg(e) });
    else res.end();
  }
});

server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Docket on http://localhost:${PORT}${paypalMock ? ' (PayPal mock)' : ''}${llmMock() ? ' (LLM mock)' : ''}`));
