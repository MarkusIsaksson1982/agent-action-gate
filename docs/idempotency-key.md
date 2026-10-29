# Idempotency keys for agent tool calls (dedupe repeated tool calls)

Use when an agent may send the same tool call twice (timeouts, retries, replayed `tool_call` messages, re-planning) and the tool has side effects.

Source: [`src/gate/idempotency-key.ts`](../src/gate/idempotency-key.ts) · tests: [`test/idempotency-key.test.ts`](../test/idempotency-key.test.ts)

```ts
idempotencyKey('email.send', { to: 'a@x', body: 'hi' }, 'agent-1'); // 'idk_…' = sha256(canonical JSON of scope+tool+args)
const store = new IdempotencyStore(24 * 3600_000);
store.begin(key, fingerprint);   // { state: 'new' } -> you own the key, run the tool
store.complete(key, result);     // later begin()/peek() -> { state: 'completed', result }
store.release(key);              // tool failed: allow a retry
```

- Key source: pass the model's `tool_call` id (or your own Idempotency-Key header) as `idempotencyKey`; otherwise the guard derives one from
  the canonical arguments, so `{a,b}` and `{b,a}` dedupe to the same key.
- **Replay**: a completed key returns the first result (`status: 'duplicate'`) and never executes the tool again.
- **In flight**: a concurrent duplicate gets `in_flight` instead of a second execution.
- **Conflict**: the same key with *different* arguments is refused (`IdempotencyConflictError`), like Stripe's Idempotency-Key semantics.
- **TTL**: entries expire after `ttlMs` (default 24 h).
- Failed calls release the key so the agent can retry safely.
