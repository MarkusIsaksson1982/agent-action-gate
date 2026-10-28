// Frontend (strict TypeScript, compiled by tsc, no framework): sends sample agent proposals through the gate, lets a human
// approve or deny pending ones, shows the hash-chained audit log, and pushes consent-aware tracking events + Core Web Vitals.
type Kind = 'execute' | 'needs_approval' | 'reject' | 'duplicate';
interface Proposal { id: string; agent: string; role: string; tool: string; args: Record<string, unknown>; rationale: string; idempotencyKey: string }
interface AuditEvent { seq: number; proposalId: string; tool: string; kind: Kind; codes: string[]; hash: string }

const $ = <T extends HTMLElement>(id: string): T => { const el = document.getElementById(id); if (!el) throw new Error(`#${id} missing`); return el as T; };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const api = async (path: string, body?: unknown): Promise<unknown> => {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
let n = 0;
const SAMPLES: Omit<Proposal, 'id' | 'idempotencyKey'>[] = [
  { agent: 'seo-bot', role: 'seo_agent', tool: 'update_meta', rationale: 'title missing primary keyword',
    args: { pageId: 'P0042', title: 'Hybrid web development in Stockholm', description: 'We build fast, measurable websites with WordPress, TypeScript and clean tracking from day one.' } },
  { agent: 'growth-bot', role: 'growth_agent', tool: 'set_ad_budget', rationale: 'campaign CPA below target', args: { campaignId: 'CMP-007', dailySek: 2500 } },
  { agent: 'growth-bot', role: 'growth_agent', tool: 'set_ad_budget', rationale: 'scale winning campaign', args: { campaignId: 'CMP-007', dailySek: 25000 } },
  { agent: 'content-bot', role: 'content_agent', tool: 'save_cms_draft', rationale: 'publish now', args: { postId: 'WP-311', status: 'publish', body: 'Hello' } },
];

const consent = (): { analytics: boolean } => ({ analytics: $<HTMLInputElement>('consent').checked });
export async function track(event: string, params: Record<string, unknown> = {}): Promise<void> {
  const r = await api('/api/track', { event, params, consent: consent() }) as { accepted: boolean; issues: { code: string }[] };
  $('track-log').textContent = `${event}: ${r.accepted ? 'accepted' : r.issues.map((i) => i.code).join(', ')}`;
}

async function refresh(): Promise<void> {
  const audit = await api('/api/audit') as { events: AuditEvent[]; intact: boolean };
  $('audit').innerHTML = audit.events.map((e) => `<tr><td>${e.seq}</td><td>${esc(e.tool)}</td><td class="${e.kind}">${e.kind}</td><td>${esc(e.codes.join(', '))}</td><td><code>${e.hash.slice(0, 10)}</code></td></tr>`).join('');
  $('chain').textContent = audit.intact ? 'audit chain intact' : 'AUDIT CHAIN BROKEN';
  const pending = await api('/api/pending') as Proposal[];
  $('pending').innerHTML = pending.map((p) => `<li>${esc(p.tool)} ${esc(JSON.stringify(p.args))} <button data-id="${esc(p.id)}" data-ok="1">approve</button><button data-id="${esc(p.id)}" data-ok="0">deny</button></li>`).join('') || '<li>none</li>';
}

async function propose(i: number): Promise<void> {
  const s = SAMPLES[i]; if (!s) return; n++;
  const r = await api('/api/proposals', { ...s, id: `ui-${n}`, idempotencyKey: `ui-${n}` }) as { kind: Kind; errors: { code: string; field?: string }[] };
  $('last').textContent = `${s.tool}: ${r.kind}${r.errors.length ? ' – ' + r.errors.map((e) => e.code + (e.field ? `(${e.field})` : '')).join(', ') : ''}`;
  await track('agent_proposal', { tool: s.tool, decision: r.kind }); await refresh();
}

document.addEventListener('click', async (ev) => {
  const t = ev.target as HTMLElement;
  if (t.dataset.sample !== undefined) await propose(Number(t.dataset.sample));
  if (t.dataset.id !== undefined) { await api('/api/approvals', { proposalId: t.dataset.id, approver: 'human-reviewer', approved: t.dataset.ok === '1' }); await refresh(); }
  if (t.id === 'pii') await track('form_submit', { form_id: 'contact', email: 'someone@example.com' });
});
if ('PerformanceObserver' in window) {
  try { new PerformanceObserver((l) => { const e = l.getEntries().at(-1); if (e) void api('/api/vitals', { lcpMs: Math.round(e.startTime) }); })
    .observe({ type: 'largest-contentful-paint', buffered: true }); } catch { /* not supported */ }
}
void track('page_view_demo', { page: 'console' }); void refresh();
