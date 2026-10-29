# Decision log: why a tool call ran, was blocked, or waited for a human

Source: [`src/gate/decision-log.ts`](../src/gate/decision-log.ts)

Every guarded tool call appends one `decision` entry to the audit log:

```json
{ "tool": "payments.refund", "agent": "support-bot-1", "role": "support_agent", "idempotencyKey": "call_2",
  "effect": "require_approval", "outcome": "executed", "matchedRules": ["refund-large-approval"],
  "decidingRules": ["refund-large-approval"], "reasons": ["refunds above 500 need a human approval request to finance"],
  "approvalRequestId": "apr_000001", "approvedBy": "finance-lead", "argsHash": "9f2c…" }
```

- `effect` is what the policy said; `outcome` is what happened: `executed`, `denied`, `pending_approval`, `approval_expired`,
  `duplicate`, `in_flight`, `failed`.
- `reasons` come from the deciding rules' `reason` text, or from the guard (human denial note, idempotency conflict, expiry).
- Raw arguments are **not** logged, only `argsHash` (sha256 of canonical JSON), because tool arguments often contain personal data.
  Keep the arguments in your own store if you need them, and match them by hash.
- `explainDecision(entry)` gives a one-line explanation to return to the model as the tool_result:
  `payments.refund by support-bot-1: denied [refund-hard-limit] - refunds above 20000 are never done by an agent`.
