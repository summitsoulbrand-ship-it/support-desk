/**
 * Regression tests for the thread-splitting bug.
 *
 * Real headers, taken from production on 2026-08-01: one customer
 * (andlans@msn.com) whose single conversation was filed as FIVE separate
 * threads. Each new thread held one message, so the AI drafted every reply
 * blind and sent her the identical "refund or replacement?" question after she
 * had already answered it.
 */

import { describe, it, expect } from 'vitest';
import { collectChainIds } from './sync-service';
import { isRfcMessageId, rfcIdOf } from './message-id';

// --- The actual chain, in order ---------------------------------------------
const KLAVIYO_ROOT = '<01KYMFHDRRWFJEB814XFKCM2H5@klaviyomail.com>';
const HER_JUL28 =
  '<PH0PR02MB7702C1D40A65B3E114832F1CBECB2@PH0PR02MB7702.namprd02.prod.outlook.com>';
const OUR_JUL29_RFC = '<19fab6f8184.393a74b9507924.5969333062352170112@summitsoul.shop>';
const OUR_JUL29_ZOHO_ID = '1785287639537155100';
const HER_JUL30 =
  '<PH0PR02MB7702A6A3AA1554F9AF8A8A8EBEC92@PH0PR02MB7702.namprd02.prod.outlook.com>';
const OUR_JUL31_RFC = '<19fb5c67ae3.205ab774106586.3184580438418320959@summitsoul.shop>';
const HER_JUL31 =
  '<SA2PR02MB7706574B5924F7B825CF4109BEC82@SA2PR02MB7706.namprd02.prod.outlook.com>';

/** Her Jul 30 reply as Outlook actually sent it: the Klaviyo root already gone. */
const julyThirtiethReply = {
  inReplyTo: OUR_JUL29_RFC,
  references: [HER_JUL28, OUR_JUL29_RFC],
};

/** Her Jul 31 reply: now even her own Jul 28 id has dropped off. */
const julyThirtyFirstReply = {
  inReplyTo: OUR_JUL31_RFC,
  references: [HER_JUL30, OUR_JUL31_RFC],
};

/** Her Aug 1 reply. */
const augustFirstReply = {
  inReplyTo: HER_JUL31,
  references: [HER_JUL30, OUR_JUL31_RFC, HER_JUL31],
};

describe('collectChainIds', () => {
  it('returns every id a reply points back at, not just the first reference', () => {
    expect(collectChainIds([julyThirtiethReply]).sort()).toEqual(
      [HER_JUL28, OUR_JUL29_RFC].sort()
    );
  });

  it('finds the id of a message we already stored, which the old thread key missed', () => {
    // The old rule keyed the thread on references[0]. Outlook had already
    // trimmed the Klaviyo root, so references[0] was HER_JUL28 - an id that
    // belonged to a DIFFERENT thread row, so a new thread was created.
    expect(julyThirtiethReply.references[0]).not.toBe(KLAVIYO_ROOT);

    // The fix looks at the whole chain, so her own earlier message is found and
    // the reply lands on the existing thread.
    expect(collectChainIds([julyThirtiethReply])).toContain(HER_JUL28);
  });

  it('still links the later replies, where only OUR message id survives in the chain', () => {
    // Jul 31 carries no id of hers that predates the split - only our own
    // outbound. That is why storing the real Message-ID of what we send
    // matters: without it this reply matches nothing.
    const ids = collectChainIds([julyThirtyFirstReply]);
    expect(ids).toContain(OUR_JUL31_RFC);
    expect(ids).toContain(HER_JUL30);

    expect(collectChainIds([augustFirstReply])).toContain(HER_JUL31);
  });

  it('de-duplicates across a batch of messages', () => {
    const ids = collectChainIds([julyThirtiethReply, julyThirtyFirstReply]);
    expect(ids.filter((id) => id === OUR_JUL31_RFC)).toHaveLength(1);
  });

  it('is empty for a first-contact email with no reply headers', () => {
    expect(collectChainIds([{ references: [], inReplyTo: undefined }])).toEqual([]);
  });
});

describe('isRfcMessageId', () => {
  it('accepts a real Message-ID', () => {
    expect(isRfcMessageId(OUR_JUL29_RFC)).toBe(true);
    expect(isRfcMessageId(HER_JUL28)).toBe(true);
  });

  it("rejects Zoho's internal numeric id, which must never reach a mail header", () => {
    expect(isRfcMessageId(OUR_JUL29_ZOHO_ID)).toBe(false);
  });

  it('rejects empty and malformed values', () => {
    expect(isRfcMessageId(null)).toBe(false);
    expect(isRfcMessageId(undefined)).toBe(false);
    expect(isRfcMessageId('')).toBe(false);
    expect(isRfcMessageId('pending-8f3c2a1b')).toBe(false);
    expect(isRfcMessageId('<no-at-sign>')).toBe(false);
  });
});

describe('rfcIdOf', () => {
  it('prefers the learned real Message-ID over the provider number', () => {
    expect(
      rfcIdOf({ rfcMessageId: OUR_JUL29_RFC, providerMessageId: OUR_JUL29_ZOHO_ID })
    ).toBe(OUR_JUL29_RFC);
  });

  it('falls back to providerMessageId when it is itself a real Message-ID (inbound rows)', () => {
    expect(rfcIdOf({ rfcMessageId: null, providerMessageId: HER_JUL28 })).toBe(HER_JUL28);
  });

  it('returns undefined rather than poisoning the chain with a provider number', () => {
    expect(rfcIdOf({ rfcMessageId: null, providerMessageId: OUR_JUL29_ZOHO_ID })).toBeUndefined();
    expect(rfcIdOf(null)).toBeUndefined();
  });
});
