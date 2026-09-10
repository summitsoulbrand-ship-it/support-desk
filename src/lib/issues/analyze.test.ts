import { describe, it, expect } from 'vitest';
import { groundDesignName } from './analyze';

/**
 * The grounding rule is the safety catch on the whole report: a design name
 * that is wrong sends Pati to redraw artwork that was never at fault, and it
 * poisons the pattern alarm by pooling unrelated complaints under one design.
 * So a name survives only when the customer bought that design or wrote its
 * words themselves.
 */
describe('groundDesignName', () => {
  const ordered = ['Frog Wizard Kerfuffle', 'American Bison'];

  it('accepts a design the customer actually ordered', () => {
    expect(groundDesignName('Frog Wizard Kerfuffle', ordered, 'my shirt is peeling')).toEqual({
      name: 'Frog Wizard Kerfuffle',
      source: 'order',
    });
  });

  it('matches an ordered design through its garment suffix', () => {
    expect(
      groundDesignName('Frog Wizard Kerfuffle Premium', ordered, 'the print cracked')
    ).toEqual({ name: 'Frog Wizard Kerfuffle', source: 'order' });
  });

  it('ignores case and punctuation differences', () => {
    expect(groundDesignName('american bison', ordered, 'anything')).toEqual({
      name: 'American Bison',
      source: 'order',
    });
  });

  it('accepts a design the customer named even when no order matched', () => {
    const got = groundDesignName(
      'Frog Wizard',
      [],
      'The text on the Frog Wizard tee is impossible to read'
    );
    expect(got).toEqual({ name: 'Frog Wizard', source: 'customer' });
  });

  it('drops a name the customer never wrote and never ordered', () => {
    // The classic hallucination: a plausible catalog name attached to a
    // message that says only "my shirt".
    expect(groundDesignName('Sasquatch Crossing', ordered, 'my shirt is peeling')).toBeNull();
  });

  it('drops a name only partly present in the message', () => {
    expect(
      groundDesignName('Frog Wizard Kerfuffle', [], 'the frog on my shirt is faded')
    ).toBeNull();
  });

  it('records nothing when the model left the design out', () => {
    expect(groundDesignName(null, ordered, 'my shirt is peeling')).toBeNull();
    expect(groundDesignName('  ', ordered, 'my shirt is peeling')).toBeNull();
  });

  it('refuses a bare garment word as a design name', () => {
    expect(groundDesignName('t-shirt', ordered, 'my t-shirt is peeling')).toBeNull();
  });
});

/**
 * The Sep 10 miss: Dan replied to a marketing letter about Frog Wizard
 * Kerfuffle with nine words that named no design, and the report credited the
 * complaint to that design - because triage had read the name off the quoted
 * letter underneath his reply. Our own copy is not evidence about a customer.
 */
describe('groundDesignName - our own marketing copy', () => {
  it('does not attribute a design just because our letter named it', () => {
    const customerWords = 'A stranger pointed out that the frog has 5 legs';
    expect(
      groundDesignName('Frog Wizard Kerfuffle', [], customerWords)
    ).toBeNull();
  });

  it('still attributes when the customer names it themselves', () => {
    expect(
      groundDesignName(
        'Frog Wizard Kerfuffle',
        [],
        'the frog wizard kerfuffle shirt has a weird leg'
      )
    ).toEqual({ name: 'Frog Wizard Kerfuffle', source: 'customer' });
  });

  it('still attributes when they own exactly that design', () => {
    expect(
      groundDesignName('Frog Wizard Kerfuffle', ['Frog Wizard Kerfuffle'], 'my shirt is odd')
    ).toEqual({ name: 'Frog Wizard Kerfuffle', source: 'order' });
  });
});
