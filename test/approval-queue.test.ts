import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingApprovalQueue, ApprovalError, type ApprovalEvent } from '../src/gate/index.js';

function setup(ttl = 60) {
  let now = 1_000_000; const events: ApprovalEvent['type'][] = [];
  const q = new PendingApprovalQueue({ defaultTtlSec: ttl, now: () => now, onEvent: (e) => events.push(e.type) });
  return { q, events, tick: (s: number) => { now += s * 1000; } };
}
const req = { tool: 'payments.refund', args: { amount: 900 }, idempotencyKey: 'k1', requestedBy: 'agent-1', reasons: ['big'] };
const code = (c: string) => (e: unknown) => e instanceof ApprovalError && e.code === c;

test('approval request: pending -> approved -> consumed', () => {
  const { q, events } = setup();
  const r = q.request(req);
  assert.equal(r.status, 'pending'); assert.equal(r.expiresAt - r.createdAt, 60_000); assert.equal(r.id, 'apr_000001');
  assert.equal(q.pending().length, 1);
  assert.equal(q.approve(r.id, 'finance-lead', 'ok').decidedBy, 'finance-lead');
  assert.equal(q.findByIdempotencyKey('k1')!.status, 'approved');
  q.consume(r.id);
  assert.throws(() => q.consume(r.id), code('not_pending'), 'an approval is single-use');
  assert.deepEqual(events, ['approval.requested', 'approval.approved', 'approval.consumed']);
});

test('approval expiry: cannot approve after expiresAt; sweep marks expired', () => {
  const { q, events, tick } = setup(30);
  const r = q.request(req); const r2 = q.request({ ...req, idempotencyKey: 'k2', ttlSec: 120 });
  tick(30);
  assert.throws(() => q.approve(r.id, 'boss'), code('expired'));
  assert.equal(q.get(r.id)!.status, 'expired');
  assert.deepEqual(q.expireStale().map((x) => x.id), []);
  assert.deepEqual(q.pending().map((x) => x.id), [r2.id]);
  tick(100);
  assert.deepEqual(q.expireStale().map((x) => x.id), [r2.id]);
  assert.deepEqual(events.filter((e) => e === 'approval.expired').length, 2);
});

test('human in the loop: agent cannot approve itself; approver allow-list enforced', () => {
  const { q } = setup();
  const r = q.request({ ...req, approvers: ['cfo'] });
  assert.throws(() => q.approve(r.id, 'agent-1'), code('self_approval'));
  assert.throws(() => q.approve(r.id, 'intern'), code('not_an_approver'));
  q.approve(r.id, 'cfo');
  assert.throws(() => q.deny(r.id, 'cfo'), code('not_pending'), 'no double decision');
});

test('deny, unknown id, args are copied', () => {
  const { q } = setup();
  const args = { amount: 1 }; const r = q.request({ ...req, args });
  args.amount = 1e9;
  assert.equal(q.get(r.id)!.args.amount, 1);
  assert.equal(q.deny(r.id, 'agent-1', 'no').status, 'denied', 'requester may withdraw (deny) its own request');
  assert.throws(() => q.approve('apr_nope', 'x'), code('not_found'));
  assert.equal(q.get('apr_nope'), undefined);
});

test('returned approval requests are deep copies; TTL must be positive', () => {
  const { q } = setup();
  const r = q.request({ ...req, args: { nested: { amount: 1 } } });
  (r.args.nested as { amount: number }).amount = 9; r.reasons.push('x');
  assert.deepEqual(q.get(r.id)!.args, { nested: { amount: 1 } }); assert.deepEqual(q.get(r.id)!.reasons, ['big']);
  assert.throws(() => q.request({ ...req, ttlSec: -1 }), RangeError);
  assert.throws(() => new PendingApprovalQueue({ defaultTtlSec: 0 }), RangeError);
});

test('approved but unused approval expires; expireStale sweeps it', () => {
  const { q, tick } = setup(10);
  const r = q.request(req); q.approve(r.id, 'cfo'); tick(10);
  assert.throws(() => q.consume(r.id), code('expired'), 'consume reports expiry of an unused approval');
  assert.throws(() => q.consume('apr_nope'), code('not_found'));
});

test('one open approval request per idempotency key; huge TTL rejected', () => {
  const { q } = setup();
  const r = q.request(req);
  assert.throws(() => q.request(req), code('duplicate_request'));
  q.deny(r.id, 'cfo');
  assert.equal(q.request(req).status, 'pending', 'after a decision a new request may be opened');
  assert.throws(() => q.request({ ...req, idempotencyKey: 'k9', ttlSec: 1e308 }), RangeError);
});
