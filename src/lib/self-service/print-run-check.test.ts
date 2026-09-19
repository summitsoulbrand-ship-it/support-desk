import { describe, it, expect } from 'vitest';
import { minutesFromConfigured, printRunHasDrifted } from './print-run-check';

describe('print-run drift', () => {
  it('the batches of one run are the same run (07:00 / 07:10)', () => {
    expect(printRunHasDrifted('07:00', '07:00')).toBe(false);
    expect(printRunHasDrifted('07:10', '07:00')).toBe(false);
  });
  it('the moves that really happened are caught: 06:00 -> 07:00, and back', () => {
    expect(printRunHasDrifted('07:00', '06:00')).toBe(true);
    expect(printRunHasDrifted('06:00', '07:00')).toBe(true);
    expect(printRunHasDrifted('05:00', '07:00')).toBe(true);
  });
  it('negative means the run is EARLIER than the setting - the dangerous direction', () => {
    expect(minutesFromConfigured('06:00', '07:00')).toBe(-60);
    expect(minutesFromConfigured('08:00', '07:00')).toBe(60);
  });
  it('wraps around midnight instead of reporting a 23-hour drift', () => {
    expect(minutesFromConfigured('23:50', '00:10')).toBe(-20);
    expect(minutesFromConfigured('00:10', '23:50')).toBe(20);
  });
});
