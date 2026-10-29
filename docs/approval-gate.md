# Approval gate: policy check before a tool call

Use when an LLM agent's tool call must be checked against a policy **before** it runs: allow, deny, or require human approval.

Source: [`src/gate/policy-check.ts`](../src/gate/policy-check.ts) · tests: [`test/policy-check.test.ts`](../test/policy-check.test.ts) · fixtures: [`fixtures/policies/`](../fixtures/policies/)

```ts
import { approvalGate, loadPolicy } from 'agent-action-gate';
const policy = loadPolicy(JSON.parse(fs.readFileSync('payments-refund.policy.json', 'utf8')));
approvalGate(policy, { tool: 'payments.refund', agent: 'support-bot-1', role: 'support_agent', args: { amount: 4200, currency: 'SEK' } });
// { effect: 'require_approval', decidingRules: ['refund-large-approval'], reasons: [...], approvers: ['finance-lead','cfo'], approvalTtlSec: 600 }
```

## Rule evaluation
1. A rule matches when its `tool` glob matches the tool name, the agent's `role` is in `roles` (if set), and every `when` condition holds.
2. **All** matching rules are collected. The most restrictive effect wins: `deny` > `require_approval` > `allow`.
   Rule order never matters, so adding an `allow` rule can never override a `deny`.
3. No rule matched → `defaultEffect`. If `defaultEffect` is omitted, the gate **fails closed** (`deny`).
4. Several `require_approval` rules: allowed approvers are the **intersection** of their `approvers`; the approval expiry is the **shortest** `approvalTtlSec`.

## Tool permission per role
`roles: ["support_agent"]` scopes a rule to agent roles. A call without a matching role simply does not match that rule; with a deny default this
becomes "this agent has no tool permission for this tool".

## Conditions (`when`)
Keys are dot paths into the tool arguments (`amount`, `target.env`). Operators: `eq`, `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`,
`matches` (anchored regex), `exists`. Numeric operators never coerce strings (`"10"` is not `> 5`).

**Fail closed on unknowns.** A condition is *unknown* when the argument has a type the operator cannot compare
(`"100000"` against `gt`, a number against `matches`, a non-JSON value) or when it is missing for `ne` / `notIn`.
An unknown condition makes a `deny` or `require_approval` rule match and an `allow` rule not match, so an agent cannot
dodge a limit by sending the amount as a string or by leaving out `env`. Other operators on a missing argument simply fail
(only `exists: false` holds). If several approval rules leave no common approver, the decision becomes `deny`. Only own properties are read, so `toString` or `__proto__` cannot be smuggled in.

## Validation
`loadPolicy()` rejects unknown operators, invalid regexes, duplicate rule ids, unknown effects and rules without a `reason`
(the reason is what the decision log shows). See [policy-format.md](policy-format.md).

## CLI
```bash
agent-action-gate check fixtures/policies/payments-refund.policy.json fixtures/tool-calls/refund-large.call.json
# require_approval [refund-large-approval]: refunds above 500 need a human approval request to finance   (exit 3)
```
Exit codes: 0 allow, 3 require_approval, 4 deny, 2 usage/invalid policy.
