/**
 * Locally-resolved comment ids - the anti-resurrection guard for the Open tab.
 *
 * Closing actions (like/reply/hide/done) remove a comment from the Open list
 * optimistically, but the real Meta/DB round-trip runs behind a queue while
 * the list keeps polling every 30s. A poll response captured BEFORE the action
 * lands would otherwise overwrite the cache and resurrect the comment. Ids in
 * this set are filtered out of any DONE-excluding view at render time, no
 * matter what a stale poll writes into the cache; they are released when the
 * action settles (success: the server now reports DONE; failure: the comment
 * is deliberately brought back).
 */

let resolved = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function markLocallyResolved(id: string) {
  if (resolved.has(id)) return;
  resolved = new Set(resolved);
  resolved.add(id);
  emit();
}

export function unmarkLocallyResolved(id: string) {
  if (!resolved.has(id)) return;
  resolved = new Set(resolved);
  resolved.delete(id);
  emit();
}

export function subscribeLocallyResolved(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLocallyResolved(): Set<string> {
  return resolved;
}
