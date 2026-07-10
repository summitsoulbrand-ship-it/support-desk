'use client';

/**
 * End-of-day report (agent) - the facts fill themselves in, the agent adds
 * anything worth saying, one button sends it to Pati's Slack channel.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Send, CheckCircle2, Loader2 } from 'lucide-react';

interface EodStats {
  date: string;
  repliesSent: number;
  threadsReplied: number;
  threadsClosed: number;
  escalations: number;
  replacements: number;
  refunds: number;
  cancellations: number;
  preproductionChanges: number;
  socialReplies: number;
  reviewReplies: number;
  printifyEscalations: number;
  lateOrdersHandled: number;
}

export default function EodReportPage() {
  const [highlights, setHighlights] = useState('');
  const [blockers, setBlockers] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ stats: EodStats; name: string }>({
    queryKey: ['eod-report'],
    queryFn: async () => {
      const res = await fetch('/api/eod-report');
      if (!res.ok) throw new Error('Failed to load stats');
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/eod-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ highlights, blockers }),
      });
      const result = await res.json();
      if (!res.ok || !result.success) {
        throw new Error(result.error || 'Failed to send the report');
      }
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send the report');
    } finally {
      setSending(false);
    }
  };

  const s = data?.stats;
  const facts: { label: string; value: number }[] = s
    ? [
        { label: 'Replies sent', value: s.repliesSent },
        { label: 'Threads handled', value: s.threadsReplied },
        { label: 'Threads closed', value: s.threadsClosed },
        { label: 'Social replies', value: s.socialReplies },
        { label: 'Replacements created', value: s.replacements },
        { label: 'Refunds issued', value: s.refunds },
        { label: 'Cancellations', value: s.cancellations },
        { label: 'Order changes (pre-production)', value: s.preproductionChanges },
        { label: 'Review replies', value: s.reviewReplies },
        { label: 'Printify escalations filed', value: s.printifyEscalations },
        { label: 'Late deliveries handled', value: s.lateOrdersHandled },
        { label: 'Escalated to Pati', value: s.escalations },
      ]
    : [];

  if (sent) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-center max-w-md px-4">
          <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            Report sent!
          </h2>
          <p className="text-gray-600">
            Pati has your end-of-day report. Have a great evening!
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50">
      <div className="max-w-2xl mx-auto p-6">
        <div className="flex items-center gap-2 mb-1">
          <ClipboardList className="w-6 h-6 text-indigo-600" />
          <h1 className="text-xl font-semibold text-gray-900">
            End of day report
          </h1>
        </div>
        <p className="text-sm text-gray-500 mb-6">
          {s ? `${data?.name} - ${s.date}` : 'Loading your day...'} · The
          numbers fill in automatically; add anything worth telling Pati and
          hit send.
        </p>

        {/* Auto facts */}
        <div className="bg-white border rounded-lg p-4 mb-5">
          <h2 className="text-sm font-medium text-gray-700 mb-3">
            Today, automatically counted
          </h2>
          {isLoading ? (
            <div className="flex items-center gap-2 text-gray-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Counting your day...
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {facts
                .filter((f, i) => i < 3 || f.value > 0)
                .map((f) => (
                  <div
                    key={f.label}
                    className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2"
                  >
                    <div className="text-2xl font-semibold text-gray-900">
                      {f.value}
                    </div>
                    <div className="text-[11px] text-gray-500 leading-tight">
                      {f.label}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>

        {/* Free-text sections */}
        <div className="bg-white border rounded-lg p-4 mb-5">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Anything worth sharing? <span className="text-gray-400">(optional)</span>
          </label>
          <p className="text-xs text-gray-400 mb-2">
            Wins, unusual customer situations, feedback you noticed, ideas.
          </p>
          <textarea
            value={highlights}
            onChange={(e) => setHighlights(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="e.g. Two customers asked about kids sizes for the Bison design..."
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div className="bg-white border rounded-lg p-4 mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Anything blocked or unclear?{' '}
            <span className="text-gray-400">(optional)</span>
          </label>
          <p className="text-xs text-gray-400 mb-2">
            Questions for Pati, things you were unsure about, tools misbehaving.
          </p>
          <textarea
            value={blockers}
            onChange={(e) => setBlockers(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="e.g. Wasn't sure how to handle the wholesale inquiry from..."
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        {error && (
          <p className="text-sm text-red-600 mb-3">{error}</p>
        )}

        <button
          onClick={submit}
          disabled={sending || isLoading}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {sending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
          {sending ? 'Sending...' : 'Send report to Pati'}
        </button>
      </div>
    </div>
  );
}
