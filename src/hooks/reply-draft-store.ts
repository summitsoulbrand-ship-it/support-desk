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

/**
 * Dismissed AI drafts.
 *
 * Emptying the composer is an explicit "I don't want this draft" - without a
 * record of that, the auto-load effect sees an empty editor and puts the same
 * server draft straight back, so the draft looks undeletable. Keyed by a hash
 * of the draft body, so a genuinely NEW draft (regenerated or refined) still
 * loads while the dismissed one stays gone.
 */

const dismissed = new Map<string, string>();

const dismissKey = (threadId: string) => `ai-draft-dismissed:${threadId}`;

function hashBody(body: string): string {
  let h = 5381;
  for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

function getDismissedHash(threadId: string): string {
  const inMemory = dismissed.get(threadId);
  if (inMemory !== undefined) return inMemory;
  try {
    if (typeof window === 'undefined') return '';
    const stored = window.localStorage.getItem(dismissKey(threadId));
    if (stored) {
      dismissed.set(threadId, stored);
      return stored;
    }
  } catch {
    // localStorage unavailable - Map still works for the session
  }
  return '';
}

export function dismissAiDraft(threadId: string, body: string) {
  if (!body) return;
  const hash = hashBody(body);
  dismissed.set(threadId, hash);
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(dismissKey(threadId), hash);
    }
  } catch {
    // best-effort backup only
  }
}

export function isAiDraftDismissed(threadId: string, body: string): boolean {
  if (!body) return false;
  return getDismissedHash(threadId) === hashBody(body);
}

export function clearAiDraftDismissal(threadId: string) {
  dismissed.delete(threadId);
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(dismissKey(threadId));
    }
  } catch {
    // best-effort backup only
  }
}
