// PayPal keeps handing out a cached access token (with the app's old scopes) until it expires.
// After ticking a new app feature such as Invoicing, end that token so the next one includes the new scope.
// Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from the environment, or from paypal.env in SECRETS_DIR.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const file = path.join(process.env.SECRETS_DIR || 'D:/GameDevelopment/.secrets', 'paypal.env');
if (existsSync(file)) for (const l of readFileSync(file, 'utf8').split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0 && !process.env[l.slice(0, i).trim()]) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
const B = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
const basic = 'Basic ' + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
const get = async () => (await fetch(`${B}/v1/oauth2/token`, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })).json();
const a = await get();
console.log('before: invoicing scope', /invoicing/.test(a.scope || ''));
const t = await fetch(`${B}/v1/oauth2/token/terminate`, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(a.access_token)}&token_type_hint=ACCESS_TOKEN` });
console.log('terminate', t.status);
const b = await get();
console.log('after: invoicing scope', /invoicing/.test(b.scope || ''));
