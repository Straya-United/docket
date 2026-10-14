// "Ask Docket": a function-calling agent over the tradie's jobs and their PayPal invoices.
// Read tools run straight away. Anything that contacts a customer or changes money becomes a
// proposed action card; it only runs when the tradie taps Confirm.
import { randomUUID } from 'node:crypto';
import { llmAgent } from './llm.mjs';
import { findJob, jobCard, position, refreshInvoices, draftVariation, addVariation, markComplete, sendReminder, fmt, totalsSummary } from './jobs.mjs';

const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const ref = { type: 'string', description: 'Job reference like J1041.' };

const daysSince = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86400000);
function brief(job) {
  const c = jobCard(job);
  const sent = job.events.find((e) => /Invoice #/.test(e.text));
  return {
    ref: c.ref, title: c.title, customer: c.customer.name, status: c.status,
    total: fmt(c.total_cents), paid: fmt(c.paid_cents), owing: fmt(c.owing_cents), due_now: fmt(position(job).due_now_cents),
    paypal_invoice: c.invoice ? `#${c.invoice.number} ${c.invoice.status}` : 'not sent',
    days_since_sent: sent ? daysSince(sent.at) : null, pending_variations: c.pending_variations,
  };
}

function propose(ws, type, job, summary, payload) {
  const a = { id: randomUUID(), type, job_id: job.id, ref: job.ref, summary, payload, status: 'proposed', at: new Date().toISOString() };
  ws.actions.set(a.id, a);
  return a;
}

export function tools(ws, proposed) {
  return [
    {
      name: 'list_jobs', description: 'List every job with status, totals and who owes what. Statuses: draft (not sent), quoted (sent, waiting for deposit), booked (deposit paid, work underway), complete (balance requested), paid.',
      parameters: obj({}), run: async () => ({ jobs: [...ws.jobs.values()].map(brief), totals: Object.fromEntries(Object.entries(totalsSummary(ws)).map(([k, v]) => [k.replace('_cents', ''), fmt(v)])) }),
    },
    {
      name: 'check_paypal', description: 'Fetch the live PayPal invoice status (paid, partially paid, due) for one job.',
      parameters: obj({ job_ref: ref }),
      run: async ({ job_ref }) => {
        const job = findJob(ws, job_ref); if (!job) return { error: 'no such job' };
        if (!job.invoice) return { ref: job.ref, note: 'Not sent to PayPal yet (draft).' };
        await refreshInvoices(job);
        return { ref: job.ref, invoice: job.invoice.number, paypal_status: job.invoice.status, paypal_paid: fmt(job.invoice.paid_cents), paypal_due: fmt(job.invoice.due_cents), variations: job.variations.map((v) => ({ n: v.n, status: v.status, invoice: v.invoice ? `#${v.invoice.number} ${v.invoice.status}` : null })), payments: job.payments.map((p) => ({ kind: p.kind, amount: fmt(p.cents), capture: p.capture_id, at: p.at })) };
      },
    },
    {
      name: 'propose_reminder', description: 'Propose sending the customer a PayPal payment reminder. Write the note in the tradie\'s friendly voice, short, mentioning the amount owing. Does NOT send; the tradie confirms.',
      parameters: obj({ job_ref: ref, note: { type: 'string', description: 'Reminder note to the customer, under 400 characters.' } }),
      run: async ({ job_ref, note }) => {
        const job = findJob(ws, job_ref); if (!job) return { error: 'no such job' };
        const pos = position(job);
        if (!job.invoice || pos.owing_cents <= 0) return { error: 'Nothing owing on this job.' };
        const a = propose(ws, 'reminder', job, `Send ${job.customer.name} a PayPal reminder for ${fmt(pos.due_now_cents || pos.owing_cents)}`, { note: note.slice(0, 600) });
        proposed.push(a); return { proposed: a.id, waiting_for: 'tradie to tap Confirm' };
      },
    },
    {
      name: 'propose_variation', description: 'Draft and price a variation (extra work found on a booked job) from the tradie\'s description. Does NOT send; the tradie confirms, then the customer approves on their quote page.',
      parameters: obj({ job_ref: ref, description: { type: 'string', description: 'The extra work in the tradie\'s words.' } }),
      run: async ({ job_ref, description }) => {
        const job = findJob(ws, job_ref); if (!job) return { error: 'no such job' };
        let d;
        try { d = await draftVariation(ws, job, description.slice(0, 800)); } catch (e) { return { error: e.message }; }
        const a = propose(ws, 'variation', job, `Send ${job.customer.name} variation "${d.title}" for ${fmt(d.totals.total_cents)} inc GST`, d);
        proposed.push(a);
        return { proposed: a.id, title: d.title, lines: d.lines.map((l) => `${l.quantity} ${l.unit} ${l.description} ${fmt(l.total_cents)}${l.needs_price ? ' (check price)' : ''}`), total_inc_gst: fmt(d.totals.total_cents) };
      },
    },
    {
      name: 'propose_complete', description: 'Propose marking a booked job complete, which asks the customer (via PayPal) for the balance. Does NOT run until the tradie confirms.',
      parameters: obj({ job_ref: ref, note: { type: 'string', description: 'Short thank-you note to the customer with the balance amount.' } }),
      run: async ({ job_ref, note }) => {
        const job = findJob(ws, job_ref); if (!job) return { error: 'no such job' };
        if (job.status !== 'booked') return { error: `Job is ${job.status}, not booked.` };
        const pos = position(job);
        const a = propose(ws, 'complete', job, `Mark ${job.ref} complete and request the ${fmt(pos.owing_cents)} balance from ${job.customer.name}`, { note: note.slice(0, 600) });
        proposed.push(a); return { proposed: a.id, balance: fmt(pos.owing_cents) };
      },
    },
  ];
}

const SYSTEM = (ws) => `You are Docket, the back-office offsider for ${ws.business.name} (${ws.business.trade}, ${ws.business.location}).
You help the tradie keep jobs moving from quote to paid. Money goes through PayPal invoices and checkout.
- Use tools to look things up; never guess amounts or statuses.
- You cannot send anything yourself. propose_* tools create a card the tradie must confirm. After proposing, say what the card will do and that it needs their OK. Never say it was sent.
- Be brief and practical, Australian English, dollar amounts inc GST. Use job refs like J1041.
- Plain text only: no markdown, no asterisks or headings. Short lines; start a line with "- " for a list.
- For quoted jobs the customer owes the deposit (due_now) to book; the rest is due on completion. Drafts aren't owed yet.
- If asked to do something outside these tools (e.g. refunds, new quotes), say how to do it in the app instead.
- Today is ${new Date().toISOString().slice(0, 10)}.`;

export async function ask(ws, message, onEvent) {
  const proposed = [];
  const history = ws.chat.slice(-8);
  const reply = await llmAgent({
    system: SYSTEM(ws), history, user: message, tools: tools(ws, proposed), onEvent,
    mock: async ({ tools: t, onEvent: ev }) => {
      const run = async (name, args) => { const tool = t.find((x) => x.name === name); const r = await tool.run(args); ev?.({ type: 'tool', name, args, result: r, ms: 1 }); return r; };
      const list = await run('list_jobs', {});
      const owing = list.jobs.filter((j) => j.status === 'complete' || j.status === 'quoted');
      if (/remind|chase|owe/i.test(message) && owing[0]) {
        await run('propose_reminder', { job_ref: owing[0].ref, note: `Hi ${owing[0].customer}, just a friendly reminder that ${owing[0].owing} is still owing. Cheers!` });
        return `${owing[0].ref} for ${owing[0].customer} still owes ${owing[0].owing}. I've drafted a PayPal reminder; tap Confirm to send it.`;
      }
      return `You have ${list.jobs.length} jobs. Owing: ${list.totals.owing}. Waiting on approval: ${list.totals.awaiting_approval}.`;
    },
  });
  ws.chat.push({ role: 'user', content: message.slice(0, 1000) }, { role: 'assistant', content: reply.slice(0, 2000) });
  if (ws.chat.length > 20) ws.chat.splice(0, ws.chat.length - 20);
  return { reply, actions: proposed.map(publicAction) };
}

export const publicAction = (a) => ({ id: a.id, type: a.type, ref: a.ref, summary: a.summary, status: a.status, preview: a.type === 'variation' ? { title: a.payload.title, reason: a.payload.reason, lines: a.payload.lines, totals: a.payload.totals } : { note: a.payload.note } });

export async function confirm(ws, actionId, approve) {
  const a = ws.actions.get(actionId);
  if (!a || a.status !== 'proposed') throw Object.assign(new Error('That action has already been handled.'), { code: 409, public: true });
  const job = ws.jobs.get(a.job_id);
  if (!approve) { a.status = 'cancelled'; return { action: publicAction(a) }; }
  if (a.type === 'reminder') await sendReminder(ws, job, a.payload.note);
  else if (a.type === 'complete') await markComplete(ws, job, a.payload.note);
  else if (a.type === 'variation') addVariation(job, a.payload);
  a.status = 'done';
  return { action: publicAction(a), job: jobCard(job) };
}
