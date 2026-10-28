import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp, newState } from '../src/server.js';

test('server: gate, approvals, tracking, vitals, audit, static frontend', async () => {
  const st = newState(); const srv = createApp(st);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (p: string, b: unknown) => fetch(base + p, { method: 'POST', body: typeof b === 'string' ? b : JSON.stringify(b) });
  try {
    const prop = (id: string, tool: string, role: string, args: Record<string, unknown>) => ({ id, agent: 'growth-bot', role, tool, args, rationale: 'r', idempotencyKey: id });
    let r = await post('/api/proposals', prop('a1', 'set_ad_budget', 'growth_agent', { campaignId: 'CMP-001', dailySek: 500 }));
    assert.equal(r.status, 200); assert.equal((await r.json() as { kind: string }).kind, 'execute');
    r = await post('/api/proposals', prop('a2', 'set_ad_budget', 'growth_agent', { campaignId: 'CMP-001', dailySek: 2500 }));
    assert.equal(r.status, 202);
    r = await post('/api/proposals', prop('a3', 'save_cms_draft', 'content_agent', { postId: 'WP-1', status: 'publish', body: 'x' }));
    assert.equal(r.status, 422); assert.deepEqual((await r.json() as { errors: unknown }).errors, [{ code: 'pattern_mismatch', field: 'status' }]);
    assert.equal((await post('/api/proposals', '{oops')).status, 400);
    assert.deepEqual((await (await fetch(base + '/api/pending')).json() as { id: string }[]).map((p) => p.id), ['a2']);
    assert.equal((await post('/api/approvals', { proposalId: 'a2', approver: 'growth-bot', approved: true })).status, 403);
    assert.equal((await post('/api/approvals', { proposalId: 'a2', approver: '', approved: true })).status, 400);
    assert.equal((await post('/api/approvals', { proposalId: 'a2', approver: 'human', approved: true })).status, 200);
    assert.equal((await post('/api/approvals', { proposalId: 'a2', approver: 'human', approved: true })).status, 409);
    assert.equal((await post('/api/approvals', { proposalId: 'zz', approver: 'human', approved: true })).status, 404);
    assert.equal((await post('/api/track', { event: 'generate_lead', params: { form_id: 'c' }, consent: { analytics: true } })).status, 202);
    assert.equal((await post('/api/track', { event: 'form_submit', params: { email: 'a@b.se' }, consent: { analytics: true } })).status, 422);
    assert.deepEqual(await (await post('/api/vitals', { lcpMs: 1800, cls: 0.2 })).json(), { lcpMs: 'good', cls: 'needs_improvement' });
    const audit = await (await fetch(base + '/api/audit')).json() as { events: unknown[]; intact: boolean };
    assert.equal(audit.events.length, 3); assert.equal(audit.intact, true);
    const stats = await (await fetch(base + '/api/stats')).json() as { tracked: Record<string, number>; rejectedEvents: number };
    assert.deepEqual(stats.tracked, { generate_lead: 1 }); assert.equal(stats.rejectedEvents, 1);
    assert.equal((await post('/api/track', 'x'.repeat(70000))).status, 413);
    const html = await fetch(base + '/'); assert.match(html.headers.get('content-type') ?? '', /text\/html/); assert.match(await html.text(), /app\.js/);
    const js = await fetch(base + '/app.js'); assert.equal(js.status, 200); assert.match(await js.text(), /api\/proposals/);
    assert.equal((await fetch(base + '/nope')).status, 404);
  } finally { srv.close(); }
});
