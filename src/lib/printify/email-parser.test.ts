import { describe, it, expect } from 'vitest';
import { parsePrintifyEmail } from './email-parser';

// Fixtures are lightly trimmed but verbatim from real merchantsupport@printify.com
// emails to summitsoulbrand@gmail.com.

const STRUCTURED_BATCH = `
System, Mar 31, 2026, 07:30 GMT+3

(07:17:14) Patrizia Heinzl: please do a reprint for the first one and refunds for the other
(07:17:23) Patrizia Heinzl: thank you
(07:19:59) Dina Harper: To confirm, I'll arrange a reprint for 19269685.12034, and refund 19269685.11859 19269685.12362 19269685.11963 and 19269685.11877. Is this correct?
(07:20:22) Patrizia Heinzl: yes, thank you
(07:30:01) Dina Harper: Patrizia, I've successfully processed the below:
(07:30:13) Dina Harper: 19269685.12034 - reprint order 19269685.13134
19269685.11859 - refunded USD 13.69
19269685.12362 - partial refund USD 8.80
19269685.11963 - partial refund USD 16.20
19269685.11877 - partial refund USD 9.26
`;

const PROSE_FULL_REFUND = `
System, Jun 27, 2026, 06:32 GMT+3

(06:30:42) Adelyn Quinn: Hello! Hope you are doing great! Adelyn here.
(06:30:47) Adelyn Quinn: Allow me to check that one for you.
(06:32:41) Adelyn Quinn: The order 19269685.18793 is still in transit, but I understand that it has already exceeded the time frame.
(06:32:42) Adelyn Quinn: A full refund has now been issued since it's needed for a trip - USD 67.95.
`;

const CANCELLATION = `
Arianne Maynard, Jun 21, 2026, 22:57 GMT+3

Hello there,

I would like to inform you that the Print Provider has successfully processed the cancellation of your order 19269685.20437. The full amount has been credited back to your Printify balance for your upcoming orders.
`;

const PENDING_BATCH = `
System, Jun 27, 2026, 07:37 GMT+3

(07:23:03) Patrizia Heinzl: same for this one. please send a refund in case its lost: #19269685.20003
(07:24:57) Patrizia Heinzl: #19269685.18017
(07:25:14) Patrizia Heinzl: #19269685.17963
(07:27:23) Patrizia Heinzl: please issue a refund for all of them if lost
(07:30:03) Aisha Byrd: Great! I'll get back to you after 30 or an hour at most.
`;

describe('parsePrintifyEmail - structured batch', () => {
  const { resolutions } = parsePrintifyEmail(STRUCTURED_BATCH);

  it('detects the reprint with its new order id', () => {
    const r = resolutions.find((x) => x.appOrderId === '19269685.12034');
    expect(r?.type).toBe('reprint');
    expect(r?.reprintAppOrderId).toBe('19269685.13134');
  });

  it('detects the full refund with amount', () => {
    const r = resolutions.find((x) => x.appOrderId === '19269685.11859');
    expect(r?.type).toBe('refund');
    expect(r?.amountUsd).toBe(13.69);
  });

  it('detects partial refunds with amounts', () => {
    const r = resolutions.find((x) => x.appOrderId === '19269685.12362');
    expect(r?.type).toBe('partial_refund');
    expect(r?.amountUsd).toBe(8.8);
    const r2 = resolutions.find((x) => x.appOrderId === '19269685.11963');
    expect(r2?.amountUsd).toBe(16.2);
  });

  it('finds all five resolved orders', () => {
    expect(resolutions).toHaveLength(5);
  });

  it('does not treat the operator confirm line as a resolution', () => {
    // "I'll arrange a reprint for ... and refund ..." is a plan, not a done
    // action; the real outcomes only come from the structured block.
    const reprints = resolutions.filter((r) => r.type === 'reprint');
    expect(reprints).toHaveLength(1);
  });
});

describe('parsePrintifyEmail - prose refund', () => {
  it('attributes a full refund to the order named on the line above', () => {
    const { resolutions } = parsePrintifyEmail(PROSE_FULL_REFUND);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      appOrderId: '19269685.18793',
      type: 'refund',
      amountUsd: 67.95,
    });
  });
});

describe('parsePrintifyEmail - cancellation', () => {
  it('detects a cancellation credited to balance', () => {
    const { resolutions } = parsePrintifyEmail(CANCELLATION);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      appOrderId: '19269685.20437',
      type: 'cancellation',
    });
    expect(resolutions[0].amountUsd).toBeUndefined();
  });
});

describe('parsePrintifyEmail - pending requests', () => {
  const { resolutions, requests } = parsePrintifyEmail(PENDING_BATCH);

  it('records no resolutions when the agent only promises to email back', () => {
    expect(resolutions).toHaveLength(0);
  });

  it('captures the operator-requested orders as refund requests', () => {
    const ids = requests.map((r) => r.appOrderId).sort();
    expect(ids).toContain('19269685.20003');
    expect(ids).toContain('19269685.18017');
    expect(ids).toContain('19269685.17963');
    expect(requests.every((r) => r.intent === 'refund')).toBe(true);
  });
});

describe('parsePrintifyEmail - guards', () => {
  it('does not flag the operator request as a recovery', () => {
    const body = `(06:19:53) Patrizia Heinzl: Hello. Can you please refund this order? it is taking too long: #19269685.18793`;
    const { resolutions, requests } = parsePrintifyEmail(body);
    expect(resolutions).toHaveLength(0);
    expect(requests).toEqual([
      expect.objectContaining({ appOrderId: '19269685.18793', intent: 'refund' }),
    ]);
  });

  it('ignores an in-transit status with no action', () => {
    const body = `(06:34:23) Adelyn Quinn: The order 19269685.21577 has just been shipped 6 hours ago.`;
    const { resolutions } = parsePrintifyEmail(body);
    expect(resolutions).toHaveLength(0);
  });

  it('returns empty for a greeting-only email', () => {
    const body = `(07:20:39) Aisha Byrd: Hello there, Aisha here! Hope you're doing well!`;
    expect(parsePrintifyEmail(body)).toEqual({ resolutions: [], requests: [] });
  });
});

describe('parsePrintifyEmail - subject-only order number (real 2026-06-30 email)', () => {
  // Printify follow-up confirmations often carry the order number ONLY in the
  // subject; the body just says "the order has been canceled and refunded".
  // The reconciler therefore parses `subject + "\n" + body` - this test
  // documents that contract (body alone extracts nothing).
  const subject =
    'Re: Action Required: Address Correction Needed for Order 19269685.19389';
  const body = `Hello Patrizia,

I hope all is well with you!

We haven't heard back from you regarding this matter. Therefore, the order has been canceled and refunded to your Printify Balance.

If you have any further questions, please let us know.`;

  it('extracts the cancellation when the subject is included', () => {
    const { resolutions } = parsePrintifyEmail(subject + '\n' + body);
    expect(resolutions).toEqual([
      expect.objectContaining({
        appOrderId: '19269685.19389',
        type: 'cancellation',
      }),
    ]);
  });

  it('extracts nothing from the body alone (why the subject must be passed)', () => {
    const { resolutions } = parsePrintifyEmail(body);
    expect(resolutions).toHaveLength(0);
  });
});
