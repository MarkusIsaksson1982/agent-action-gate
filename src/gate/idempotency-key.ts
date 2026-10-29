// Idempotency key: dedupe repeated tool calls from an agent.
// An LLM agent that retries (timeouts, re-planning, duplicated tool_call
// messages) must not send the same refund or email twice. The key is either supplied by the agent or derived from
// sha256(canonicalJson({tool, args, agent})); the store remembers the first outcome and replays it for repeats.
import { canonicalJson, sha256Hex } from './canonical-json.js';

export function idempotencyKey(tool: string, args: Record<string, unknown>, scope = ''): string {
  return 'idk_' + sha256Hex(canonicalJson({ scope, tool, args })).slice(0, 32);
}

export type IdempotencyState<T> =
  | { state: 'new' }
  | { state: 'in_flight'; startedAt: number }
  | { state: 'completed'; result: T; completedAt: number };

/** Stored and replayed results are copies, so mutating one replay cannot change the next. */
function copy<T>(v: T): T { try { return structuredClone(v); } catch { return v; } }

interface Entry<T> { fingerprint: string; startedAt: number; done: boolean; result?: T; completedAt?: number }

export class IdempotencyConflictError extends Error {
  constructor(public readonly key: string) { super(`idempotency key ${key} reused with different tool arguments`); }
}

/** In-memory idempotency store with TTL. Swap for Redis/SQL in production; the interface is small on purpose. */
export class IdempotencyStore<T = unknown> {
  private entries = new Map<string, Entry<T>>();
  constructor(private readonly ttlMs = 24 * 3600_000, private readonly now: () => number = Date.now) {}

  private live(key: string): Entry<T> | undefined {
    const e = this.entries.get(key);
    // only completed entries expire; an in-flight call keeps its key however long it runs
    if (e && e.done && this.now() - e.completedAt! > this.ttlMs) { this.entries.delete(key); return undefined; }
    return e;
  }

  /** Claim a key before executing. Returns the previous state; 'new' means the caller now owns the key. */
  begin(key: string, fingerprint: string): IdempotencyState<T> {
    const e = this.live(key);
    if (!e) { this.entries.set(key, { fingerprint, startedAt: this.now(), done: false }); return { state: 'new' }; }
    if (e.fingerprint !== fingerprint) throw new IdempotencyConflictError(key);
    return e.done ? { state: 'completed', result: copy(e.result as T), completedAt: e.completedAt! } : { state: 'in_flight', startedAt: e.startedAt };
  }

  /** Look without claiming (used by the guard before the approval step). */
  peek(key: string, fingerprint?: string): IdempotencyState<T> {
    const e = this.live(key);
    if (!e) return { state: 'new' };
    if (fingerprint !== undefined && e.fingerprint !== fingerprint) throw new IdempotencyConflictError(key);
    return e.done ? { state: 'completed', result: copy(e.result as T), completedAt: e.completedAt! } : { state: 'in_flight', startedAt: e.startedAt };
  }

  complete(key: string, result: T): void {
    const e = this.entries.get(key);
    if (!e) throw new Error(`complete(): unknown idempotency key ${key}`);
    e.done = true; e.result = copy(result); e.completedAt = this.now();
  }

  /** Release a key whose call failed, so a retry may run again. */
  release(key: string): void { this.entries.delete(key); }

  get size(): number { return this.entries.size; }
}
