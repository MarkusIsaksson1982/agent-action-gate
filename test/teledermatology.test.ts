// Clinical-realistic cases for the synthetic teledermatology intake policy (fixtures/policies/teledermatology-intake.policy.json).
// Patient-safety framing: the AI may raise priority, route and send fixed admin messages; lowering priority with any doubt,
// medical content to patients, prescribing and data export go to a clinician or are denied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { approvalGate, loadPolicy, type ToolCall } from '../src/gate/index.js';

const policy = loadPolicy(JSON.parse(readFileSync(new URL('../../fixtures/policies/teledermatology-intake.policy.json', import.meta.url), 'utf8')));
const call = (tool: string, args: Record<string, unknown>, role = 'intake_agent'): ToolCall => ({ tool, args, agent: 'intake-bot-1', role });
const triage = (args: Record<string, unknown>) => approvalGate(policy, call('case.set_priority', { caseId: 'TD-1042', ...args }));
const adultClean = { priority: 'routine', redFlag: false, patientAgeYears: 34, aiConfidence: 0.93 };

test('teledermatology: routine adult case without red flags is allowed', () => {
  const d = triage(adultClean);
  assert.equal(d.effect, 'allow');
  assert.deepEqual(d.decidingRules, ['triage-routine-allow']);
});

test('teledermatology: escalation to urgent is always allowed, even for a child at low confidence', () => {
  assert.equal(triage({ priority: 'urgent', redFlag: true, patientAgeYears: 7, aiConfidence: 0.4 }).effect, 'allow');
});

test('teledermatology: changing or bleeding mole cannot be put in the routine queue by the AI', () => {
  const d = triage({ ...adultClean, redFlag: true });
  assert.equal(d.effect, 'require_approval');
  assert.deepEqual(d.decidingRules, ['triage-routine-redflag-review']);
  assert.deepEqual(d.approvers, ['dermatologist', 'triage-nurse']);
  assert.equal(d.approvalTtlSec, 1800);
});

test('teledermatology: a missing red-flag answer is treated as a possible red flag (fail closed)', () => {
  const { redFlag: _omit, ...noAnswer } = adultClean;
  assert.equal(triage(noAnswer).effect, 'require_approval');
  assert.equal(triage({ ...adultClean, redFlag: 'no' }).effect, 'require_approval'); // wrong type is not "false"
});

test('teledermatology: under-18 patient and low model confidence go to a clinician', () => {
  assert.deepEqual(triage({ ...adultClean, patientAgeYears: 15 }).decidingRules, ['triage-routine-child-review']);
  assert.deepEqual(triage({ ...adultClean, aiConfidence: 0.6 }).decidingRules, ['triage-low-confidence-review']);
  assert.deepEqual(triage({ ...adultClean, aiConfidence: '0.99' }).decidingRules, ['triage-low-confidence-review']);
});

test('teledermatology: intake missing the age is denied, so the agent must ask for it', () => {
  const { patientAgeYears: _omit, ...noAge } = adultClean;
  const d = triage(noAge);
  assert.equal(d.effect, 'deny');
  assert.match(d.reasons[0]!, /no rule matched/);
});

test('teledermatology: AI may send admin templates but never a diagnosis, advice, reassurance or free text', () => {
  const msg = (template: string) => approvalGate(policy, call('patient.message_send', { caseId: 'TD-1042', template })).effect;
  assert.equal(msg('photo_retake_request'), 'allow');
  assert.equal(msg('case_received'), 'allow');
  for (const t of ['diagnosis', 'treatment_advice', 'free_text', 'reassurance', 'something_new']) assert.equal(msg(t), 'deny', t);
});

test('teledermatology: prescription drafts need a dermatologist; isotretinoin needs documented negative pregnancy status', () => {
  const rx = (args: Record<string, unknown>) => approvalGate(policy, call('prescription.draft', { caseId: 'TD-1042', ...args }));
  const topical = rx({ drugAtc: 'D07AC01' }); // betamethasone, topical corticosteroid
  assert.equal(topical.effect, 'require_approval');
  assert.deepEqual(topical.approvers, ['dermatologist']);
  assert.equal(rx({ drugAtc: 'D10BA01' }).effect, 'deny');
  assert.equal(rx({ drugAtc: 'D10BA01', pregnancyExcluded: false }).effect, 'deny');
  assert.equal(rx({ drugAtc: 'D10BA01', pregnancyExcluded: true }).effect, 'require_approval');
});

test('teledermatology: routing is allowed for the intake agent only; record export is always denied', () => {
  assert.equal(approvalGate(policy, call('case.route_dermatologist', { caseId: 'TD-1042', queue: 'derm-zh' })).effect, 'allow');
  assert.equal(approvalGate(policy, call('case.route_dermatologist', { caseId: 'TD-1042' }, 'marketing_agent')).effect, 'deny');
  assert.equal(approvalGate(policy, call('record.export', { caseId: 'TD-1042', format: 'zip' })).effect, 'deny');
  assert.equal(approvalGate(policy, call('record.export', { caseId: 'TD-1042' }, 'dermatologist')).effect, 'deny');
});
