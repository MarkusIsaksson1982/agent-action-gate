import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idempotencyKey, IdempotencyStore, IdempotencyConflictError } from '../src/gate/index.js';

test('idempotency key: stable across key order, differs by tool, args and scope', () => {
  const k = idempotencyKey('email.send', { to: 'a', body: 'b' });
  assert.match(k, /^idk_[0-9a-f]{32}$/);
  assert.equal(k, idempotencyKey('email.send', { body: 'b', to: 'a' }));
  assert.notEqual(k, idempotencyKey('email.draft', { to: 'a', body: 'b' }));
  assert.notEqual(k, idempotencyKey('email.send', { to: 'a', body: 'c' }));
  assert.notEqual(k, idempotencyKey('email.send', { to: 'a', body: 'b' }, 'agent-2'));
});

test('idempotency store: new -> in_flight -> completed, replay result, conflict on different args', () => {
  let now = 0; const s = new IdempotencyStore<string>(1000, () => now);
  assert.deepEqual(s.begin('k', 'f1'), { state: 'new' });
  assert.deepEqual(s.begin('k', 'f1'), { state: 'in_flight', startedAt: 0 });
  s.complete('k', 'sent');
  assert.deepEqual(s.peek('k'), { state: 'completed', result: 'sent', completedAt: 0 });
  assert.throws(() => s.begin('k', 'f2'), IdempotencyConflictError);
  assert.throws(() => s.peek('k', 'f2'), IdempotencyConflictError);
  now = 1001;
  assert.deepEqual(s.peek('k'), { state: 'new' }, 'expired after TTL');
  assert.throws(() => s.complete('nope', 'x'), /unknown idempotency key/);
});

test('idempotency store: release lets a failed call retry', () => {
  const s = new IdempotencyStore();
  s.begin('k', 'f'); s.release('k');
  assert.deepEqual(s.begin('k', 'f'), { state: 'new' }); assert.equal(s.size, 1);
});

test('idempotency store: an in-flight key never expires by TTL', () => {
  let now = 0; const s = new IdempotencyStore(10, () => now);
  s.begin('k', 'f'); now = 1000;
  assert.equal(s.begin('k', 'f').state, 'in_flight');
});
