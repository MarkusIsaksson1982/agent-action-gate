import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ToolInvocationGuard, loadPolicy, verifyHashChain, explainDecision, type DecisionLogEntry } from '../src/gate/index.js';

const policy = loadPolicy(JSON.parse(readFileSync(new URL('../../fixtures/policies/payments-refund.policy.json', import.meta.url), 'utf8')));

function setup() {
  let now = Date.parse('2026-10-29T12:00:00Z'); let calls = 0;
  const guard = new ToolInvocationGuard({ policy, now: () => now });
  const refund = guard.wrap('payments.refund', (a: { orderId: string; amount: number; currency: string }) => { calls++; return { refundId: 're_' + a.orderId, amount: a.amount }; });
  return { guard, refund, calls: () => calls, tick: (s: number) => { now += s * 1000; } };
}
const ctx = { agent: 'support-bot-1', role: 'support_agent' };
const decisions = (g: ToolInvocationGuard) => g.audit.all().filter((e) => e.type === 'decision').map((e) => (e.data as DecisionLogEntry).outcome);

test('tool invocation guard: allowed call executes once; retry with same idempotency key is a duplicate', async () => {
  const { guard, refund, calls } = setup();
  const a = { orderId: 'o1', amount: 100, currency: 'SEK' };
  const r1 = await refund(a, ctx); const r2 = await refund({ ...a }, ctx);
  assert.equal(r1.status, 'executed'); assert.equal(r2.status, 'duplicate');
  assert.deepEqual(r2.status === 'duplicate' && r2.result, { refundId: 're_o1', amount: 100 });
  assert.equal(calls(), 1);
  assert.deepEqual(decisions(guard), ['executed', 'duplicate']);
  assert.equal(guard.audit.verify().ok, true);
});

test('tool invocation guard: denied call never runs the tool, decision log has the reason', async () => {
  const { guard, refund, calls } = setup();
  const r = await refund({ orderId: 'o9', amount: 30000, currency: 'SEK' }, ctx);
  assert.equal(r.status, 'denied'); assert.equal(calls(), 0);
  assert.deepEqual(r.decision.decidingRules, ['refund-hard-limit']);
  assert.match(explainDecision(r.decision), /payments\.refund by support-bot-1: denied \[refund-hard-limit\] - refunds above 20000/);
});

test('human in the loop: require_approval -> pending, approve, retry executes and consumes the approval', async () => {
  const { guard, refund, calls } = setup();
  const a = { orderId: 'o2', amount: 4200, currency: 'SEK' };
  const p = await refund(a, ctx);
  assert.equal(p.status, 'pending_approval'); assert.equal(calls(), 0);
  const id = p.status === 'pending_approval' ? p.approvalRequestId : '';
  assert.equal((await refund(a, ctx)).status, 'pending_approval', 'still waiting, same request');
  assert.equal(guard.queue.pending().length, 1);
  assert.throws(() => guard.queue.approve(id, 'support-bot-1'), /cannot approve its own/);
  guard.queue.approve(id, 'finance-lead');
  const e = await refund(a, ctx);
  assert.equal(e.status, 'executed'); assert.equal(e.decision.approvedBy, 'finance-lead'); assert.equal(calls(), 1);
  assert.equal((await refund(a, ctx)).status, 'duplicate');
  assert.equal(guard.queue.get(id)!.status, 'consumed');
  const types = guard.audit.all().map((x) => x.type);
  assert.deepEqual(types, ['approval.requested', 'decision', 'decision', 'approval.approved', 'approval.consumed', 'decision', 'decision']);
  assert.equal(verifyHashChain(guard.audit.toJsonl()).ok, true);
});

test('approval expiry: expired request is logged and a fresh approval request is created', async () => {
  const { guard, refund, tick } = setup();
  const a = { orderId: 'o3', amount: 900, currency: 'EUR' };
  const p1 = await refund(a, ctx); tick(601);
  const p2 = await refund(a, ctx);
  assert.equal(p2.status, 'pending_approval');
  assert.notEqual(p1.status === 'pending_approval' && p1.approvalRequestId, p2.status === 'pending_approval' && p2.approvalRequestId);
  assert.deepEqual(decisions(guard), ['pending_approval', 'approval_expired', 'pending_approval']);
});

test('human denial blocks the call for that idempotency key', async () => {
  const { guard, refund, calls } = setup();
  const a = { orderId: 'o4', amount: 900, currency: 'EUR' };
  const p = await refund(a, ctx);
  guard.queue.deny(p.status === 'pending_approval' ? p.approvalRequestId : '', 'cfo', 'customer already refunded');
  const r = await refund(a, ctx);
  assert.equal(r.status, 'denied'); assert.deepEqual(r.decision.reasons, ['approval denied by cfo: customer already refunded']); assert.equal(calls(), 0);
});

test('explicit idempotency key reused with different args is refused', async () => {
  const { refund, calls } = setup();
  await refund({ orderId: 'o5', amount: 10, currency: 'SEK' }, { ...ctx, idempotencyKey: 'tool_call_abc' });
  const r = await refund({ orderId: 'o5', amount: 400, currency: 'SEK' }, { ...ctx, idempotencyKey: 'tool_call_abc' });
  assert.equal(r.status, 'denied'); assert.match(r.decision.reasons[0]!, /reused with different tool arguments/); assert.equal(calls(), 1);
});

test('failing tool: failed outcome, key released so a retry can run', async () => {
  const { guard } = setup(); let n = 0;
  const flaky = guard.wrap('payments.get_status', () => { if (++n === 1) throw new Error('timeout'); return 'ok'; });
  const r1 = await flaky({ id: 1 }, ctx);
  assert.equal(r1.status, 'failed'); assert.equal(r1.status === 'failed' && r1.error, 'timeout');
  assert.equal((await flaky({ id: 1 }, ctx)).status, 'executed');
});

test('concurrent duplicate tool calls: second sees in_flight, tool runs once', async () => {
  const { guard } = setup(); let n = 0; let release!: () => void;
  const slow = guard.wrap('payments.get_slow', () => new Promise<number>((res) => { n++; release = () => res(n); }));
  const first = slow({ q: 1 }, ctx);
  const second = await slow({ q: 1 }, ctx);
  assert.equal(second.status, 'in_flight');
  release();
  assert.equal((await first).status, 'executed'); assert.equal(n, 1);
});

test('decision log does not store raw args, only their hash', async () => {
  const { guard, refund } = setup();
  await refund({ orderId: 'secret-order', amount: 1, currency: 'SEK' }, ctx);
  assert.equal(guard.audit.toJsonl().includes('secret-order'), false);
  assert.match((guard.audit.all()[0]!.data as DecisionLogEntry).argsHash, /^[0-9a-f]{64}$/);
});
