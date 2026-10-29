# agent-action-gate

[![CI](https://github.com/MarkusIsaksson1982/agent-action-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/MarkusIsaksson1982/agent-action-gate/actions/workflows/ci.yml)

**Use when an LLM agent's tool calls need an approval gate in TypeScript:** a policy check before every tool call
(allow / deny / require_approval per tool), a human-in-the-loop approval queue with approval expiry, idempotency keys that
dedupe repeated tool calls, and an append-only, hash-chained JSONL audit log with a `verify` CLI that detects tampering and gaps.

Dependency-free strict TypeScript (only `node:crypto` / `node:fs`), Node ≥ 20, MIT.

## Quick start
```bash
git clone https://github.com/MarkusIsaksson1982/agent-action-gate && cd agent-action-gate
npm ci && npm test            # builds + runs the node:test suite
npm run example               # an agent tool calling loop through the gate
node dist/src/cli.js verify fixtures/audit-logs/tampered-deleted-entry.jsonl   # TAMPERED … seq_gap (exit 1)
```

```ts
import { readFileSync } from 'node:fs';
import { ToolInvocationGuard, AuditLog, loadPolicy } from 'agent-action-gate';

const policy = loadPolicy(JSON.parse(readFileSync('fixtures/policies/payments-refund.policy.json', 'utf8')));
const guard = new ToolInvocationGuard({ policy, audit: new AuditLog({ path: 'audit.jsonl' }) });
const refund = guard.wrap('payments.refund', (a: { orderId: string; amount: number; currency: string }) => doRefund(a));

const r = await refund({ orderId: 'o2', amount: 4200, currency: 'SEK' }, { agent: 'support-bot-1', role: 'support_agent', idempotencyKey: toolCall.id });
// r.status: 'executed' | 'duplicate' | 'denied' | 'pending_approval' | 'in_flight' | 'failed'
if (r.status === 'pending_approval') guard.queue.approve(r.approvalRequestId, 'finance-lead'); // a human, later
// the agent re-sends the same tool call (same idempotency key) -> executed once, approval consumed
```

## Concepts
| concept | API | doc |
|---|---|---|
| Approval gate: policy check before call | `approvalGate(policy, call)`, `loadPolicy()` | [docs/approval-gate.md](docs/approval-gate.md), [docs/policy-format.md](docs/policy-format.md) |
| Tool permission rules per tool / role / argument | `rules[].tool` glob, `roles`, `when` | [docs/policy-format.md](docs/policy-format.md) |
| Human in the loop approval request + approval expiry | `PendingApprovalQueue` | [docs/human-in-the-loop-approval-queue.md](docs/human-in-the-loop-approval-queue.md) |
| Idempotency key (dedupe repeated tool calls) | `idempotencyKey()`, `IdempotencyStore` | [docs/idempotency-key.md](docs/idempotency-key.md) |
| Audit log (append-only, hash chain verify) | `AuditLog`, `verifyHashChain()`, CLI `verify` | [docs/audit-log-hash-chain-verify.md](docs/audit-log-hash-chain-verify.md) |
| Decision log entries with reasons | `DecisionLogEntry`, `explainDecision()` | [docs/decision-log.md](docs/decision-log.md) |
| Tool invocation guard for agent tool calls | `ToolInvocationGuard.invoke()/wrap()` | [docs/tool-invocation-guard.md](docs/tool-invocation-guard.md) |

Decision rule: all matching rules count and the most restrictive wins (deny > require_approval > allow); no match → `defaultEffect`, which
defaults to deny (fail closed). Agents can never approve their own requests; approvals are single-use and expire.

## CLI
```
agent-action-gate verify <audit.jsonl> [--head <hash>] [--count <n>] [--json]   exit 0 ok · 1 tampered · 2 usage
agent-action-gate check  <policy.json> <call.json> [--json]                      exit 0 allow · 3 require_approval · 4 deny
agent-action-gate lint   <policy.json>
```

## Layout
```
src/gate/policy-check.ts          approvalGate, loadPolicy, rule matching
src/gate/approval-queue.ts        PendingApprovalQueue (approval expiry, no self-approval, single-use)
src/gate/idempotency-key.ts       idempotencyKey, IdempotencyStore
src/gate/audit-log.ts             AuditLog (JSONL), verifyHashChain
src/gate/decision-log.ts          DecisionLogEntry, explainDecision
src/gate/tool-invocation-guard.ts ToolInvocationGuard
src/cli.ts                        verify / check / lint
fixtures/policies/                payments refund, devops shell/deploy, email send, an invalid policy
fixtures/tool-calls/              sample agent tool calls
fixtures/audit-logs/              valid.jsonl + tampered-{edited-entry,deleted-entry,reordered,truncated,bad-json}.jsonl
examples/agent-tool-calling.ts    model tool_call -> guard -> tool_result
src/action-gate.ts, src/server.ts v0.2 schema-validating gate + web-operations demo (below)
```

## Test queries (Xerj)
Pre-registered queries; the expected file should rank in the top 5:

| query | expected file |
|---|---|
| approval gate policy check before tool call | docs/approval-gate.md, src/gate/policy-check.ts |
| human in the loop approval request expiry | docs/human-in-the-loop-approval-queue.md, src/gate/approval-queue.ts |
| idempotency key dedupe repeated tool calls | docs/idempotency-key.md, src/gate/idempotency-key.ts |
| hash chain verify tampered audit log | docs/audit-log-hash-chain-verify.md, src/gate/audit-log.ts |
| tool invocation guard for agent tool calls | docs/tool-invocation-guard.md, src/gate/tool-invocation-guard.ts |

## Limits
- In-memory queue and idempotency store (single process); one audit-log writer per file. For several workers, implement the same interface on Redis/Postgres.
- A hash chain is tamper-*evident*, not tamper-proof: anchor the head hash outside the agent's reach (see the audit-log doc).
- No MCP server adapter yet; wrap your MCP tool handlers with `guard.wrap()`.

## v0.2: schema-validating gate and fullstack web-operations demo
`src/action-gate.ts` (`validateProposal`, `decide`, `verifyLog`, `handler`, `evaluate`) validates typed tool arguments against a field schema
with role checks, approval thresholds and hard limits, and replays recorded proposals counting **unsafe executes**.

`npm start` → http://localhost:8787 – a TypeScript frontend (no framework) and a JSON API on `node:http`:

| route | what it does |
|---|---|
| `POST /api/proposals` | an agent's proposal (SEO meta edit, ad-budget change, CMS draft) goes through the gate; `needs_approval` ones are queued |
| `GET /api/pending`, `POST /api/approvals` | a human approves or denies; an agent can never approve its own proposal (403), double decisions → 409 |
| `GET /api/audit` | hash-chained audit log + integrity check |
| `POST /api/track` | **tracking guard** for GA4-style dataLayer events: consent required, naming rules, reserved names, ≤25 params, ≤100-char values, **no personal data** (e-mail, Swedish phone numbers, personnummer) |
| `POST /api/vitals` | rates Core Web Vitals (LCP, INP, CLS) against Google's good / needs-improvement / poor thresholds |

Policy in the demo: SEO agents may edit titles (10–60 chars) and meta descriptions (50–160); growth agents may change ad budgets, above 1,000/day
a human signs off and above 10,000/day it is rejected; content agents may only save CMS **drafts** – publishing stays with a person.
Request bodies are capped at 64 KB (413). Everything is in memory.

- `src/server.ts` – API + static frontend · `src/tracking.ts` – tracking guard + vitals rating · `web/app.ts`, `web/index.html` – frontend
- `test/server.test.ts`, `test/tracking.test.ts` – end-to-end API test on a random port + tracking/vitals tests (node:test)

- `src/action-gate.ts` – the gate (validateProposal, decide, appendEvent, verifyLog, handler, evaluate)
- `test/action-gate.test.ts` – 6 node:test tests for the gate (`tsc --strict`)
- `src/demo.ts` – synthetic replay of ten recorded proposals

All data is synthetic; this is a demonstration of approach, not a production system. Built with an agentic workflow
(spec → hidden tests → free/local models in a sandbox → `tsc --strict` + tests → human review). MIT licence.
