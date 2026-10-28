// Synthetic replay: recorded agent proposals (as an LLM would emit them) run through the gate; prints the evaluation and the audit-log check.
import { evaluate, handler, verifyLog, type Policy, type Proposal, type Kind, type AuditEvent } from './action-gate.js';

const policy: Policy = {
  issue_refund: { roles: ['support_agent'], amountField: 'amountSek', approvalAbove: 5000, hardLimit: 50000,
    fields: { customerId: { type: 'string', required: true, pattern: 'C[0-9]{6}' }, amountSek: { type: 'number', required: true, min: 1 }, reason: { type: 'string' } } },
  extend_due_date: { roles: ['ops_agent'], fields: { loanId: { type: 'string', required: true, pattern: 'L[0-9]{5}' }, days: { type: 'integer', required: true, min: 1, max: 30 } } },
};
const p = (id: string, o: Partial<Proposal>): Proposal => ({ id, agent: 'agent-1', role: 'support_agent', tool: 'issue_refund',
  args: {}, rationale: 'customer reported a double charge', idempotencyKey: id, ...o });
const cases: { proposal: Proposal; expected: Kind }[] = [
  { proposal: p('r1', { args: { customerId: 'C000123', amountSek: 349 } }), expected: 'execute' },
  { proposal: p('r1', { args: { customerId: 'C000123', amountSek: 349 } }), expected: 'duplicate' },          // agent retried
  { proposal: p('r2', { args: { customerId: 'C000777', amountSek: 12000 } }), expected: 'needs_approval' },
  { proposal: p('r3', { args: { customerId: 'C77', amountSek: 100 } }), expected: 'reject' },                // hallucinated id format
  { proposal: p('r4', { args: { customerId: 'C000124', amountSek: '100' } }), expected: 'reject' },          // string amount
  { proposal: p('r5', { role: 'ops_agent', tool: 'extend_due_date', args: { loanId: 'L00042', days: 14 } }), expected: 'execute' },
  { proposal: p('r6', { role: 'support_agent', tool: 'extend_due_date', args: { loanId: 'L00042', days: 14 } }), expected: 'reject' },
  { proposal: p('r7', { tool: 'wire_transfer', args: { to: 'X', amountSek: 1 } }), expected: 'reject' },     // tool not in policy
  { proposal: p('r8', { args: { customerId: 'C000125', amountSek: 90000 } }), expected: 'reject' },          // over hard limit
  { proposal: p('r9', { rationale: ' ', args: { customerId: 'C000126', amountSek: 10 } }), expected: 'reject' },
];
console.log(JSON.stringify(evaluate(cases, policy), null, 1));
const ctx = { policy, seen: new Set<string>(), log: [] as AuditEvent[] };
for (const c of cases) handler({ body: JSON.stringify(c.proposal) }, ctx);
console.log('audit events', ctx.log.length, 'chain intact:', verifyLog(ctx.log) === -1);
