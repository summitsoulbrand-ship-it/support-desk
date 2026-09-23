import { describe, it, expect } from 'vitest';
import { excerpt } from './edit-digest';

describe('edit digest excerpt', () => {
  it('keeps the spaces between words (every quote since 2026-07-04 had none)', () => {
    expect(excerpt('Hi Karen,\r\n\r\nI am sorry   the Small\ndid not fit.')).toBe(
      'Hi Karen, I am sorry the Small did not fit.'
    );
  });

  it('still shortens long drafts', () => {
    expect(excerpt('word '.repeat(200), 20)).toBe('word word word word...');
  });
});
