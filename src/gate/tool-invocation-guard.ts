// Tool invocation guard: wraps an agent's tool functions so that every tool call goes through
//   1. the policy check before the call (approvalGate: allow / deny / require_approval),
//   2. idempotency (a repeated call with the same idempotency key returns the first result, never runs twice),
//   3. the human-in-the-loop approval queue (with approval expiry),
//   4. the decision log, appended to the hash-chained audit log.
// The guard never throws for policy outcomes; it returns a GuardResult the agent loop can turn into a tool_result.
import { approvalGate, type ToolCall, type ToolPolicy, type PolicyDecision } from './policy-check.js';
import { IdempotencyStore, IdempotencyConflictError, idempotencyKey } from './idempotency-key.js';
import { PendingApprovalQueue } from './approval-queue.js';
import { AuditLog } from './audit-log.js';
import { decisionLogEntry, type DecisionLogEntry, type Outcome } from './decision-log.js';
import { canonicalJson, sha256Hex } from './canonical-json.js';

export type GuardResult<R> =
  | { status: 'executed'; result: R; decision: DecisionLogEntry }
  | { status: 'duplicate'; result: R; decision: DecisionLogEntry }
  | { status: 'denied'; decision: DecisionLogEntry }
  | { status: 'pending_approval'; approvalRequestId: string; expiresAt: number; decision: DecisionLogEntry }
  | { status: 'in_flight'; decision: DecisionLogEntry }
  | { status: 'failed'; error: string; decision: DecisionLogEntry };

export interface GuardOptions {
  policy: ToolPolicy;
  audit?: AuditLog;
  queue?: PendingApprovalQueue;
  idempotency?: IdempotencyStore<unknown>;
  now?: () => number;
}

export interface InvokeOptions { idempotencyKey?: string }

export type ToolFn<A extends Record<string, unknown>, R> = (args: A) => R | Promise<R>;

export class ToolInvocationGuard {
  readonly policy: ToolPolicy; readonly audit: AuditLog; readonly queue: PendingApprovalQueue; readonly idempotency: IdempotencyStore<unknown>;

  constructor(o: GuardOptions) {
    this.policy = o.policy;
    this.audit = o.audit ?? new AuditLog(o.now ? { now: () => new Date(o.now!()) } : {});
    const ttl = o.policy.approvalTtlSec;
    this.queue = o.queue ?? new PendingApprovalQueue({ ...(ttl !== undefined ? { defaultTtlSec: ttl } : {}), ...(o.now ? { now: o.now } : {}),
      onEvent: (e) => this.audit.append(e.type, { id: e.request.id, tool: e.request.tool, status: e.request.status, idempotencyKey: e.request.idempotencyKey,
        ...(e.request.decidedBy ? { decidedBy: e.request.decidedBy } : {}), expiresAt: new Date(e.request.expiresAt).toISOString() }) });
    this.idempotency = o.idempotency ?? new IdempotencyStore(undefined, o.now);
  }

  private log(call: ToolCall, key: string, argsHash: string, d: PolicyDecision, outcome: Outcome, extra: Parameters<typeof decisionLogEntry>[5] = {}): DecisionLogEntry {
    const e = decisionLogEntry(call, key, argsHash, d, outcome, extra);
    this.audit.append('decision', e);
    return e;
  }

  /** Guard one tool call. `fn` only runs when policy (and, if required, a human) allows it, and at most once per key. */
  async invoke<A extends Record<string, unknown>, R>(call: ToolCall & { args: A }, fn: ToolFn<A, R>, opts: InvokeOptions = {}): Promise<GuardResult<R>> {
    const key = opts.idempotencyKey ?? idempotencyKey(call.tool, call.args, call.agent);
    const argsHash = sha256Hex(canonicalJson(call.args));
    const fingerprint = call.tool + ':' + argsHash;
    const d = approvalGate(this.policy, call);

    if (d.effect === 'deny') return { status: 'denied', decision: this.log(call, key, argsHash, d, 'denied') };

    let prior;
    try { prior = this.idempotency.peek(key, fingerprint); }
    catch (err) {
      if (err instanceof IdempotencyConflictError)
        return { status: 'denied', decision: this.log(call, key, argsHash, d, 'denied', { reasons: [err.message] }) };
      throw err;
    }
    if (prior.state === 'completed') return { status: 'duplicate', result: prior.result as R, decision: this.log(call, key, argsHash, d, 'duplicate', { reasons: ['idempotency key already executed; returning the first result'] }) };
    if (prior.state === 'in_flight') return { status: 'in_flight', decision: this.log(call, key, argsHash, d, 'in_flight', { reasons: ['same idempotency key is executing right now'] }) };

    let approvedBy: string | undefined; let approvalRequestId: string | undefined;
    if (d.effect === 'require_approval') {
      const existing = this.queue.findByIdempotencyKey(key);
      if (existing?.status === 'approved') {
        approvalRequestId = existing.id; approvedBy = existing.decidedBy;
      } else if (existing?.status === 'pending') {
        return { status: 'pending_approval', approvalRequestId: existing.id, expiresAt: existing.expiresAt,
          decision: this.log(call, key, argsHash, d, 'pending_approval', { approvalRequestId: existing.id }) };
      } else if (existing?.status === 'denied') {
        return { status: 'denied', decision: this.log(call, key, argsHash, d, 'denied', { approvalRequestId: existing.id,
          reasons: [`approval denied by ${existing.decidedBy}${existing.note ? ': ' + existing.note : ''}`] }) };
      } else {
        if (existing?.status === 'expired') this.log(call, key, argsHash, d, 'approval_expired', { approvalRequestId: existing.id, reasons: ['approval expiry passed before a human decided; requesting again'] });
        const r = this.queue.request({ tool: call.tool, args: call.args, idempotencyKey: key, requestedBy: call.agent, reasons: d.reasons,
          ...(d.approvers ? { approvers: d.approvers } : {}), ...(d.approvalTtlSec !== undefined ? { ttlSec: d.approvalTtlSec } : {}) });
        return { status: 'pending_approval', approvalRequestId: r.id, expiresAt: r.expiresAt, decision: this.log(call, key, argsHash, d, 'pending_approval', { approvalRequestId: r.id }) };
      }
    }

    this.idempotency.begin(key, fingerprint);
    if (approvalRequestId) this.queue.consume(approvalRequestId);
    const extra = { ...(approvalRequestId ? { approvalRequestId } : {}), ...(approvedBy ? { approvedBy } : {}) };
    try {
      const result = await fn(call.args);
      this.idempotency.complete(key, result);
      return { status: 'executed', result, decision: this.log(call, key, argsHash, d, 'executed', extra) };
    } catch (err) {
      this.idempotency.release(key);
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', error: msg, decision: this.log(call, key, argsHash, d, 'failed', { ...extra, error: msg }) };
    }
  }

  /** Wrap a tool function once; the agent loop calls the returned function with (args, agent, role?). */
  wrap<A extends Record<string, unknown>, R>(tool: string, fn: ToolFn<A, R>) {
    return (args: A, ctx: { agent: string; role?: string; idempotencyKey?: string }) =>
      this.invoke<A, R>({ tool, args, agent: ctx.agent, ...(ctx.role !== undefined ? { role: ctx.role } : {}) }, fn,
        ctx.idempotencyKey !== undefined ? { idempotencyKey: ctx.idempotencyKey } : {});
  }
}
