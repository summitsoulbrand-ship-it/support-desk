'use client';

/**
 * "Link Printify" - attach a replacement order Pati made by hand in Printify to
 * an original Shopify order, so the replacement's tracking flows back to that
 * order when it ships. Same workflow as the customer sidebar's Link Printify
 * button, packaged so the Printify Escalations (Needs Attention) and Late
 * Deliveries views can use it on orders that may have no thread.
 *
 * Renders a small trigger; clicking it opens an inline dropdown with a search
 * box over the Printify order cache and a results list. Picking a result records
 * the link via POST /api/printify/relink (thread-independent).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link2, Search, AlertCircle, Loader2 } from 'lucide-react';

type PrintifyOrderResult = {
  id: string;
  orderNumber: string;
  customerName: string;
  items: string[];
  status: string;
  createdAt: string;
  alreadyLinkedTo: string | null;
};

// Loose name check to flag a likely-wrong link (a repeat customer with two
// orders, or a different customer entirely). True = plausibly the same person;
// false triggers a warning. Unknown names return true so we never warn on
// missing data. Soft guard, not a hard block. (Mirrors the sidebar helper.)
function nameLooseMatch(a?: string | null, b?: string | null): boolean {
  const tokens = (s?: string | null) =>
    (s || '')
      .toLowerCase()
      .replace(/[^a-z ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return true;
  const setB = new Set(tb);
  const shared = ta.filter((t) => setB.has(t));
  const lastA = ta[ta.length - 1];
  const lastB = tb[tb.length - 1];
  return shared.length >= 1 && (lastA === lastB || shared.length >= 2);
}

export interface LinkPrintifyPickerProps {
  /** The original Shopify order id the replacement's tracking flows back to. */
  shopifyOrderId: string;
  /** Display name of that order, e.g. "#18100". */
  shopifyOrderName: string;
  /** The original Printify order id, when known. */
  originalPrintifyOrderId?: string | null;
  /** Customer name on the original order, for the mismatch warning. */
  customerName?: string | null;
  /** When the source row has a thread, clear its stale exchange panel too. */
  threadId?: string | null;
  /** Called after a successful link with the summary line. */
  onLinked?: (summary: string) => void;
  /** Optional className for the trigger (defaults to a small inline link). */
  className?: string;
}

export function LinkPrintifyPicker({
  shopifyOrderId,
  shopifyOrderName,
  originalPrintifyOrderId,
  customerName,
  threadId,
  onLinked,
  className,
}: LinkPrintifyPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PrintifyOrderResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // The panel renders in a portal (fixed to the viewport) so the surrounding
  // overflow-auto tables in Needs Attention / Late Deliveries can't clip it.
  // Anchor it under the trigger and keep it there while open.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setCoords({ top: r.bottom + 4, left: r.left });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  // Close on an outside click (checking both the trigger and the portal panel).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const search = async (q: string) => {
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/printify/orders/search?q=${encodeURIComponent(q)}`
      );
      const json = res.ok ? await res.json() : { orders: [] };
      setResults(json.orders || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const link = async (picked: PrintifyOrderResult) => {
    if (picked.alreadyLinkedTo) return;

    const mismatch = !nameLooseMatch(customerName, picked.customerName);
    const itemLine = picked.items[0] ? `\n  Item: ${picked.items[0]}` : '';
    const confirmMsg =
      `Link Printify order ${picked.orderNumber}` +
      (picked.customerName ? ` (${picked.customerName})` : '') +
      `${itemLine}\n\nWhen it ships, its tracking goes to ${shopifyOrderName}` +
      (customerName ? ` (${customerName})` : '') +
      `.` +
      (mismatch
        ? `\n\n WARNING: the names don't match - "${picked.customerName || 'unknown'}" vs "${customerName || 'unknown'}". Make sure this is the right order before linking.`
        : '');
    if (!window.confirm(confirmMsg)) return;

    setLinkingId(picked.id);
    setError(null);
    try {
      const res = await fetch('/api/printify/relink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newPrintifyOrderId: picked.id,
          shopifyOrderId,
          shopifyOrderName,
          originalPrintifyOrderId: originalPrintifyOrderId || null,
          replacementLabel: picked.orderNumber,
          threadId: threadId || null,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.error || 'Failed to link the Printify order');
      }
      setOpen(false);
      setResults(null);
      setQuery('');
      onLinked?.(
        json?.summary ||
          `Linked ${picked.orderNumber}. Tracking will flow to ${shopifyOrderName} when it ships.`
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to link the Printify order'
      );
    } finally {
      setLinkingId(null);
    }
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        title="Link a replacement you made by hand in Printify so its tracking flows back to this order"
        className={
          className ||
          'text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1'
        }
      >
        <Link2 className="w-3 h-3" /> Link Printify
      </button>

      {open && coords && typeof document !== 'undefined' &&
        createPortal(
        <div
          ref={panelRef}
          style={{ position: 'fixed', top: coords.top, left: coords.left }}
          className="z-50 w-72 rounded-lg border bg-white p-3 shadow-lg space-y-2"
        >
          <p className="text-[11px] text-indigo-900">
            Made the replacement by hand in Printify? Find it below to link it to{' '}
            {shopifyOrderName}
            {customerName ? ` (${customerName})` : ''} - tracking will flow here
            automatically when it ships.
          </p>
          <div className="flex items-center gap-1">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') search(query);
                }}
                placeholder="Printify order # or customer name"
                className="w-full border rounded-md pl-7 pr-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"
              />
            </div>
            <button
              type="button"
              onClick={() => search(query)}
              disabled={searching}
              className="rounded-md border px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              {searching ? '...' : 'Search'}
            </button>
          </div>

          {error && <p className="text-[11px] text-red-600">{error}</p>}

          {results && results.length === 0 && !searching && (
            <p className="text-[11px] text-gray-500 italic">
              No matching Printify orders in the recent sync. Check the number, or
              it may not have synced across yet - try again in a few minutes.
            </p>
          )}

          {results && results.length > 0 && (
            <ul className="space-y-1 max-h-52 overflow-auto">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => link(r)}
                    disabled={!!linkingId || !!r.alreadyLinkedTo}
                    className="w-full text-left rounded-md border border-gray-200 bg-white hover:border-indigo-400 hover:bg-indigo-100/50 p-2 disabled:opacity-60 disabled:hover:border-gray-200 disabled:hover:bg-white"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-gray-900">
                        {r.orderNumber}
                      </span>
                      <span className="text-[11px] text-gray-500">{r.status}</span>
                    </div>
                    {r.customerName && (
                      <div className="text-[11px] text-gray-600">
                        {r.customerName}
                      </div>
                    )}
                    {r.items.length > 0 && (
                      <div className="text-[11px] text-gray-500 truncate">
                        {r.items.join(', ')}
                      </div>
                    )}
                    {!r.alreadyLinkedTo &&
                      !nameLooseMatch(customerName, r.customerName) && (
                        <div className="text-[11px] text-amber-700 mt-0.5 inline-flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" /> Different name than{' '}
                          {shopifyOrderName} - double-check
                        </div>
                      )}
                    {r.alreadyLinkedTo ? (
                      <div className="text-[11px] text-amber-700 mt-0.5">
                        Already linked to {r.alreadyLinkedTo}
                      </div>
                    ) : linkingId === r.id ? (
                      <div className="text-[11px] text-indigo-700 mt-0.5 inline-flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> Linking...
                      </div>
                    ) : (
                      <div className="text-[11px] text-indigo-700 mt-0.5 inline-flex items-center gap-1">
                        <Link2 className="w-3 h-3" /> Link this order
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>,
          document.body
        )}
    </>
  );
}
