// Pending approval queue (human in the loop): approval request, approval expiry, approve / deny by a human.
// A require_approval decision creates an ApprovalRequest with an
// approval expiry. A human approves or denies it; agents cannot approve their own requests; expired requests can
// no longer be approved. Every transition is reported through an optional onEvent hook (wired to the audit log).

const MAX_TTL = 30 * 24 * 3600;

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';

export interface ApprovalRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
  requestedBy: string;
  reasons: string[];
  approvers?: string[];
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: number;
  note?: string;
}

export class ApprovalError extends Error {
  constructor(public readonly code: 'not_found' | 'not_pending' | 'expired' | 'self_approval' | 'not_an_approver' | 'duplicate_request', message: string) { super(message); }
}

export type ApprovalEvent = { type: 'approval.requested' | 'approval.approved' | 'approval.denied' | 'approval.expired' | 'approval.consumed'; request: ApprovalRequest };

export interface QueueOptions { defaultTtlSec?: number; now?: () => number; onEvent?: (e: ApprovalEvent) => void; newId?: () => string }

export class PendingApprovalQueue {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly byKey = new Map<string, string>();
  private readonly ttl: number; private readonly now: () => number;
  private readonly listeners: ((e: ApprovalEvent) => void)[] = []; private readonly newId: () => string;
  private counter = 0;

  constructor(o: QueueOptions = {}) {
    this.ttl = o.defaultTtlSec ?? 900; this.now = o.now ?? Date.now; if (o.onEvent) this.listeners.push(o.onEvent);
    if (!(Number.isFinite(this.ttl) && this.ttl > 0 && this.ttl <= MAX_TTL)) throw new RangeError('defaultTtlSec must be a positive number of seconds (max 30 days)');
    this.newId = o.newId ?? (() => `apr_${(++this.counter).toString().padStart(6, '0')}`);
  }

  /** Add a listener for approval lifecycle events (the guard uses this to write them to the audit log). */
  subscribe(fn: (e: ApprovalEvent) => void): void { this.listeners.push(fn); }

  private emit(type: ApprovalEvent['type'], r: ApprovalRequest) { for (const l of this.listeners) l({ type, request: structuredClone(r) }); }

  /** Marks the request expired if its approval expiry has passed. An approval that was granted but not used
   *  before expiresAt expires too, so an approval never authorises a call indefinitely. */
  private refresh(r: ApprovalRequest): ApprovalStatus {
    if ((r.status === 'pending' || r.status === 'approved') && this.now() >= r.expiresAt) { r.status = 'expired'; this.emit('approval.expired', r); }
    return r.status;
  }

  request(input: { tool: string; args: Record<string, unknown>; idempotencyKey: string; requestedBy: string; reasons: string[]; approvers?: string[]; ttlSec?: number }): ApprovalRequest {
    const ttl = input.ttlSec ?? this.ttl;
    if (!(Number.isFinite(ttl) && ttl > 0 && ttl <= MAX_TTL)) throw new RangeError('ttlSec must be a positive number of seconds (max 30 days)');
    const prev = this.byKey.get(input.idempotencyKey);
    if (prev) { const s = this.refresh(this.requests.get(prev)!); if (s === 'pending' || s === 'approved')
      throw new ApprovalError('duplicate_request', `idempotency key ${input.idempotencyKey} already has an open approval request ${prev}`); }
    const t = this.now();
    const r: ApprovalRequest = { id: this.newId(), tool: input.tool, args: structuredClone(input.args), idempotencyKey: input.idempotencyKey,
      requestedBy: input.requestedBy, reasons: [...input.reasons], createdAt: t, expiresAt: t + ttl * 1000, status: 'pending' };
    if (input.approvers) r.approvers = [...input.approvers];
    this.requests.set(r.id, r); this.byKey.set(r.idempotencyKey, r.id);
    this.emit('approval.requested', r);
    return structuredClone(r);
  }

  get(id: string): ApprovalRequest | undefined { const r = this.requests.get(id); if (!r) return undefined; this.refresh(r); return structuredClone(r); }

  /** Latest approval request for an idempotency key (how a retried tool call finds its approval). */
  findByIdempotencyKey(key: string): ApprovalRequest | undefined { const id = this.byKey.get(key); return id ? this.get(id) : undefined; }

  private decide(id: string, by: string, approve: boolean, note?: string): ApprovalRequest {
    const r = this.requests.get(id);
    if (!r) throw new ApprovalError('not_found', `no approval request ${id}`);
    const s = this.refresh(r);
    if (s === 'expired') throw new ApprovalError('expired', `approval request ${id} expired at ${new Date(r.expiresAt).toISOString()}`);
    if (s !== 'pending') throw new ApprovalError('not_pending', `approval request ${id} is already ${s}`);
    if (approve && by === r.requestedBy) throw new ApprovalError('self_approval', `${by} cannot approve its own request`);
    if (approve && r.approvers && !r.approvers.includes(by)) throw new ApprovalError('not_an_approver', `${by} is not an allowed approver for ${id}`);
    r.status = approve ? 'approved' : 'denied'; r.decidedBy = by; r.decidedAt = this.now();
    if (note !== undefined) r.note = note;
    this.emit(approve ? 'approval.approved' : 'approval.denied', r);
    return structuredClone(r);
  }

  approve(id: string, approver: string, note?: string): ApprovalRequest { return this.decide(id, approver, true, note); }
  deny(id: string, approver: string, note?: string): ApprovalRequest { return this.decide(id, approver, false, note); }

  /** An approval is single-use: the guard consumes it when it executes the tool call. */
  consume(id: string): ApprovalRequest {
    const r = this.requests.get(id);
    if (!r) throw new ApprovalError('not_found', `no approval request ${id}`);
    const st = this.refresh(r);
    if (st === 'expired') throw new ApprovalError('expired', `approval request ${id} expired before it was used`);
    if (st !== 'approved') throw new ApprovalError('not_pending', `approval request ${id} is ${st}, not approved`);
    r.status = 'consumed'; this.emit('approval.consumed', r);
    return structuredClone(r);
  }

  /** Sweep: mark every pending request past its approval expiry as expired. Returns the expired ones. */
  expireStale(): ApprovalRequest[] {
    const out: ApprovalRequest[] = [];
    for (const r of this.requests.values()) if ((r.status === 'pending' || r.status === 'approved') && this.refresh(r) === 'expired') out.push(structuredClone(r));
    return out;
  }

  pending(): ApprovalRequest[] { return [...this.requests.values()].filter((r) => this.refresh(r) === 'pending').map((r) => (structuredClone(r))); }
}
