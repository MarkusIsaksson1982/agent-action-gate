# Human in the loop: pending approval queue with approval expiry

Use when an agent's tool call needs a person to sign off, and the sign-off must expire if nobody answers.

Source: [`src/gate/approval-queue.ts`](../src/gate/approval-queue.ts) · tests: [`test/approval-queue.test.ts`](../test/approval-queue.test.ts)

```ts
const q = new PendingApprovalQueue({ defaultTtlSec: 900, onEvent: (e) => audit.append(e.type, { id: e.request.id, status: e.request.status }) }); // don't log raw args (PII)
const r = q.request({ tool: 'deploy.service', args, idempotencyKey: key, requestedBy: 'release-agent', reasons: ['production deploy'], approvers: ['oncall'] });
q.pending();                       // what a reviewer UI / Slack bot lists
q.approve(r.id, 'oncall', 'LGTM'); // or q.deny(r.id, 'oncall', 'not during freeze')
q.expireStale();                   // cron sweep: pending requests past expiresAt -> expired
```

## Approval request lifecycle
```
pending ──approve──▶ approved ──consume (tool runs)──▶ consumed
   │  └──deny─────▶ denied
   └──now ≥ expiresAt──▶ expired
```
- **Approval expiry**: `expiresAt = createdAt + ttl`. An expired request can no longer be approved (`ApprovalError('expired')`),
  and an approval that was granted but not used before `expiresAt` expires too, so an approval never authorises a call indefinitely.
  Expiry is evaluated lazily on every read and eagerly by `expireStale()`. TTLs must be positive.
- **No self-approval**: the requesting agent can never approve its own request (`self_approval`). It may withdraw it via `deny`.
- **Approver allow-list**: when the policy rule lists `approvers`, anyone else gets `not_an_approver`.
- **Single use**: an approval authorises exactly one execution; the guard calls `consume()` right before running the tool.
- **No double decisions**: deciding a non-pending request throws `not_pending`.
- **One open request per idempotency key**: a second `request()` while one is pending/approved throws `duplicate_request`.
- TTLs must be positive and at most 30 days.
- Arguments are deep-copied at request time and every returned request is a deep copy, so nobody can change what was approved after the fact.
- The guard binds an approval to its tool + arguments: re-using the idempotency key with a different payload is denied.

Every transition fires `onEvent` (`approval.requested|approved|denied|expired|consumed`), which `ToolInvocationGuard` writes to the audit log (also for a queue you inject; extra listeners via `queue.subscribe()`).
The queue is in memory. The guard's audit events carry id, tool, status, key, requestedBy, decidedBy and expiry but not the raw arguments,
so to persist pending requests across restarts implement the same interface on a database.
