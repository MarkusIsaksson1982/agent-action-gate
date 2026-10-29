// Regenerates fixtures/audit-logs/*.jsonl: one valid hash-chained audit log and tampered variants.
// Run: npm run fixtures. Deterministic (fixed clock), so the committed files are reproducible.
import { writeFileSync } from 'node:fs';
import { AuditLog, type AuditEntry } from '../src/gate/index.js';

const DIR = new URL('../../fixtures/audit-logs/', import.meta.url);
let t = Date.parse('2026-10-29T12:00:00Z');
const log = new AuditLog({ now: () => new Date((t += 1000)) });
log.append('decision', { tool: 'payments.refund', agent: 'support-bot-1', outcome: 'executed', effect: 'allow', decidingRules: ['refund-small-allow'], reasons: ['small refunds in SEK/EUR are within the support agent\'s tool permission'] });
log.append('approval.requested', { id: 'apr_000001', tool: 'payments.refund', status: 'pending', idempotencyKey: 'idk_refund_ord_1002' });
log.append('decision', { tool: 'payments.refund', agent: 'support-bot-1', outcome: 'pending_approval', effect: 'require_approval', decidingRules: ['refund-large-approval'], reasons: ['refunds above 500 need a human approval request to finance'] });
log.append('approval.approved', { id: 'apr_000001', tool: 'payments.refund', status: 'approved', decidedBy: 'finance-lead' });
log.append('decision', { tool: 'payments.refund', agent: 'support-bot-1', outcome: 'executed', effect: 'require_approval', approvedBy: 'finance-lead', decidingRules: ['refund-large-approval'], reasons: ['refunds above 500 need a human approval request to finance'] });
log.append('decision', { tool: 'shell.exec', agent: 'coder-agent', outcome: 'denied', effect: 'deny', decidingRules: ['shell-rm-rf'], reasons: ['recursive delete is blocked for agents'] });

const valid = log.all();
const lines = (es: unknown[]) => es.map((e) => JSON.stringify(e)).join('\n') + '\n';
const write = (name: string, body: string) => writeFileSync(new URL(name, DIR), body);
write('valid.jsonl', lines(valid));
write('valid.head.txt', log.headHash + '\n');

const edited = structuredClone(valid) as AuditEntry<Record<string, unknown>>[];
edited[5]!.data.outcome = 'executed'; // someone rewrites a denial into an execution
write('tampered-edited-entry.jsonl', lines(edited));
write('tampered-deleted-entry.jsonl', lines(valid.filter((_, i) => i !== 3))); // the approval record is removed -> seq gap
write('tampered-reordered.jsonl', lines([valid[0], valid[2], valid[1], ...valid.slice(3)]));
write('tampered-truncated.jsonl', lines(valid.slice(0, 4))); // valid chain on its own; only --head catches it
write('tampered-bad-json.jsonl', lines(valid.slice(0, 2)) + '{"seq":2,"ts":\n' + lines(valid.slice(3)));
console.log('wrote fixtures/audit-logs');
