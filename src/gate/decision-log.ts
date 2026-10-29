// Decision log: one structured record per gate decision, with the reasons, written into the audit log.
// Answers "why did the agent's tool call run / get blocked / wait for a human?" after the fact.
import type { Effect, PolicyDecision, ToolCall } from './policy-check.js';

export type Outcome =
  | 'executed' | 'denied' | 'pending_approval' | 'approval_expired' | 'duplicate' | 'in_flight' | 'failed';

export interface DecisionLogEntry {
  tool: string;
  agent: string;
  role?: string;
  idempotencyKey: string;
  effect: Effect;
  outcome: Outcome;
  matchedRules: string[];
  decidingRules: string[];
  reasons: string[];
  approvalRequestId?: string;
  approvedBy?: string;
  /** sha256 of the canonical arguments; raw args are not logged by default (may contain personal data) */
  argsHash: string;
  error?: string;
}

export function decisionLogEntry(call: ToolCall, key: string, argsHash: string, d: PolicyDecision, outcome: Outcome,
  extra: Partial<Pick<DecisionLogEntry, 'approvalRequestId' | 'approvedBy' | 'error' | 'reasons'>> = {}): DecisionLogEntry {
  const e: DecisionLogEntry = { tool: call.tool, agent: call.agent, idempotencyKey: key, effect: d.effect, outcome,
    matchedRules: d.matchedRules, decidingRules: d.decidingRules, reasons: extra.reasons ?? d.reasons, argsHash };
  if (call.role !== undefined) e.role = call.role;
  if (extra.approvalRequestId !== undefined) e.approvalRequestId = extra.approvalRequestId;
  if (extra.approvedBy !== undefined) e.approvedBy = extra.approvedBy;
  if (extra.error !== undefined) e.error = extra.error;
  return e;
}

/** One-line human explanation, e.g. for an agent's tool_result or a chat notification. */
export function explainDecision(e: DecisionLogEntry): string {
  const rules = e.decidingRules.length ? ` [${e.decidingRules.join(', ')}]` : '';
  return `${e.tool} by ${e.agent}: ${e.outcome}${rules} - ${e.reasons.join('; ')}`;
}
