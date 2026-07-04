'use client';

/**
 * Playbook renderer: searchable, themed view of the rule blocks the AI runs
 * on. Content arrives pre-parsed from the server page - this component only
 * handles navigation, live search with highlighting, and readable layout.
 */

import { useMemo, useState } from 'react';
import { Search, BookOpen } from 'lucide-react';

export interface RuleItem {
  text: string;
  subs: string[];
}
export interface RuleGroup {
  heading: string | null;
  items: RuleItem[];
}
export interface PlaybookSection {
  id: string;
  title: string;
  /** Plain paragraph section (e.g. Who we are) */
  paragraph?: string;
  /** Numbered workflow steps */
  ordered?: string[];
  /** Themed rule groups */
  groups?: RuleGroup[];
  note?: string;
}

/** Case-insensitive match with <mark> highlighting. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let pos = 0;
  let i = lower.indexOf(q);
  let key = 0;
  while (i !== -1) {
    if (i > pos) idx.push(<span key={key++}>{text.slice(pos, i)}</span>);
    idx.push(
      <mark key={key++} className="rounded-sm bg-yellow-200 px-0.5">
        {text.slice(i, i + q.length)}
      </mark>
    );
    pos = i + q.length;
    i = lower.indexOf(q, pos);
  }
  if (pos < text.length) idx.push(<span key={key++}>{text.slice(pos)}</span>);
  return <>{idx}</>;
}

/** Bold a leading "LABEL:" prefix so rules scan at a glance. */
function RuleText({ text, query }: { text: string; query: string }) {
  const m = text.match(/^([^:]{3,70}):\s([\s\S]+)$/);
  if (m && /[A-Z]/.test(m[1])) {
    return (
      <>
        <span className="font-semibold text-gray-900">
          <Highlight text={m[1]} query={query} />:
        </span>{' '}
        <Highlight text={m[2]} query={query} />
      </>
    );
  }
  return <Highlight text={text} query={query} />;
}

function itemMatches(item: RuleItem, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    item.text.toLowerCase().includes(needle) ||
    item.subs.some((s) => s.toLowerCase().includes(needle))
  );
}

export function PlaybookView({ sections }: { sections: PlaybookSection[] }) {
  const [query, setQuery] = useState('');
  const q = query.trim();

  // With a query: keep only matching items, drop empty groups/sections.
  const visible = useMemo(() => {
    if (!q) return sections;
    const needle = q.toLowerCase();
    return sections
      .map((s) => {
        const paragraph =
          s.paragraph && s.paragraph.toLowerCase().includes(needle)
            ? s.paragraph
            : undefined;
        const ordered = s.ordered?.filter((o) => o.toLowerCase().includes(needle));
        const groups = s.groups
          ?.map((g) => ({
            ...g,
            items: g.items.filter(
              (it) =>
                itemMatches(it, q) ||
                (g.heading || '').toLowerCase().includes(needle)
            ),
          }))
          .filter((g) => g.items.length > 0);
        return { ...s, paragraph, ordered, groups };
      })
      .filter(
        (s) =>
          s.paragraph ||
          (s.ordered && s.ordered.length > 0) ||
          (s.groups && s.groups.length > 0)
      );
  }, [sections, q]);

  const hitCount = q
    ? visible.reduce(
        (n, s) =>
          n +
          (s.paragraph ? 1 : 0) +
          (s.ordered?.length || 0) +
          (s.groups?.reduce((m, g) => m + g.items.length, 0) || 0),
        0
      )
    : 0;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="flex items-center gap-2">
        <BookOpen className="h-6 w-6 text-emerald-700" />
        <h1 className="text-2xl font-bold text-gray-900">Support Playbook</h1>
      </div>
      <p className="mt-2 text-sm text-gray-600">
        These are the exact rules the AI drafting assistant follows - rendered
        for humans. When a rule changes, it changes here and for the AI at the
        same time, so this page is always current.
      </p>

      {/* Search + section nav, sticky so they follow the reader down */}
      <div className="sticky top-0 z-10 -mx-6 mt-4 border-b bg-gray-100/95 px-6 py-3 backdrop-blur">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Search the rules... try "refund", "cotton", "address", "discount"'
            className="w-full rounded-lg border bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </div>
        {q ? (
          <p className="mt-2 text-xs text-gray-500">
            {hitCount} matching rule{hitCount === 1 ? '' : 's'}
            {hitCount === 0 && ' - try a shorter word'}
          </p>
        ) : (
          <nav className="mt-2 flex flex-wrap gap-1.5">
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="rounded-full border bg-white px-2.5 py-1 text-xs text-gray-700 hover:border-emerald-400 hover:text-emerald-800"
              >
                {s.title}
              </a>
            ))}
          </nav>
        )}
      </div>

      {visible.map((s) => (
        <section key={s.id} id={s.id} className="mt-8 scroll-mt-28">
          <h2 className="border-b pb-2 text-lg font-bold text-gray-900">
            {s.title}
          </h2>
          {s.note && <p className="mt-2 text-xs text-gray-500">{s.note}</p>}
          {s.paragraph && (
            <p className="mt-3 text-sm leading-relaxed text-gray-700">
              <Highlight text={s.paragraph} query={q} />
            </p>
          )}
          {s.ordered && s.ordered.length > 0 && (
            <ol className="mt-3 list-decimal space-y-2 rounded-lg border border-blue-200 bg-blue-50 py-4 pl-9 pr-4 text-sm leading-relaxed text-blue-950">
              {s.ordered.map((o, i) => (
                <li key={i}>
                  <Highlight text={o} query={q} />
                </li>
              ))}
            </ol>
          )}
          {s.groups?.map((g, gi) => (
            <div key={gi} className="mt-5">
              {g.heading && (
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-emerald-800">
                  {g.heading}
                </h3>
              )}
              <ul className="space-y-2">
                {g.items.map((it, ii) => (
                  <li
                    key={ii}
                    className="rounded-md border bg-white px-3 py-2 text-sm leading-relaxed text-gray-700"
                  >
                    <RuleText text={it.text} query={q} />
                    {it.subs.length > 0 && (
                      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] text-gray-600">
                        {it.subs.map((sub, si) => (
                          <li key={si}>
                            <Highlight text={sub} query={q} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}

      {q && visible.length === 0 && (
        <p className="mt-10 text-center text-sm text-gray-500">
          Nothing matches &quot;{query}&quot;. Try a shorter word, or clear the
          search to browse by section.
        </p>
      )}
    </div>
  );
}
