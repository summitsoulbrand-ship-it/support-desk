'use client';

/**
 * Delay-email modal - shared by Late deliveries and Needs Attention.
 * Prefills the delay-update email, lets the operator review and edit it, and
 * only sends on explicit confirm (via /api/threads/compose). After the email
 * goes out, the page-specific bookkeeping runs through onSent; if that step
 * fails, retrying never re-sends the email.
 */

import { useState } from 'react';
import { Mail, X } from 'lucide-react';

// Pre-written delay-update email, ready for the operator to review and edit.
export function delayEmailDraft(orderNumber: string, customerName?: string | null): string {
  const first = customerName?.trim().split(/\s+/)[0] || 'there';
  return [
    `Hi ${first},`,
    '',
    `I wanted to reach out personally about your order ${orderNumber}. It is taking a little longer than expected to reach you, and I am so sorry for the wait.`,
    '',
    'We are keeping a close eye on it and will make sure it gets to you. If there is anything I can do in the meantime, just reply to this email.',
    '',
    'Thanks so much for your patience!',
    '',
    'Best,',
    'Pati | Summit Soul',
  ].join('\n');
}

interface DelayEmailModalProps {
  orderNumber: string;
  customerEmail: string;
  customerName?: string | null;
  onClose: () => void;
  // Record the send (page-specific bookkeeping). Runs after the email goes out.
  onSent: () => void | Promise<void>;
}

export function DelayEmailModal({
  orderNumber,
  customerEmail,
  customerName,
  onClose,
  onSent,
}: DelayEmailModalProps) {
  const [body, setBody] = useState(() => delayEmailDraft(orderNumber, customerName));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once the email is out, retries only re-run the bookkeeping, never re-send.
  const [emailSent, setEmailSent] = useState(false);

  const subject = `Your Summit Soul order ${orderNumber} - a quick update`;

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
            Email about delay - {orderNumber}
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
