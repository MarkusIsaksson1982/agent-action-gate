// agent-action-gate: validate LLM-agent action proposals against a policy, block duplicates, route large amounts to human
// approval and keep a hash-chained audit log. Strict TypeScript, no dependencies beyond node:crypto. Synthetic data only.
import { createHash } from 'node:crypto';

export type FieldType = 'string' | 'number' | 'integer' | 'boolean';
export interface FieldSpec { type: FieldType; required?: boolean; min?: number; max?: number; pattern?: string }
export interface ToolPolicy { roles: string[]; fields: Record<string, FieldSpec>; amountField?: string; approvalAbove?: number; hardLimit?: number }
export type Policy = Record<string, ToolPolicy>;
export interface Proposal { id: string; agent: string; role: string; tool: string; args: Record<string, unknown>; rationale: string; idempotencyKey: string }
export type ErrorCode = 'empty_rationale' | 'unknown_tool' | 'role_not_allowed' | 'missing_field' | 'unknown_field' | 'wrong_type' | 'out_of_range' | 'pattern_mismatch' | 'over_hard_limit';
export interface GateError { code: ErrorCode; field?: string }
export type Kind = 'execute' | 'needs_approval' | 'reject' | 'duplicate';
export interface Decision { kind: Kind; errors: GateError[] }
export interface AuditEvent { seq: number; proposalId: string; tool: string; kind: Kind; codes: ErrorCode[]; prevHash: string; hash: string }

const ZERO = '0'.repeat(64);
const KINDS: Kind[] = ['execute', 'needs_approval', 'reject', 'duplicate'];

function typeOk(t: FieldType, v: unknown): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
  }
}

function amountOf(tool: ToolPolicy, args: Record<string, unknown>): number | undefined {
  if (tool.amountField === undefined) return undefined;
  const v = args[tool.amountField];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function validateProposal(p: Proposal, policy: Policy): GateError[] {
  const errors: GateError[] = [];
  if (p.rationale.trim() === '') errors.push({ code: 'empty_rationale' });
  if (!Object.prototype.hasOwnProperty.call(policy, p.tool)) { errors.push({ code: 'unknown_tool' }); return errors; }
  const tool = policy[p.tool] as ToolPolicy;
  if (!tool.roles.includes(p.role)) errors.push({ code: 'role_not_allowed' });
  const names = [...new Set([...Object.keys(tool.fields), ...Object.keys(p.args)])].sort();
  for (const name of names) {
    const spec = Object.prototype.hasOwnProperty.call(tool.fields, name) ? tool.fields[name] : undefined;
    if (!spec) { errors.push({ code: 'unknown_field', field: name }); continue; }
    const v = p.args[name];
    if (v === undefined) { if (spec.required) errors.push({ code: 'missing_field', field: name }); continue; }
    if (!typeOk(spec.type, v)) { errors.push({ code: 'wrong_type', field: name }); continue; }
    if ((spec.type === 'number' || spec.type === 'integer') && typeof v === 'number') {
      if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) errors.push({ code: 'out_of_range', field: name });
    } else if (spec.type === 'string' && spec.pattern !== undefined && typeof v === 'string') {
      if (!new RegExp('^(?:' + spec.pattern + ')$').test(v)) errors.push({ code: 'pattern_mismatch', field: name });
    }
  }
  const amount = amountOf(tool, p.args);
  if (tool.hardLimit !== undefined && amount !== undefined && amount > tool.hardLimit) errors.push({ code: 'over_hard_limit' });
  return errors;
}

export function decide(p: Proposal, policy: Policy, seen: Set<string>): Decision {
  if (seen.has(p.idempotencyKey)) return { kind: 'duplicate', errors: [] };
  const errors = validateProposal(p, policy);
  if (errors.length) return { kind: 'reject', errors };
  const tool = policy[p.tool] as ToolPolicy;
  const amount = amountOf(tool, p.args);
  seen.add(p.idempotencyKey);
  if (tool.approvalAbove !== undefined && amount !== undefined && amount > tool.approvalAbove) return { kind: 'needs_approval', errors: [] };
  return { kind: 'execute', errors: [] };
}

const hashOf = (seq: number, id: string, tool: string, kind: Kind, codes: ErrorCode[], prev: string): string =>
  createHash('sha256').update(JSON.stringify([seq, id, tool, kind, codes, prev])).digest('hex');

export function appendEvent(log: AuditEvent[], p: Proposal, d: Decision): AuditEvent {
  const seq = log.length; const prevHash = seq === 0 ? ZERO : (log[seq - 1] as AuditEvent).hash;
  const codes = d.errors.map((e) => e.code);
  const ev: AuditEvent = { seq, proposalId: p.id, tool: p.tool, kind: d.kind, codes, prevHash, hash: hashOf(seq, p.id, p.tool, d.kind, codes, prevHash) };
  log.push(ev); return ev;
}

export function verifyLog(log: AuditEvent[]): number {
  for (let i = 0; i < log.length; i++) {
    const e = log[i] as AuditEvent; const prev = i === 0 ? ZERO : (log[i - 1] as AuditEvent).hash;
    if (e.seq !== i || e.prevHash !== prev || e.hash !== hashOf(e.seq, e.proposalId, e.tool, e.kind, e.codes, e.prevHash)) return i;
  }
  return -1;
}

export function handler(event: { body?: string | null }, ctx: { policy: Policy; seen: Set<string>; log: AuditEvent[] }): { statusCode: number; body: string } {
  const bad = { statusCode: 400, body: JSON.stringify({ error: 'bad_json' }) };
  if (typeof event.body !== 'string') return bad;
  let parsed: unknown;
  try { parsed = JSON.parse(event.body); } catch { return bad; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return bad;
  const p = parsed as Proposal;
  const d = decide(p, ctx.policy, ctx.seen); const ev = appendEvent(ctx.log, p, d);
  const status: Record<Kind, number> = { execute: 200, duplicate: 200, needs_approval: 202, reject: 422 };
  return { statusCode: status[d.kind], body: JSON.stringify({ kind: d.kind, errors: d.errors, seq: ev.seq }) };
}

export function evaluate(cases: { proposal: Proposal; expected: Kind }[], policy: Policy) {
  const seen = new Set<string>();
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { expected: 0, correct: 0 }])) as Record<Kind, { expected: number; correct: number }>;
  let correct = 0, unsafeExecutes = 0;
  for (const c of cases) {
    const got = decide(c.proposal, policy, seen).kind;
    byKind[c.expected].expected++;
    if (got === c.expected) { correct++; byKind[c.expected].correct++; }
    if (got === 'execute' && c.expected !== 'execute') unsafeExecutes++;
  }
  return { total: cases.length, correct, unsafeExecutes, byKind };
}
