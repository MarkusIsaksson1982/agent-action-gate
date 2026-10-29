# Tool invocation guard: wrap agent tool functions

Use when you want every agent tool call (OpenAI/Anthropic tool calling, LangChain tools, an MCP server's handlers) to pass the approval gate,
idempotency and audit log without changing the tools themselves.

Source: [`src/gate/tool-invocation-guard.ts`](../src/gate/tool-invocation-guard.ts) · tests: [`test/tool-invocation-guard.test.ts`](../test/tool-invocation-guard.test.ts) ·
example: [`examples/agent-tool-calling.ts`](../examples/agent-tool-calling.ts)

```ts
const guard = new ToolInvocationGuard({ policy, audit: new AuditLog({ path: 'audit.jsonl' }) });
const refund = guard.wrap('payments.refund', async (a: { orderId: string; amount: number }) => stripe.refunds.create(a));
const r = await refund(args, { agent: 'support-bot-1', role: 'support_agent', idempotencyKey: toolCall.id });
switch (r.status) { case 'executed': case 'duplicate': /* r.result */ case 'pending_approval': /* r.approvalRequestId */ case 'denied': case 'in_flight': case 'failed': }
```

## Order of checks
1. **Policy** (`approvalGate`) – `deny` returns immediately; the tool never runs.
2. **Idempotency** – completed key → `duplicate` with the first result; running key → `in_flight`; same key, different args → `denied`.
3. **Approval** (`require_approval` only) – no request yet → create one → `pending_approval`; pending → `pending_approval` (same id);
   denied by a human → `denied`; expired → log `approval_expired` and create a fresh request; approved → consume and run. A pending/approved request whose tool or arguments differ from this call → `denied` (approval is bound to the payload).
4. **Execute** – result stored under the key; a thrown error → `failed` and the key is released for a retry.
5. **Arguments** must be plain JSON (no `NaN`, functions, BigInt); anything else is `denied` instead of thrown.
6. **Decision log** – one `decision` entry per invocation in the hash-chained audit log.

The agent re-sends the same tool call (same idempotency key) after a human approves; that is how the approval reaches the call.
Policy is re-evaluated on every attempt, so changing a rule to `deny` also blocks already-approved calls. (Changes to `approvers` or
`approvalTtlSec` only apply to new approval requests.)
