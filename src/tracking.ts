// Tracking guard: validates GA4-style dataLayer events before they leave the site (naming rules, parameter limits,
// no personal data in parameters, consent) and rates Core Web Vitals against Google's published thresholds.
// Strict TypeScript, no dependencies. Synthetic data only.
export interface Consent { analytics: boolean; ads?: boolean }
export interface TrackEvent { event: string; params?: Record<string, unknown>; consent?: Consent }
export type TrackCode = 'no_consent' | 'bad_name' | 'reserved_name' | 'too_many_params' | 'bad_param_name' | 'bad_value' | 'value_too_long' | 'pii_in_param';
export interface TrackIssue { code: TrackCode; param?: string }
export interface TrackResult { accepted: boolean; issues: TrackIssue[] }

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const RESERVED_PREFIX = /^(ga_|google_|firebase_)/i;
const RESERVED = new Set(['ad_activeview', 'ad_click', 'ad_exposure', 'ad_query', 'adunit_exposure', 'app_clear_data', 'app_install', 'app_remove',
  'app_update', 'error', 'first_open', 'first_visit', 'notification_dismiss', 'notification_foreground', 'notification_open',
  'notification_receive', 'os_update', 'session_start', 'user_engagement']);
export const MAX_PARAMS = 25; export const MAX_VALUE_CHARS = 100;
// Personal data must never reach analytics: e-mail addresses, Swedish phone numbers, personnummer.
const PII: RegExp[] = [/[\w.+-]+@[\w-]+(\.[\w-]+)+/, /(\+46|\b0)7\d[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/, /\b(19|20)?\d{6}[-+]?\d{4}\b/];

export function containsPii(s: string): boolean { return PII.some((r) => r.test(s)); }

export function validateTrackEvent(e: TrackEvent): TrackResult {
  if (!e.consent || e.consent.analytics !== true) return { accepted: false, issues: [{ code: 'no_consent' }] };
  const issues: TrackIssue[] = [];
  if (typeof e.event !== 'string' || !NAME.test(e.event)) issues.push({ code: 'bad_name' });
  else if (RESERVED.has(e.event) || RESERVED_PREFIX.test(e.event)) issues.push({ code: 'reserved_name' });
  const params = e.params ?? {};
  const keys = Object.keys(params).sort();
  if (keys.length > MAX_PARAMS) issues.push({ code: 'too_many_params' });
  for (const k of keys) {
    if (!NAME.test(k) || RESERVED_PREFIX.test(k)) { issues.push({ code: 'bad_param_name', param: k }); continue; }
    const v = params[k];
    if (typeof v === 'number') { if (!Number.isFinite(v)) issues.push({ code: 'bad_value', param: k }); continue; }
    if (typeof v === 'boolean') continue;
    if (typeof v !== 'string') { issues.push({ code: 'bad_value', param: k }); continue; }
    if (v.length > MAX_VALUE_CHARS) issues.push({ code: 'value_too_long', param: k });
    else if (containsPii(v)) issues.push({ code: 'pii_in_param', param: k });
  }
  return { accepted: issues.length === 0, issues };
}

export type Rating = 'good' | 'needs_improvement' | 'poor';
export interface Vitals { lcpMs?: number; inpMs?: number; cls?: number }
const LIMITS: Record<keyof Vitals, [number, number]> = { lcpMs: [2500, 4000], inpMs: [200, 500], cls: [0.1, 0.25] };
export function rateVitals(v: Vitals): Partial<Record<keyof Vitals, Rating>> {
  const out: Partial<Record<keyof Vitals, Rating>> = {};
  for (const k of Object.keys(LIMITS) as (keyof Vitals)[]) {
    const x = v[k]; if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) continue;
    const [good, poor] = LIMITS[k]; out[k] = x <= good ? 'good' : x <= poor ? 'needs_improvement' : 'poor';
  }
  return out;
}
