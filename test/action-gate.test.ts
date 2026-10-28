import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateProposal, decide, appendEvent, verifyLog, handler, evaluate, type Policy, type Proposal, type AuditEvent } from '../src/action-gate.js';

const POL: Policy = {
  issue_refund: { roles: ['support_agent', 'ops_agent'], amountField: 'amountSek', approvalAbove: 5000, hardLimit: 50000,
    fields: { customerId: { type: 'string', required: true, pattern: 'C[0-9]{6}' }, amountSek: { type: 'number', required: true, min: 1 },
              reason: { type: 'string' }, notify: { type: 'boolean' } } },
  extend_due_date: { roles: ['ops_agent'], fields: { loanId: { type: 'string', required: true }, days: { type: 'integer', required: true, min: 1, max: 30 } } },
};
const P = (o: Partial<Proposal> = {}): Proposal => ({ id: 'p1', agent: 'a', role: 'support_agent', tool: 'issue_refund',
  args: { customerId: 'C123456', amountSek: 200 }, rationale: 'duplicate charge', idempotencyKey: 'k1', ...o });

test('validate: ok, field order, one error per field, no field key when absent', () => {
  assert.deepEqual(validateProposal(P(), POL), []);
  const e = validateProposal(P({ role: 'x', rationale: '  ', args: { zeta: 1, amountSek: '5', customerId: 'C12', notify: 'yes' } }), POL);
  assert.deepEqual(e, [{ code: 'empty_rationale' }, { code: 'role_not_allowed' }, { code: 'wrong_type', field: 'amountSek' },
    { code: 'pattern_mismatch', field: 'customerId' }, { code: 'wrong_type', field: 'notify' }, { code: 'unknown_field', field: 'zeta' }]);
  assert.equal('field' in (e[0] as object), false);
});

test('validate: unknown tool returns early; ranges, integers, missing, hard limit, own-property only', () => {
  assert.deepEqual(validateProposal(P({ tool: 'wire', rationale: '' }), POL), [{ code: 'empty_rationale' }, { code: 'unknown_tool' }]);
  assert.deepEqual(validateProposal(P({ tool: 'toString' }), POL), [{ code: 'unknown_tool' }]);
  assert.deepEqual(validateProposal(P({ role: 'ops_agent', tool: 'extend_due_date', args: { days: 2.5 } }), POL),
    [{ code: 'wrong_type', field: 'days' }, { code: 'missing_field', field: 'loanId' }]);
  assert.deepEqual(validateProposal(P({ role: 'ops_agent', tool: 'extend_due_date', args: { loanId: 'L1', days: 31 } }), POL), [{ code: 'out_of_range', field: 'days' }]);
  assert.deepEqual(validateProposal(P({ args: { customerId: 'C123456', amountSek: 60000 } }), POL), [{ code: 'over_hard_limit' }]);
  assert.deepEqual(validateProposal(P({ args: { customerId: 'C123456', amountSek: 0 } }), POL), [{ code: 'out_of_range', field: 'amountSek' }]);
  assert.deepEqual(validateProposal(P({ args: { customerId: 'xC123456', amountSek: 5 } }), POL), [{ code: 'pattern_mismatch', field: 'customerId' }]);
  assert.deepEqual(validateProposal(P({ args: { customerId: 'C123456', amountSek: Infinity } }), POL), [{ code: 'wrong_type', field: 'amountSek' }]);
});

test('decide: duplicate first, reject keeps seen, approval threshold is strict', () => {
  const seen = new Set<string>();
  assert.deepEqual(decide(P({ args: { customerId: 'C1' , amountSek: 3 } }), POL, seen), { kind: 'reject', errors: [{ code: 'pattern_mismatch', field: 'customerId' }] });
  assert.equal(seen.size, 0);
  assert.deepEqual(decide(P({ args: { customerId: 'C123456', amountSek: 5000 } }), POL, seen), { kind: 'execute', errors: [] });
  assert.deepEqual(decide(P({ rationale: '' }), POL, seen), { kind: 'duplicate', errors: [] });
  assert.deepEqual(decide(P({ idempotencyKey: 'k2', args: { customerId: 'C123456', amountSek: 5000.5 } }), POL, seen), { kind: 'needs_approval', errors: [] });
  assert.deepEqual([...seen], ['k1', 'k2']);
});

test('audit log: hash chain, exact hash, tamper detection', () => {
  const log: AuditEvent[] = [];
  const e0 = appendEvent(log, P(), { kind: 'execute', errors: [] });
  const e1 = appendEvent(log, P({ id: 'p2' }), { kind: 'reject', errors: [{ code: 'unknown_tool' }] });
  assert.equal(e0.prevHash, '0'.repeat(64)); assert.equal(e1.prevHash, e0.hash); assert.deepEqual(e1.codes, ['unknown_tool']);
  assert.equal(e1.hash, createHash('sha256').update(JSON.stringify([1, 'p2', 'issue_refund', 'reject', ['unknown_tool'], e0.hash])).digest('hex'));
  assert.equal(verifyLog(log), -1); assert.equal(verifyLog([]), -1);
  appendEvent(log, P({ id: 'p3' }), { kind: 'execute', errors: [] });
  (log[1] as AuditEvent).kind = 'execute'; assert.equal(verifyLog(log), 1);
  (log[1] as AuditEvent).kind = 'reject'; (log[2] as AuditEvent).seq = 7; assert.equal(verifyLog(log), 2);
});

test('handler: status codes, bad json not logged, body shape', () => {
  const ctx = { policy: POL, seen: new Set<string>(), log: [] as AuditEvent[] };
  for (const b of [undefined, null, '{', '[1]', 'null', '3']) assert.deepEqual(handler({ body: b }, ctx), { statusCode: 400, body: '{"error":"bad_json"}' });
  assert.equal(ctx.log.length, 0);
  const r = (o: Partial<Proposal>) => handler({ body: JSON.stringify(P(o)) }, ctx);
  assert.deepEqual(r({}), { statusCode: 200, body: '{"kind":"execute","errors":[],"seq":0}' });
  assert.deepEqual(r({}), { statusCode: 200, body: '{"kind":"duplicate","errors":[],"seq":1}' });
  assert.equal(r({ idempotencyKey: 'k9', args: { customerId: 'C123456', amountSek: 9000 } }).statusCode, 202);
  assert.deepEqual(JSON.parse(r({ idempotencyKey: 'k8', tool: 'nope' }).body), { kind: 'reject', errors: [{ code: 'unknown_tool' }], seq: 3 });
  assert.equal(verifyLog(ctx.log), -1);
});

test('evaluate: fresh set per run, byKind zeros, unsafe executes', () => {
  const cases = [
    { proposal: P(), expected: 'execute' as const },
    { proposal: P(), expected: 'duplicate' as const },
    { proposal: P({ idempotencyKey: 'k3', args: { customerId: 'C123456', amountSek: 7000 } }), expected: 'execute' as const },
    { proposal: P({ idempotencyKey: 'k4', args: { customerId: 'C123456', amountSek: 10 } }), expected: 'reject' as const },
  ];
  const r = evaluate(cases, POL);
  assert.deepEqual(r, { total: 4, correct: 2, unsafeExecutes: 1, byKind: { execute: { expected: 2, correct: 1 }, needs_approval: { expected: 0, correct: 0 },
    reject: { expected: 1, correct: 0 }, duplicate: { expected: 1, correct: 1 } } });
  assert.deepEqual(evaluate(cases, POL), r);
});
