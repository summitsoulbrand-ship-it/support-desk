import { describe, it, expect, afterEach } from 'vitest';
import { productionCutoff, cutoffHourHuman, nextPrintRun, printRunStartUtc } from './cutoff';

afterEach(() => {
  delete process.env.PRODUCTION_CUTOFF_HOUR_LA;
  delete process.env.PRINTIFY_PRINT_RUN_START_UTC;
});

// July = PDT (UTC-7): 11pm LA = 06:00 UTC next calendar day.
// January = PST (UTC-8): 11pm LA = 07:00 UTC next calendar day.

describe('productionCutoff', () => {
  it('daytime order (PDT) locks at 11pm LA the same LA day', () => {
    // 2026-07-11 10:00 LA = 17:00 UTC
    const created = new Date('2026-07-11T17:00:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2026-07-12T06:00:00.000Z');
  });

  // These two used to expect 11pm the NEXT day. Measured 2026-09-19: 30 of 31
  // orders placed between 11pm LA and the print run printed the SAME night,
  // 43 minutes later on average. The real run (07:00 UTC) comes first.
  it('order placed at 11:30pm LA locks at TONIGHT\'s print run, not 11pm tomorrow', () => {
    // 2026-07-11 23:30 LA = 2026-07-12 06:30 UTC; the run starts 07:00 UTC.
    const created = new Date('2026-07-12T06:30:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2026-07-12T07:00:00.000Z');
  });

  it('order placed exactly at 11pm LA also locks at tonight\'s run', () => {
    const created = new Date('2026-07-12T06:00:00Z'); // 11pm LA sharp
    expect(productionCutoff(created).toISOString()).toBe('2026-07-12T07:00:00.000Z');
  });

  it('#35734: placed 11:26pm PDT, printed 12:06am - the window is 34 minutes, not 24 hours', () => {
    // Placed 2026-08-23T06:26Z, sent to production 07:06Z. The old model said
    // 2026-08-24T06:00Z and the portal offered a paid swap payable until 12:53Z.
    const created = new Date('2026-08-23T06:26:00Z');
    const cutoff = productionCutoff(created);
    expect(cutoff.toISOString()).toBe('2026-08-23T07:00:00.000Z');
    // The paid-swap route needs cutoff - 45 min to still be in the future when
    // the customer asks (06:53Z). It is not, so the swap is refused up front.
    expect(cutoff.getTime() - 45 * 60_000).toBeLessThan(new Date('2026-08-23T06:53:00Z').getTime());
  });

  it('winter order uses PST (UTC-8)', () => {
    // 2026-01-10 12:00 LA = 20:00 UTC
    const created = new Date('2026-01-10T20:00:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2026-01-11T07:00:00.000Z');
  });

  it('order placed WHILE the run is going counts as printing now', () => {
    // 2026-07-11 00:30 LA = 07:30 UTC. Batches go out at 07:00, 07:10 and 07:30,
    // so a late batch can still take it: the cutoff is the run start, already past.
    const created = new Date('2026-07-11T07:30:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2026-07-11T07:00:00.000Z');
  });

  it('order placed after the run has finished locks at 11pm LA that day', () => {
    // 2026-07-11 01:00 LA = 08:00 UTC, past the 45-minute run window.
    const created = new Date('2026-07-11T08:00:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2026-07-12T06:00:00.000Z');
  });

  // US DST 2027: spring forward Sun Mar 14, fall back Sun Nov 7.
  it('order at 23:30 PST the night before spring-forward is inside the run (winter: 11pm LA = 07:00 UTC)', () => {
    // Sat 2027-03-13 23:30 PST = 2027-03-14 07:30 UTC - the run started at 07:00.
    const created = new Date('2027-03-14T07:30:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2027-03-14T07:00:00.000Z');
  });

  it('order at 00:30 PST ON spring-forward day gets the PDT cutoff (offset refined at 11pm)', () => {
    // Sun 2027-03-14 00:30 PST = 08:30 UTC; 11pm that day is PDT ->
    // Mar 15 06:00 UTC (naive PST math would say 07:00 UTC, an hour late).
    const created = new Date('2027-03-14T08:30:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2027-03-15T06:00:00.000Z');
  });

  it('order at 23:30 PDT the night before fall-back locks at that night\'s run', () => {
    // Sat 2027-11-06 23:30 PDT = 2027-11-07 06:30 UTC; the run starts 07:00 UTC.
    const created = new Date('2027-11-07T06:30:00Z');
    expect(productionCutoff(created).toISOString()).toBe('2027-11-07T07:00:00.000Z');
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


describe('nextPrintRun', () => {
  it('before the run: today at 07:00 UTC', () => {
    expect(nextPrintRun(new Date('2026-09-19T03:00:00Z')).toISOString()).toBe('2026-09-19T07:00:00.000Z');
  });
  it('during the run: still that run (it may take a just-placed order)', () => {
    expect(nextPrintRun(new Date('2026-09-19T07:44:00Z')).toISOString()).toBe('2026-09-19T07:00:00.000Z');
  });
  it('after the run: tomorrow', () => {
    expect(nextPrintRun(new Date('2026-09-19T07:45:00Z')).toISOString()).toBe('2026-09-20T07:00:00.000Z');
  });
  it('PRINTIFY_PRINT_RUN_START_UTC moves it, and a bad value falls back to 07:00', () => {
    process.env.PRINTIFY_PRINT_RUN_START_UTC = '06:00';
    expect(printRunStartUtc()).toBe('06:00');
    expect(nextPrintRun(new Date('2026-09-19T03:00:00Z')).toISOString()).toBe('2026-09-19T06:00:00.000Z');
    process.env.PRINTIFY_PRINT_RUN_START_UTC = 'midnight';
    expect(printRunStartUtc()).toBe('07:00');
  });
  it('a run EARLIER than the shown 11pm wins even for a daytime order (the dangerous direction)', () => {
    // If Printify drifts back to 05:00 UTC (10pm PDT), customers must not be
    // promised until 11pm.
    process.env.PRINTIFY_PRINT_RUN_START_UTC = '05:00';
    const created = new Date('2026-07-11T17:00:00Z'); // 10am LA
    expect(productionCutoff(created).toISOString()).toBe('2026-07-12T05:00:00.000Z');
  });
});
