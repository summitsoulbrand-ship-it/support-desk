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
  exchangesHandled: number;
  orderEdits: number;
  discountAdjustments: number;
  socialReplies: number;
  commentsHidden: number;
  reviewReplies: number;
  designIdeasLogged: number;
  printifyEscalations: number;
  lateOrdersHandled: number;
}

export default function EodReportPage() {
  const [highlights, setHighlights] = useState('');
  const [blockers, setBlockers] = useState('');
  const [noBlockers, setNoBlockers] = useState(false);
  const [openLoops, setOpenLoops] = useState('');
  const [noOpenLoops, setNoOpenLoops] = useState(false);
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
        body: JSON.stringify({
          highlights,
          blockers,
          noBlockers,
          openLoops,
          noOpenLoops,
        }),
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

  // The day-in-her-words box is always required - the numbers count
  // themselves, her read on the day is the part only she can give. Blockers
  // are answered either by ticking "Nothing blocked today" or by writing it.
  const MIN_NOTE = 3;
  const highlightsOk = highlights.trim().length >= MIN_NOTE;
  const blockersOk = noBlockers || blockers.trim().length >= MIN_NOTE;
  const openLoopsOk = noOpenLoops || openLoops.trim().length >= MIN_NOTE;
  const canSend = highlightsOk && blockersOk && openLoopsOk;

  const s = data?.stats;
  const facts: { label: string; value: number }[] = s
    ? [
        { label: 'Replies sent', value: s.repliesSent },
        { label: 'Threads handled', value: s.threadsReplied },
        { label: 'Threads closed', value: s.threadsClosed },
        { label: 'Social replies', value: s.socialReplies },
        { label: 'Comments hidden', value: s.commentsHidden },
        { label: 'Replacements created', value: s.replacements },
        { label: 'Refunds issued', value: s.refunds },
        { label: 'Cancellations', value: s.cancellations },
        { label: 'Exchanges handled', value: s.exchangesHandled },
        { label: 'Order changes (pre-production)', value: s.preproductionChanges },
        { label: 'Address / order fixes', value: s.orderEdits },
        { label: 'Discounts given', value: s.discountAdjustments },
        { label: 'Review replies', value: s.reviewReplies },
        { label: 'Design ideas logged', value: s.designIdeasLogged },
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
            How did today go, in your own words?{' '}
            <span className="text-red-500">(required)</span>
          </label>
          <p className="text-xs text-gray-400 mb-2">
            The highlights and the lowlights. What went well, what went badly,
            what customers kept asking about. A few sentences is plenty.
          </p>
          <textarea
            value={highlights}
            onChange={(e) => setHighlights(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="e.g. Quiet morning, busy afternoon. Two customers asked about kids sizes for the Bison design. One angry about a late package, calmed down after the replacement offer."
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {!highlightsOk && (
            <p className="text-xs text-amber-600 mt-1">
              Please fill this in before sending.
            </p>
          )}
        </div>

        <div className="bg-white border rounded-lg p-4 mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Anything blocked or unclear?{' '}
            <span className="text-red-500">(required)</span>
          </label>
          <p className="text-xs text-gray-400 mb-2">
            Questions for Pati, things you were unsure about, tools misbehaving.
          </p>

          <label className="flex items-center gap-2 mb-3 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={noBlockers}
              onChange={(e) => {
                setNoBlockers(e.target.checked);
                if (e.target.checked) setBlockers('');
              }}
              className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            Nothing blocked today
          </label>

          <textarea
            value={blockers}
            onChange={(e) => setBlockers(e.target.value)}
            disabled={noBlockers}
            rows={3}
            maxLength={2000}
            placeholder="e.g. Wasn't sure how to handle the wholesale inquiry from..."
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 disabled:text-gray-400"
          />
          {!blockersOk && (
            <p className="text-xs text-amber-600 mt-1">
              Either tick &quot;Nothing blocked today&quot; or write what came
              up.
            </p>
          )}
        </div>

        <div className="bg-white border rounded-lg p-4 mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Anything still open for tomorrow?{' '}
            <span className="text-red-500">(required)</span>
          </label>
          <p className="text-xs text-gray-400 mb-2">
            Customers waiting on an answer, orders you are watching, anything
            someone has to pick up if you are out.
          </p>

          <label className="flex items-center gap-2 mb-3 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={noOpenLoops}
              onChange={(e) => {
                setNoOpenLoops(e.target.checked);
                if (e.target.checked) setOpenLoops('');
              }}
              className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            Nothing pending
          </label>

          <textarea
            value={openLoops}
            onChange={(e) => setOpenLoops(e.target.value)}
            disabled={noOpenLoops}
            rows={3}
            maxLength={2000}
            placeholder="e.g. Waiting on Printify for order #17322, promised the customer an update Thursday."
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 disabled:text-gray-400"
          />
          {!openLoopsOk && (
            <p className="text-xs text-amber-600 mt-1">
              Either tick &quot;Nothing pending&quot; or write what is still
              open.
            </p>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-600 mb-3">{error}</p>
        )}

        {!canSend && (
          <p className="text-sm text-amber-700 mb-3">
            All three questions above need an answer before you can send the
            report.
          </p>
        )}

        <button
          onClick={submit}
          disabled={sending || isLoading || !canSend}
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
