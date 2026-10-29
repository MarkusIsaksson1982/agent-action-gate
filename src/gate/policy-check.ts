import { canonicalJson } from './canonical-json.js';

// Approval gate: policy check before tool call, tool permission rules per tool and agent role.
// approvalGate: the policy check before a tool call. Each rule matches a tool name (exact or glob like "db.*"),
// optionally an agent role and conditions on the tool arguments, and has an effect: allow, deny or require_approval.
// All matching rules are collected; the most restrictive effect wins (deny > require_approval > allow).
// If nothing matches, policy.defaultEffect applies (default: deny, i.e. fail closed).

export type Effect = 'allow' | 'deny' | 'require_approval';

/** Condition on one argument, addressed by a dot path like "amount" or "target.env". */
export interface ArgCondition {
  eq?: unknown; ne?: unknown; in?: unknown[]; notIn?: unknown[];
  gt?: number; gte?: number; lt?: number; lte?: number;
  /** anchored regular expression the string value must match */
  matches?: string;
  /** true: the argument must be present; false: it must be absent */
  exists?: boolean;
}

export interface PolicyRule {
  id: string;
  /** tool name, or glob with `*` (e.g. "fs.*", "*") */
  tool: string;
  effect: Effect;
  /** human-readable reason written to the decision log */
  reason: string;
  /** only applies to these agent roles (any role if omitted) */
  roles?: string[];
  /** all conditions must hold for the rule to match */
  when?: Record<string, ArgCondition>;
  /** require_approval only: who may approve (any human if omitted) */
  approvers?: string[];
  /** require_approval only: approval expiry in seconds (overrides policy default) */
  approvalTtlSec?: number;
}

export interface ToolPolicy {
  version: 1;
  name?: string;
  defaultEffect?: Effect;
  /** default approval expiry in seconds for require_approval rules */
  approvalTtlSec?: number;
  rules: PolicyRule[];
}

export interface ToolCall { tool: string; args: Record<string, unknown>; agent: string; role?: string }

export interface PolicyDecision {
  effect: Effect;
  /** ids of every rule that matched, in policy order */
  matchedRules: string[];
  /** the rule(s) that produced the winning effect */
  decidingRules: string[];
  /** reasons from the deciding rules, or a default-effect reason */
  reasons: string[];
  approvers?: string[];
  approvalTtlSec?: number;
}

const RANK: Record<Effect, number> = { allow: 0, require_approval: 1, deny: 2 };
const EFFECTS = new Set<Effect>(['allow', 'deny', 'require_approval']);
const COND_KEYS = new Set(['eq', 'ne', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'matches', 'exists']);
const RULE_KEYS = new Set(['id', 'tool', 'effect', 'reason', 'roles', 'when', 'approvers', 'approvalTtlSec']);
const POLICY_KEYS = new Set(['version', 'name', 'defaultEffect', 'approvalTtlSec', 'rules', 'description']);
/** upper bound for approval expiry: 30 days */
export const MAX_APPROVAL_TTL_SEC = 30 * 24 * 3600;

export class PolicyError extends Error {}

export function globToRegExp(glob: string): RegExp {
  const esc = glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + esc + '$');
}

export function getArg(args: Record<string, unknown>, path: string): { present: boolean; value: unknown } {
  let cur: unknown = args;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return { present: false, value: undefined };
    cur = (cur as Record<string, unknown>)[part];
  }
  return { present: cur !== undefined, value: cur };
}

const canon = (v: unknown): string | undefined => { try { return canonicalJson(v); } catch { return undefined; } };

/** Result of one condition: holds, fails, or unknown (argument missing for ne/notIn, or of a type the
 *  operator cannot compare, e.g. "100000" against gt). Unknown is resolved fail-closed by ruleMatches. */
export type ConditionStatus = 'holds' | 'fails' | 'unknown';

export function conditionStatus(c: ArgCondition, present: boolean, v: unknown): ConditionStatus {
  if (c.exists !== undefined && c.exists !== present) return 'fails';
  if (!present) {
    if ('ne' in c || 'notIn' in c) return 'unknown';
    return Object.keys(c).every((k) => k === 'exists') ? 'holds' : 'fails';
  }
  const cv = canon(v);
  if (cv === undefined && ('eq' in c || 'ne' in c || c.in || c.notIn)) return 'unknown';
  let unknown = false;
  if ('eq' in c && cv !== canon(c.eq)) return 'fails';
  if ('ne' in c && cv === canon(c.ne)) return 'fails';
  if (c.in && !c.in.some((x) => canon(x) === cv)) return 'fails';
  if (c.notIn && c.notIn.some((x) => canon(x) === cv)) return 'fails';
  const numOps = (['gt', 'gte', 'lt', 'lte'] as const).filter((k) => c[k] !== undefined);
  if (numOps.length) {
    if (!(typeof v === 'number' && Number.isFinite(v))) unknown = true;
    else for (const k of numOps) {
      const b = c[k]!; const ok = k === 'gt' ? v > b : k === 'gte' ? v >= b : k === 'lt' ? v < b : v <= b;
      if (!ok) return 'fails';
    }
  }
  if (c.matches !== undefined) {
    if (typeof v !== 'string') unknown = true;
    else if (!new RegExp('^(?:' + c.matches + ')$').test(v)) return 'fails';
  }
  return unknown ? 'unknown' : 'holds';
}

export function conditionHolds(c: ArgCondition, present: boolean, v: unknown): boolean { return conditionStatus(c, present, v) === 'holds'; }

/** A rule matches when tool, role and all conditions hold. If a condition is 'unknown' (wrong type, or missing
 *  argument for ne/notIn), a deny or require_approval rule still matches and an allow rule does not, so an agent
 *  cannot dodge a limit by sending "100000" as a string or by omitting the argument (fail closed). */
export function ruleMatches(rule: PolicyRule, call: ToolCall): boolean {
  if (!globToRegExp(rule.tool).test(call.tool)) return false;
  if (rule.roles && !(call.role !== undefined && rule.roles.includes(call.role))) return false;
  for (const [path, cond] of Object.entries(rule.when ?? {})) {
    const { present, value } = getArg(call.args, path);
    const st = conditionStatus(cond, present, value);
    if (st === 'fails' || (st === 'unknown' && rule.effect === 'allow')) return false;
  }
  return true;
}

/** Validate a policy object (e.g. parsed from JSON). Throws PolicyError with a precise message. */
export function loadPolicy(raw: unknown): ToolPolicy {
  const fail = (m: string): never => { throw new PolicyError(m); };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('policy must be an object');
  const p = raw as Record<string, unknown>;
  if (p.version !== 1) fail('policy.version must be 1');
  if (p.defaultEffect !== undefined && !EFFECTS.has(p.defaultEffect as Effect)) fail('policy.defaultEffect is invalid');
  for (const k of Object.keys(p)) if (!POLICY_KEYS.has(k)) fail(`unknown policy field "${k}"`);
  const ttlOk = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_APPROVAL_TTL_SEC);
  if (!ttlOk(p.approvalTtlSec)) fail('policy.approvalTtlSec must be a positive number of seconds');
  if (!Array.isArray(p.rules)) fail('policy.rules must be an array');
  const ids = new Set<string>();
  (p.rules as unknown[]).forEach((r, i) => {
    if (r === null || typeof r !== 'object') fail(`rules[${i}] must be an object`);
    const rule = r as Record<string, unknown>;
    // a typo like "approver" must not silently drop a restriction
    for (const k of Object.keys(rule)) if (!RULE_KEYS.has(k)) fail(`rules[${i}]: unknown field "${k}"`);
    if (typeof rule.id !== 'string' || rule.id === '') fail(`rules[${i}].id must be a non-empty string`);
    if (ids.has(rule.id as string)) fail(`duplicate rule id "${String(rule.id)}"`);
    ids.add(rule.id as string);
    if (typeof rule.tool !== 'string' || rule.tool === '') fail(`rules[${i}].tool must be a non-empty string`);
    if (!EFFECTS.has(rule.effect as Effect)) fail(`rules[${i}].effect must be allow, deny or require_approval`);
    if (typeof rule.reason !== 'string' || rule.reason.trim() === '') fail(`rules[${i}].reason is required (it goes into the decision log)`);
    if (!ttlOk(rule.approvalTtlSec)) fail(`rules[${i}].approvalTtlSec must be a positive number of seconds`);
    if (rule.roles !== undefined && !(Array.isArray(rule.roles) && rule.roles.every((x) => typeof x === 'string'))) fail(`rules[${i}].roles must be an array of strings`);
    if (rule.approvers !== undefined && !(Array.isArray(rule.approvers) && rule.approvers.length > 0 && rule.approvers.every((x) => typeof x === 'string'))) fail(`rules[${i}].approvers must be a non-empty array of strings`);
    if (rule.when !== undefined) {
      if (rule.when === null || typeof rule.when !== 'object') fail(`rules[${i}].when must be an object`);
      for (const [path, cond] of Object.entries(rule.when as object)) {
        if (cond === null || typeof cond !== 'object') fail(`rules[${i}].when.${path} must be an object`);
        const c = cond as Record<string, unknown>;
        if (Object.keys(c).length === 0) fail(`rules[${i}].when.${path} has no operator`);
        for (const k of Object.keys(c)) if (!COND_KEYS.has(k)) fail(`rules[${i}].when.${path}: unknown operator "${k}"`);
        for (const k of ['in', 'notIn']) if (k in c && !Array.isArray(c[k])) fail(`rules[${i}].when.${path}.${k} must be an array`);
        for (const k of ['gt', 'gte', 'lt', 'lte']) if (k in c && !(typeof c[k] === 'number' && Number.isFinite(c[k]))) fail(`rules[${i}].when.${path}.${k} must be a number`);
        if ('matches' in c && typeof c.matches !== 'string') fail(`rules[${i}].when.${path}.matches must be a string`);
        if ('exists' in c && typeof c.exists !== 'boolean') fail(`rules[${i}].when.${path}.exists must be a boolean`);
        const m = (cond as ArgCondition).matches;
        if (m !== undefined) { try { new RegExp(m); } catch { fail(`rules[${i}].when.${path}.matches is not a valid regex`); } }
      }
    }
  });
  return p as unknown as ToolPolicy;
}

/** The policy check before a call: returns allow / deny / require_approval with the reasons. Pure function. */
export function approvalGate(policy: ToolPolicy, call: ToolCall): PolicyDecision {
  const matched = policy.rules.filter((r) => ruleMatches(r, call));
  if (matched.length === 0) {
    const effect = policy.defaultEffect ?? 'deny';
    return { effect, matchedRules: [], decidingRules: [], reasons: [`no rule matched tool "${call.tool}"; default effect is ${effect}`],
      ...(effect === 'require_approval' && policy.approvalTtlSec !== undefined ? { approvalTtlSec: policy.approvalTtlSec } : {}) };
  }
  const top = Math.max(...matched.map((r) => RANK[r.effect]));
  const deciding = matched.filter((r) => RANK[r.effect] === top);
  const effect = deciding[0]!.effect;
  const d: PolicyDecision = { effect, matchedRules: matched.map((r) => r.id), decidingRules: deciding.map((r) => r.id), reasons: deciding.map((r) => r.reason) };
  if (effect === 'require_approval') {
    const approverLists = deciding.filter((r) => r.approvers).map((r) => r.approvers!);
    // several approval rules: an approver must satisfy all of them (intersection)
    if (approverLists.length) d.approvers = approverLists.reduce((a, b) => a.filter((x) => b.includes(x)));
    // nobody may approve under all deciding rules -> nobody can ever approve: deny instead of a dead request
    if (d.approvers && d.approvers.length === 0)
      return { ...d, effect: 'deny', reasons: [...d.reasons, 'no approver is allowed by every matching approval rule'] };
    const ttls = deciding.map((r) => r.approvalTtlSec).filter((t): t is number => t !== undefined);
    const ttl = ttls.length ? Math.min(...ttls) : policy.approvalTtlSec;
    if (ttl !== undefined) d.approvalTtlSec = ttl;
  }
  return d;
}
