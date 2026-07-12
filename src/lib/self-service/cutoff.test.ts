import { describe, it, expect } from 'vitest';
import { productionCutoff } from './cutoff';

// July = PDT (UTC-7): 11pm LA = 06:00 UTC next calendar day.
// January = PST (UTC-8): 11pm LA = 07:00 UTC next calendar day.

describe('productionCutoff', () => {
  it('daytime order (PDT) locks at 11pm LA the same LA day', () => {
    // 2026-07-11 10:00 LA = 17:00 UTC
    const created = new Date('2026-07-11T17:00:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2026-07-12T06:00:00.000Z');
  });

  it('order placed at 11:30pm LA rolls to the NEXT day cutoff', () => {
    // 2026-07-11 23:30 LA = 2026-07-12 06:30 UTC
    const created = new Date('2026-07-12T06:30:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2026-07-13T06:00:00.000Z');
  });

  it('order placed exactly at the cutoff rolls forward', () => {
    const created = new Date('2026-07-12T06:00:00Z'); // 11pm LA sharp
    expect(productionCutoff(created).toISOString()).toBe('2026-07-13T06:00:00.000Z');
  });

  it('winter order uses PST (UTC-8)', () => {
    // 2026-01-10 12:00 LA = 20:00 UTC
    const created = new Date('2026-01-10T20:00:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2026-01-11T07:00:00.000Z');
  });

  it('early-morning LA order still locks the same LA day', () => {
    // 2026-07-11 00:30 LA = 07:30 UTC
    const created = new Date('2026-07-11T07:30:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2026-07-12T06:00:00.000Z');
  });
});
