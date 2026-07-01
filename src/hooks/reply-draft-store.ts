'use client';

/**
 * Per-thread reply draft store.
 *
 * Hand-typed composer content survives thread switches (in-memory Map for the
 * session) and page reloads (localStorage backup). Entries are written only
 * for real local edits - the server AI draft is NOT persisted here, so a
 * fresh server draft is never shadowed by a stale copy. Cleared on a
 * successful send.
 */

const drafts = new Map<string, string>();

const storageKey = (threadId: string) => `reply-draft:${threadId}`;

export function getReplyDraft(threadId: string): string {
  const inMemory = drafts.get(threadId);
  if (inMemory !== undefined) return inMemory;
  try {
    if (typeof window === 'undefined') return '';
    const stored = window.localStorage.getItem(storageKey(threadId));
    if (stored) {
      drafts.set(threadId, stored);
      return stored;
    }
  } catch {
    // localStorage unavailable (private mode / quota) - Map still works
  }
  return '';
}

export function setReplyDraft(threadId: string, html: string) {
  if (!html.trim()) {
    clearReplyDraft(threadId);
    return;
  }
  drafts.set(threadId, html);
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey(threadId), html);
    }
  } catch {
    // best-effort backup only
  }
}

export function clearReplyDraft(threadId: string) {
  drafts.delete(threadId);
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(storageKey(threadId));
    }
  } catch {
    // best-effort backup only
  }
}
