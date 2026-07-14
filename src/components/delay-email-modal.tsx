'use client';

/**
 * Delay-email modal - shared by Late deliveries and Needs Attention.
 * Prefills one of two templates ('delay-update' by default, or
 * 'refund-or-replacement' for the "Printify refunded us, ask the customer what
 * they want" step), lets the operator review and edit it, and only sends on
 * explicit confirm (via /api/threads/compose). After the email goes out, the
 * page-specific bookkeeping runs through onSent; if that step fails, retrying
 * never re-sends the email.
 */

import { useState } from 'react';
import { Mail, X } from 'lucide-react';

export type DelayEmailTemplate = 'delay-update' | 'refund-or-replacement';

// Printify answers that mean the package is NOT going to arrive: Printify has
// refunded us, the parcel expired on forwarding, went back to sender, or was
// ruled undeliverable/lost. In these cases a "hang tight, here is the tracking"
// email is wrong - we owe the customer the refund-or-replacement choice.
const PACKAGE_GONE =
  /\brefund(?:ed)?\b|\bforward\s+expired\b|\breturn(?:ed|ing)?\s+to\s+sender\b|\bundeliverable\b|\b(?:cannot|can\s?not|could\s+not|couldn't|unable\s+to)\s+be\s+delivered\b|\bdelivery\s+failed\b|\bmarked\s+(?:as\s+)?lost\b|\bdisposed\b|\bdestroyed\b/i;

export function packageLikelyGone(answer?: string | null): boolean {
  return !!answer && PACKAGE_GONE.test(answer);
}

// The stored Printify answer is written to US, not the customer: it opens with
// an internal order number ("Order 19269685.18321: ..." or "19269685.21571- ..."),
// talks about the customer in the third person ("ask your customer to..."), and
// trails a bare tracking number in parens. Rewrite it to speak directly TO the
// customer so it can drop straight into the email.
function customerFacingAnswer(answer: string): string {
  const cleaned = answer
    // Leading internal order/tracking number: "Order 19269685.18321:" or "19269685.21571-".
    .replace(/^(?:order\s+)?\d{6,}(?:\.\d+)?\s*[:\-]\s*/i, '')
    // Trailing bare tracking number Printify appends in parens (with or without
    // a trailing period).
    .replace(/\s*\(\d{10,}\)\s*\.?\s*$/g, '')
    // Merchant-directed phrasing -> spoken to the customer.
    .replace(/\bplease ask (?:your |the )?customer to\b/gi, 'please')
    .replace(/\byour customer's\b/gi, 'your')
    .replace(/\bthe customer's\b/gi, 'your')
    .replace(/\bcustomer's\b/gi, 'your')
    .replace(/\byour customer\b/gi, 'you')
    .replace(/\bthe customer\b/gi, 'you')
    .replace(/\btheir\b/gi, 'your')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Recapitalize sentence starts (the first letter, and any word after a
  // sentence-ending period, since the stripping often leaves them lowercase).
  return cleaned.replace(/(^|[.!?]\s+)([a-z])/g, (_, lead, ch) => lead + ch.toUpperCase());
}

// Pre-written delay-update email, ready for the operator to review and edit.
// When Printify support has answered about this order (pickup waiting, held at
// the post office, forwarded, ...), their answer is quoted in the draft so the
// operator only has to trim it, not retype it.
export function delayEmailDraft(
  orderNumber: string,
  customerName?: string | null,
  printifyAnswer?: string | null
): string {
  const first = customerName?.trim().split(/\s+/)[0] || 'there';
  // Only quote a genuine in-transit status. A "package is gone" answer (refund,
  // forward expired, returned to sender, ...) must never ride in the reassuring
  // delay update - the caller sends the refund-or-replacement ask instead.
  const answer =
    printifyAnswer && !packageLikelyGone(printifyAnswer)
      ? customerFacingAnswer(printifyAnswer)
      : '';
  return [
    `Hi ${first},`,
    '',
    `I wanted to reach out personally about your order ${orderNumber}. It is taking a little longer than expected to reach you, and I am so sorry for the wait.`,
    '',
    ...(answer
      ? [
          'I checked the latest tracking on your package, and here is where things stand:',
          '',
          answer,
          '',
          'If there is anything I can do in the meantime, just reply to this email.',
        ]
      : [
          'We are keeping a close eye on it and will make sure it gets to you. If there is anything I can do in the meantime, just reply to this email.',
        ]),
    '',
    'Thanks so much for your patience!',
    '',
    'Warmly,',
    'The Summit Soul Team',
  ].join('\n');
}

// Pre-written "refund or free replacement?" email, for when Printify has
// refunded us and the customer gets to pick how we make it right.
export function refundOrReplacementDraft(
  orderNumber: string,
  customerName?: string | null
): string {
  const first = customerName?.trim().split(/\s+/)[0] || 'there';
  return [
    `Hi ${first},`,
    '',
    `I am so sorry your order ${orderNumber} still has not arrived. That is not the experience I want for you, and I have escalated it with our team.`,
    '',
    'I would love to make this right, and you get to pick how: a full refund back to your original payment method, or a free replacement shipped right away.',
    '',
    'Just reply and let me know which you would prefer, and I will take care of it.',
    '',
    'Thanks so much for your patience!',
    '',
    'Warmly,',
    'The Summit Soul Team',
  ].join('\n');
}

interface DelayEmailModalProps {
  orderNumber: string;
  customerEmail: string;
  customerName?: string | null;
  // Which prefilled email to open with. Defaults to the delay update so
  // existing callers are unchanged.
  template?: DelayEmailTemplate;
  // Printify support's latest answer for this order - quoted in the
  // delay-update draft when present.
  printifyAnswer?: string | null;
  onClose: () => void;
  // Record the send (page-specific bookkeeping). Runs after the email goes out.
  onSent: () => void | Promise<void>;
}

export function DelayEmailModal({
  orderNumber,
  customerEmail,
  customerName,
  template = 'delay-update',
  printifyAnswer,
  onClose,
  onSent,
}: DelayEmailModalProps) {
  const [body, setBody] = useState(() =>
    template === 'refund-or-replacement'
      ? refundOrReplacementDraft(orderNumber, customerName)
      : delayEmailDraft(orderNumber, customerName, printifyAnswer)
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once the email is out, retries only re-run the bookkeeping, never re-send.
  const [emailSent, setEmailSent] = useState(false);

  const subject =
    template === 'refund-or-replacement'
      ? `Your Summit Soul order ${orderNumber} - refund or free replacement?`
      : `Your Summit Soul order ${orderNumber} - a quick update`;

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      if (!emailSent) {
        const bodyHtml = body
          .split('\n\n')
          .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
          .join('');
        const res = await fetch('/api/threads/compose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: customerEmail,
            toName: customerName || undefined,
            subject,
            bodyHtml,
            bodyText: body,
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || 'Failed to send the email.');
        }
        setEmailSent(true);
      }
      try {
        await onSent();
      } catch {
        throw new Error('Email sent, but failed to record it. Hit the button to record it again.');
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-xl mx-4">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-sm font-semibold text-gray-900">
            {template === 'refund-or-replacement'
              ? `Ask customer: refund or replacement? - ${orderNumber}`
              : `Email about delay - ${orderNumber}`}
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4">
          <div className="mb-2 text-xs text-gray-500">
            To: {customerName ? `${customerName} ` : ''}&lt;{customerEmail}&gt;
            {'  ·  '}Subject: {subject}
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={11}
            disabled={sending || emailSent}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-gray-400 focus:outline-none disabled:opacity-60"
          />
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={send}
              disabled={sending}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              <Mail className="w-3.5 h-3.5" />
              {sending ? 'Sending...' : emailSent ? 'Record the send' : 'Send email'}
            </button>
            <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-700">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
