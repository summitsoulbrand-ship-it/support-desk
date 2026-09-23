import { describe, it, expect } from 'vitest';
import { verifierIssues, VERIFIER_DID_NOT_RUN } from './service';

describe('verifierIssues', () => {
  it('drops a bare "may not answer" with no reason (129 of those in 30 days said nothing)', () => {
    expect(verifierIssues({ answers_question: false, why_not: '' })).toEqual({ ok: true, issues: [] });
  });

  it('keeps it when the checker says what was missed', () => {
    const r = verifierIssues({ answers_question: false, why_not: 'she asked about the XL, not the M' });
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual(['Verifier: may not answer their question - she asked about the XL, not the M']);
  });

  it('passes the concrete findings through', () => {
    const r = verifierIssues({
      answers_question: true,
      why_not: '',
      correct_order: false,
      unsupported_claims: ['delivered on Friday', '  '],
      missed_points: ['the second shirt'],
    });
    expect(r.issues).toEqual([
      'Verifier: the draft may reference the wrong order.',
      'Verifier: unsupported claim - delivered on Friday',
      'Verifier: missed point - the second shirt',
    ]);
  });

  it('has an honest note for a check that did not run', () => {
    expect(VERIFIER_DID_NOT_RUN).toMatch(/did not run/);
  });
});
