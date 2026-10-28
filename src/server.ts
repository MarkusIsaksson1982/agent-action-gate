// Fullstack demo server (node:http, no framework): serves a small TypeScript frontend and a JSON API where a web-operations
// agent's proposals (SEO meta edits, ad-budget changes, CMS drafts) go through the action gate, large budgets wait for a human,
// and site tracking events pass the tracking guard first. In-memory state, synthetic data only.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handler, verifyLog, type Policy, type Proposal, type AuditEvent } from './action-gate.js';
import { validateTrackEvent, rateVitals, type TrackEvent, type Vitals, type Rating } from './tracking.js';

export const WEB_POLICY: Policy = {
  update_meta: { roles: ['seo_agent'], fields: { pageId: { type: 'string', required: true, pattern: 'P[0-9]{4}' },
    title: { type: 'string', required: true, pattern: '.{10,60}' }, description: { type: 'string', required: true, pattern: '.{50,160}' } } },
  set_ad_budget: { roles: ['growth_agent'], amountField: 'dailySek', approvalAbove: 1000, hardLimit: 10000,
    fields: { campaignId: { type: 'string', required: true, pattern: 'CMP-[0-9]{3}' }, dailySek: { type: 'number', required: true, min: 50 } } },
  // agents may only save CMS drafts; publishing stays with a human
  save_cms_draft: { roles: ['content_agent'], fields: { postId: { type: 'string', required: true, pattern: 'WP-[0-9]{1,6}' },
    status: { type: 'string', required: true, pattern: 'draft' }, body: { type: 'string', required: true } } },
};
export interface Approval { proposalId: string; approver: string; approved: boolean }
export interface AppState { policy: Policy; seen: Set<string>; log: AuditEvent[]; pending: Map<string, Proposal>; approvals: Approval[];
  tracked: Record<string, number>; rejectedEvents: number; vitals: Rating[] }
export const newState = (policy: Policy = WEB_POLICY): AppState =>
  ({ policy, seen: new Set(), log: [], pending: new Map(), approvals: [], tracked: {}, rejectedEvents: 0, vitals: [] });

const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // dist/src -> package root
const MAX_BODY = 64 * 1024;
const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : String(body));
};
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0; const chunks: Buffer[] = [];
    // over the limit: keep draining (discard) so the client still receives a clean 413
    req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString('utf8')));
  });
}
const parse = (s: string): Record<string, unknown> | null => {
  try { const v: unknown = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
};

export async function route(st: AppState, method: string, path: string, body: string): Promise<{ status: number; body: unknown; type?: string }> {
  if (method === 'GET' && path === '/') return { status: 200, body: await readFile(ROOT + 'web/index.html', 'utf8'), type: 'text/html; charset=utf-8' };
  if (method === 'GET' && path === '/app.js') return { status: 200, body: await readFile(ROOT + 'dist/web/app.js', 'utf8'), type: 'text/javascript' };
  if (method === 'GET' && path === '/api/audit') return { status: 200, body: { events: st.log, intact: verifyLog(st.log) === -1 } };
  if (method === 'GET' && path === '/api/pending') return { status: 200, body: [...st.pending.values()] };
  if (method === 'GET' && path === '/api/stats') return { status: 200, body: { tracked: st.tracked, rejectedEvents: st.rejectedEvents, vitals: st.vitals, approvals: st.approvals } };
  if (method === 'POST' && path === '/api/proposals') {
    const r = handler({ body }, st);
    const out = JSON.parse(r.body) as { kind?: string };
    if (out.kind === 'needs_approval') { const p = parse(body) as unknown as Proposal; st.pending.set(p.id, p); }
    return { status: r.statusCode, body: out };
  }
  if (method === 'POST' && path === '/api/approvals') {
    const b = parse(body);
    if (!b || typeof b.proposalId !== 'string' || typeof b.approver !== 'string' || typeof b.approved !== 'boolean' || b.approver.trim() === '')
      return { status: 400, body: { error: 'bad_request' } };
    const p = st.pending.get(b.proposalId);
    if (!p) return { status: st.approvals.some((a) => a.proposalId === b.proposalId) ? 409 : 404, body: { error: 'not_pending' } };
    if (b.approver === p.agent) return { status: 403, body: { error: 'agent_cannot_approve_itself' } };
    st.pending.delete(p.id); const a: Approval = { proposalId: p.id, approver: b.approver, approved: b.approved }; st.approvals.push(a);
    return { status: 200, body: a };
  }
  if (method === 'POST' && path === '/api/track') {
    const b = parse(body); if (!b) return { status: 400, body: { error: 'bad_json' } };
    const r = validateTrackEvent(b as unknown as TrackEvent);
    if (!r.accepted) { st.rejectedEvents++; return { status: 422, body: r }; }
    const name = b.event as string; st.tracked[name] = (st.tracked[name] ?? 0) + 1; return { status: 202, body: r };
  }
  if (method === 'POST' && path === '/api/vitals') {
    const b = parse(body); if (!b) return { status: 400, body: { error: 'bad_json' } };
    const r = rateVitals(b as Vitals); st.vitals.push(...Object.values(r)); return { status: 200, body: r };
  }
  return { status: 404, body: { error: 'not_found' } };
}

export function createApp(st: AppState = newState()): Server {
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname; const method = req.method ?? 'GET';
    const body = method === 'POST' ? await readBody(req) : '';
    if (body === null) return send(res, 413, { error: 'too_large' });
    try { const r = await route(st, method, path, body); send(res, r.status, r.body, r.type); }
    catch { send(res, 500, { error: 'internal' }); }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8787);
  createApp().listen(port, () => console.log(`agent-action-gate web demo on http://localhost:${port}`));
}
