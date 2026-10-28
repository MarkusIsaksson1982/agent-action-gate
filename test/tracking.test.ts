import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTrackEvent, rateVitals, containsPii, MAX_PARAMS } from '../src/tracking.js';

const C = { analytics: true };
test('tracking: consent first, naming rules, reserved names', () => {
  assert.deepEqual(validateTrackEvent({ event: 'generate_lead', params: { form_id: 'contact', value: 1 } }), { accepted: false, issues: [{ code: 'no_consent' }] });
  assert.deepEqual(validateTrackEvent({ event: 'generate_lead', params: { form_id: 'contact', value: 1, ok: true }, consent: C }), { accepted: true, issues: [] });
  assert.deepEqual(validateTrackEvent({ event: '1bad', consent: C }).issues, [{ code: 'bad_name' }]);
  assert.deepEqual(validateTrackEvent({ event: 'a'.repeat(41), consent: C }).issues, [{ code: 'bad_name' }]);
  assert.deepEqual(validateTrackEvent({ event: 'session_start', consent: C }).issues, [{ code: 'reserved_name' }]);
  assert.deepEqual(validateTrackEvent({ event: 'google_thing', consent: C }).issues, [{ code: 'reserved_name' }]);
});
test('tracking: params – limits, types, PII, sorted issue order', () => {
  const many = Object.fromEntries(Array.from({ length: MAX_PARAMS + 1 }, (_, i) => [`p${i}`, i]));
  assert.deepEqual(validateTrackEvent({ event: 'x', params: many, consent: C }).issues, [{ code: 'too_many_params' }]);
  const r = validateTrackEvent({ event: 'form_submit', consent: C, params: { z_mail: 'anna@example.se', 'bad-key': 1, ga_x: 1, n: Infinity, o: {}, long: 'x'.repeat(101), tel: 'ring 070-123 45 67', pnr: '19900101-1234' } });
  assert.equal(r.accepted, false);
  assert.deepEqual(r.issues, [{ code: 'bad_param_name', param: 'bad-key' }, { code: 'bad_param_name', param: 'ga_x' }, { code: 'value_too_long', param: 'long' },
    { code: 'bad_value', param: 'n' }, { code: 'bad_value', param: 'o' }, { code: 'pii_in_param', param: 'pnr' }, { code: 'pii_in_param', param: 'tel' }, { code: 'pii_in_param', param: 'z_mail' }]);
  assert.equal(containsPii('order 1234 shipped'), false); assert.equal(containsPii('+46701234567'), true);
});
test('vitals: Google thresholds, inclusive good bound, invalid ignored', () => {
  assert.deepEqual(rateVitals({ lcpMs: 2500, inpMs: 201, cls: 0.3 }), { lcpMs: 'good', inpMs: 'needs_improvement', cls: 'poor' });
  assert.deepEqual(rateVitals({ lcpMs: 4001, cls: -1, inpMs: NaN }), { lcpMs: 'poor' });
});
