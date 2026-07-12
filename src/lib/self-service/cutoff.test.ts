import { describe, it, expect, afterEach } from 'vitest';
import { productionCutoff, cutoffHourHuman } from './cutoff';

afterEach(() => {
  delete process.env.PRODUCTION_CUTOFF_HOUR_LA;
});

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

  // US DST 2027: spring forward Sun Mar 14, fall back Sun Nov 7.
  it('order at 23:30 the night BEFORE spring-forward locks the next (23h) day, not a day late', () => {
    // Sat 2027-03-13 23:30 PST = 2027-03-14 07:30 UTC; next cutoff is
    // Sun Mar 14 23:00 PDT = Mar 15 06:00 UTC (the day is only 23h long).
    const created = new Date('2027-03-14T07:30:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2027-03-15T06:00:00.000Z');
  });

  it('order at 00:30 PST ON spring-forward day gets the PDT cutoff (offset refined at 11pm)', () => {
    // Sun 2027-03-14 00:30 PST = 08:30 UTC; 11pm that day is PDT ->
    // Mar 15 06:00 UTC (naive PST math would say 07:00 UTC, an hour late).
    const created = new Date('2027-03-14T08:30:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2027-03-15T06:00:00.000Z');
  });

  it('order at 23:30 the night BEFORE fall-back locks the next (25h) day correctly', () => {
    // Sat 2027-11-06 23:30 PDT = 2027-11-07 06:30 UTC; next cutoff is
    // Sun Nov 7 23:00 PST = Nov 8 07:00 UTC.
    const created = new Date('2027-11-07T06:30:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2027-11-08T07:00:00.000Z');
  });

  it('PRODUCTION_CUTOFF_HOUR_LA env moves the cutoff and the human copy', () => {
    process.env.PRODUCTION_CUTOFF_HOUR_LA = '21';
    // 2026-07-11 10:00 LA -> 9pm LA same day = 2026-07-12 04:00 UTC (PDT)
    const created = new Date('2026-07-11T17:00:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2026-07-12T04:00:00.000Z');
    expect(cutoffHourHuman()).toBe('9pm Pacific');
  });

  it('invalid env value falls back to 11pm', () => {
    process.env.PRODUCTION_CUTOFF_HOUR_LA = 'banana';
    expect(cutoffHourHuman()).toBe('11pm Pacific');
  });
});
