import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ToolInvocationGuard, PendingApprovalQueue, loadPolicy, verifyHashChain, explainDecision, type DecisionLogEntry } from '../src/gate/index.js';

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

test('approval is bound to the approved tool arguments: same key, different payload is denied', async () => {
  const { guard, refund, calls } = setup();
  const p = await refund({ orderId: 'o6', amount: 600, currency: 'SEK' }, { ...ctx, idempotencyKey: 'call_x' });
  guard.queue.approve(p.status === 'pending_approval' ? p.approvalRequestId : '', 'cfo');
  const r = await refund({ orderId: 'o6', amount: 19000, currency: 'SEK' }, { ...ctx, idempotencyKey: 'call_x' });
  assert.equal(r.status, 'denied'); assert.match(r.decision.reasons[0]!, /different tool arguments/); assert.equal(calls(), 0);
  assert.equal((await refund({ orderId: 'o6', amount: 600, currency: 'SEK' }, { ...ctx, idempotencyKey: 'call_x' })).status, 'executed');
});

test('approval expiry also applies to an approved but unused approval', async () => {
  const { guard, refund, calls, tick } = setup();
  const a = { orderId: 'o7', amount: 700, currency: 'SEK' };
  const p = await refund(a, ctx);
  guard.queue.approve(p.status === 'pending_approval' ? p.approvalRequestId : '', 'cfo');
  tick(601);
  assert.equal((await refund(a, ctx)).status, 'pending_approval'); assert.equal(calls(), 0);
});

test('injected PendingApprovalQueue events are still written to the audit log', async () => {
  const queue = new PendingApprovalQueue({ defaultTtlSec: 60 });
  const guard = new ToolInvocationGuard({ policy, queue });
  await guard.invoke({ tool: 'payments.refund', agent: 'a', role: 'support_agent', args: { amount: 900 } }, () => 1);
  assert.deepEqual(guard.audit.all().map((e) => e.type), ['approval.requested', 'decision']);
});

test('idempotency key is bound to the agent: another agent cannot replay or consume it', async () => {
  const { guard, refund, calls } = setup();
  const a = { orderId: 'o8', amount: 100, currency: 'SEK' };
  await refund(a, { ...ctx, idempotencyKey: 'shared' });
  const other = await refund(a, { agent: 'support-bot-2', role: 'support_agent', idempotencyKey: 'shared' });
  assert.equal(other.status, 'denied'); assert.equal(calls(), 1);
  const big = { orderId: 'o9', amount: 900, currency: 'SEK' };
  const p = await refund(big, { ...ctx, idempotencyKey: 'shared-2' });
  guard.queue.approve(p.status === 'pending_approval' ? p.approvalRequestId : '', 'cfo');
  const hijack = await refund(big, { agent: 'support-bot-2', role: 'support_agent', idempotencyKey: 'shared-2' });
  assert.equal(hijack.status, 'denied'); assert.match(hijack.decision.reasons[0]!, /different agent/); assert.equal(calls(), 1);
});

test('releaseKeyOnError=false: a failed payment keeps its key claimed (no blind retry)', async () => {
  const guard = new ToolInvocationGuard({ policy, releaseKeyOnError: false }); let n = 0;
  const pay = guard.wrap('payments.get_charge', () => { n++; throw new Error('gateway timeout'); });
  assert.equal((await pay({ id: 1 }, ctx)).status, 'failed');
  assert.equal((await pay({ id: 1 }, ctx)).status, 'in_flight'); assert.equal(n, 1);
});

test('non-JSON tool arguments are denied, not thrown; duplicate results are copies', async () => {
  const { guard } = setup();
  const t = guard.wrap('payments.get_x', () => ({ n: 1 }));
  assert.equal((await t({ bad: NaN }, ctx)).status, 'denied');
  const r1 = await t({ q: 1 }, ctx); if (r1.status === 'executed') r1.result.n = 999;
  const r2 = await t({ q: 1 }, ctx);
  assert.deepEqual(r2.status === 'duplicate' && r2.result, { n: 1 });
});
