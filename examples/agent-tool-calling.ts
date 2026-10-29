// Example: an LLM agent loop's tool calling step routed through the approval gate.
// The model's tool_call (name + JSON arguments + tool_call id) becomes a guarded invocation; the GuardResult is
// turned into the tool_result message the model sees next. Run: npx tsc -p . && node dist/examples/agent-tool-calling.js
import { readFileSync } from 'node:fs';
import { ToolInvocationGuard, loadPolicy, explainDecision, type GuardResult } from '../src/gate/index.js';

const policy = loadPolicy(JSON.parse(readFileSync(new URL('../../fixtures/policies/payments-refund.policy.json', import.meta.url), 'utf8')));
const guard = new ToolInvocationGuard({ policy });
const tools = {
  'payments.refund': guard.wrap('payments.refund', (a: { orderId: string; amount: number; currency: string }) => ({ refundId: 're_' + a.orderId })),
};

interface ModelToolCall { id: string; name: keyof typeof tools; arguments: string }
function toToolResult(r: GuardResult<unknown>): string {
  switch (r.status) {
    case 'executed': case 'duplicate': return JSON.stringify({ ok: true, result: r.result });
    case 'pending_approval': return JSON.stringify({ ok: false, waiting_for_human: r.approvalRequestId, expires_at: new Date(r.expiresAt).toISOString() });
    case 'failed': return JSON.stringify({ ok: false, error: r.error });
    default: return JSON.stringify({ ok: false, blocked: explainDecision(r.decision) });
  }
}

async function step(tc: ModelToolCall) {
  // the model's tool_call id is a good idempotency key: a replayed message cannot refund twice
  const r = await tools[tc.name](JSON.parse(tc.arguments), { agent: 'support-bot-1', role: 'support_agent', idempotencyKey: tc.id });
  console.log(tc.id, '->', toToolResult(r));
  return r;
}

await step({ id: 'call_1', name: 'payments.refund', arguments: '{"orderId":"o1","amount":120,"currency":"SEK"}' });
await step({ id: 'call_1', name: 'payments.refund', arguments: '{"orderId":"o1","amount":120,"currency":"SEK"}' });
const p = await step({ id: 'call_2', name: 'payments.refund', arguments: '{"orderId":"o2","amount":4200,"currency":"SEK"}' });
if (p.status === 'pending_approval') guard.queue.approve(p.approvalRequestId, 'finance-lead');
await step({ id: 'call_2', name: 'payments.refund', arguments: '{"orderId":"o2","amount":4200,"currency":"SEK"}' });
await step({ id: 'call_3', name: 'payments.refund', arguments: '{"orderId":"o3","amount":99999,"currency":"SEK"}' });
console.log('audit log verify:', guard.audit.verify().ok, guard.audit.length, 'entries');
