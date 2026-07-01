import { describe, it, expect } from 'vitest';
import { splitEmail, levenshtein, isLikelyEmailTypo } from './email-match';

describe('splitEmail', () => {
  it('splits and lowercases', () => {
    expect(splitEmail('Zubrowskid@Gmail.com')).toEqual({
      local: 'zubrowskid',
      domain: 'gmail.com',
    });
  });
  it('rejects malformed', () => {
    expect(splitEmail('no-at-sign')).toBeNull();
    expect(splitEmail('@nolocal.com')).toBeNull();
    expect(splitEmail('trailing@')).toBeNull();
    expect(splitEmail(null)).toBeNull();
  });
});

describe('levenshtein', () => {
  it('measures small edits', () => {
    expect(levenshtein('gmail.com', 'gmai.com')).toBe(1); // dropped l
    expect(levenshtein('gmail.com', 'gmial.com')).toBe(2); // transposition
    expect(levenshtein('gmail.com', 'gmail.com')).toBe(0);
    expect(levenshtein('gmail.com', 'yahoo.com')).toBeGreaterThan(2);
  });
});

describe('isLikelyEmailTypo', () => {
  it('matches the real case: gmail.com vs gmai.com, same local part', () => {
    expect(isLikelyEmailTypo('zubrowskid@gmail.com', 'zubrowskid@gmai.com')).toBe(true);
  });
  it('matches other common domain typos', () => {
    expect(isLikelyEmailTypo('dariusz@gmail.com', 'dariusz@gmial.com')).toBe(true);
    expect(isLikelyEmailTypo('dariusz@hotmail.com', 'dariusz@hotmial.com')).toBe(true);
  });
  it('does NOT match a different person on a different provider (same local part)', () => {
    // jsmith@gmail.com and jsmith@yahoo.com are almost certainly different people.
    expect(isLikelyEmailTypo('jsmith@gmail.com', 'jsmith@yahoo.com')).toBe(false);
  });
  it('does NOT match a different local part', () => {
    expect(isLikelyEmailTypo('zubrowskid@gmail.com', 'zubrowski@gmai.com')).toBe(false);
  });
  it('does NOT match an identical email (that is an exact match, handled earlier)', () => {
    expect(isLikelyEmailTypo('a.person@gmail.com', 'a.person@gmail.com')).toBe(false);
  });
  it('does NOT match when the local part is too short (risky)', () => {
    expect(isLikelyEmailTypo('abc@gmail.com', 'abc@gmai.com')).toBe(false);
  });
});
