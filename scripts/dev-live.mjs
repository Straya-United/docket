// Run Docket locally against the real PayPal sandbox and OpenAI, reading keys from the secrets folder.
// Usage: node scripts/dev-live.mjs   (SECRETS_DIR overrides D:\GameDevelopment\.secrets)
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.SECRETS_DIR || 'D:/GameDevelopment/.secrets';
function load(file, keys) {
  const p = path.join(dir, file);
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('='); if (i < 1 || line.trim().startsWith('#')) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (keys.includes(k) && !process.env[k]) process.env[k] = v;
  }
}
load('paypal.env', ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']);
load('docket.env', ['OPENAI_API_KEY', 'OPENAI_MODEL']);
load('etsy-factory.env', ['OPENAI_API_KEY']);
for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'OPENAI_API_KEY']) if (!process.env[k]) { console.error(`Missing ${k}`); process.exit(1); }
process.env.HOST ||= '127.0.0.1';
await import('../server.mjs');
