import { describe, it, expect } from 'vitest';
import {
  normalizeInsights,
  renderInsightsHtml,
  renderInsightsText,
} from './edit-digest-insights';

describe('normalizeInsights', () => {
  it('drops style rules seen fewer than 3 times, keeps 3+', () => {
    const out = normalizeInsights({
      observations: ['Warmer openers'],
      candidate_rules: [
        { pattern: 'shortens the sign-off', times: 4 },
        { pattern: 'one-off joke added', times: 2 },
      ],
      fact_checks: [],
    });
    expect(out).not.toBeNull();
    expect(out!.candidateRules).toHaveLength(1);
    expect(out!.candidateRules[0].pattern).toBe('shortens the sign-off');
  });

  it('keeps a fact correction even at a single occurrence', () => {
    const out = normalizeInsights({
      observations: [],
      candidate_rules: [],
      fact_checks: ['AI said 5-7 day shipping; operator corrected to 7-10 days'],
    });
    expect(out).not.toBeNull();
    expect(out!.factChecks).toHaveLength(1);
  });

  it('returns null when nothing survives', () => {
    expect(
      normalizeInsights({ observations: [], candidate_rules: [], fact_checks: [] })
    ).toBeNull();
    expect(normalizeInsights({})).toBeNull();
    expect(normalizeInsights(null)).toBeNull();
  });

  it('ignores malformed entries without throwing', () => {
    const out = normalizeInsights({
      observations: ['ok', 42, '', null],
      candidate_rules: [
        { pattern: '', times: 9 },
        { pattern: 'no count' },
        { times: 5 },
        'nonsense',
      ],
      fact_checks: ['a real fix', 7],
    });
    expect(out).not.toBeNull();
    expect(out!.observations).toEqual(['ok']);
    expect(out!.candidateRules).toHaveLength(0);
    expect(out!.factChecks).toEqual(['a real fix']);
  });

  it('caps observations at 5 and facts at 10', () => {
    const out = normalizeInsights({
      observations: Array.from({ length: 8 }, (_, i) => `obs ${i}`),
      candidate_rules: [],
      fact_checks: Array.from({ length: 14 }, (_, i) => `fact ${i}`),
    });
    expect(out!.observations).toHaveLength(5);
    expect(out!.factChecks).toHaveLength(10);
  });
});

describe('rendering', () => {
  const insights = {
    observations: ['Operator warms up openers'],
    candidateRules: [{ pattern: 'shortens the sign-off to "Thanks, Pati"', times: 4 }],
    factChecks: ['AI said free returns; operator removed that claim'],
  };

  it('HTML escapes and includes all three sections', () => {
    const html = renderInsightsHtml(insights);
    expect(html).toContain('What I noticed this week');
    expect(html).toContain('Worth making a rule');
    expect(html).toContain('Facts to double-check');
    expect(html).toContain('(4 times)');
  });

  it('HTML escapes angle brackets in content', () => {
    const html = renderInsightsHtml({
      observations: ['uses <b>bold</b> less'],
      candidateRules: [],
      factChecks: [],
    });
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('<b>bold</b>');
  });

  it('text form lists observations, rules, and facts', () => {
    const text = renderInsightsText(insights);
    expect(text).toContain('What I noticed this week:');
    expect(text).toContain('- Operator warms up openers');
    expect(text).toContain('Worth making a rule');
    expect(text).toContain('Facts to double-check');
  });
});
