# Policy file format (tool permission rules)

```json
{
  "version": 1,
  "name": "devops-shell",
  "defaultEffect": "deny",
  "approvalTtlSec": 300,
  "rules": [
    { "id": "deploy-prod", "tool": "deploy.*", "effect": "require_approval",
      "when": { "env": { "eq": "production" } }, "approvers": ["oncall"],
      "reason": "production deploys need human in the loop sign-off from on-call" }
  ]
}
```

| field | required | meaning |
|---|---|---|
| `version` | yes | must be `1` |
| `defaultEffect` | no | effect when no rule matches; default `deny` (fail closed) |
| `approvalTtlSec` | no | default approval expiry for `require_approval` |
| `rules[].id` | yes | unique; shows up in the decision log as `decidingRules` |
| `rules[].tool` | yes | tool name or glob (`*` = any characters, `.` is literal) |
| `rules[].effect` | yes | `allow`, `deny`, `require_approval` |
| `rules[].reason` | yes | human-readable reason, written to the decision log |
| `rules[].roles` | no | agent roles the rule applies to |
| `rules[].when` | no | argument conditions, see [approval-gate.md](approval-gate.md#conditions-when) |
| `rules[].approvers` | no | who may approve (`require_approval` only) |
| `rules[].approvalTtlSec` | no | approval expiry for this rule |

Examples: [`payments-refund`](../fixtures/policies/payments-refund.policy.json), [`devops-shell`](../fixtures/policies/devops-shell.policy.json),
[`email-send`](../fixtures/policies/email-send.policy.json) (default `require_approval`). Lint with `agent-action-gate lint <file>`.
