/**
 * Auto-sync hook - periodically syncs emails and Printify orders in the background
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const EMAIL_SYNC_INTERVAL = 300000; // 5 minutes
const MIN_EMAIL_SYNC_INTERVAL = 300000; // Minimum 5 minutes between email syncs
// If the background worker synced within this window, the browser skips its
// own (slow) IMAP sync and just refreshes the inbox from the database.
const WORKER_HEARTBEAT_FRESH_MS = 5 * 60 * 1000;
const PRINTIFY_SYNC_INTERVAL = 900000; // 15 minutes
const MIN_PRINTIFY_SYNC_INTERVAL = 600000; // Minimum 10 minutes between Printify syncs

export interface SyncState {
  isEmailSyncing: boolean;
  lastEmailSyncResult: { messagesProcessed: number } | null;
}

export function useAutoSync() {
  const queryClient = useQueryClient();
  const lastEmailSyncRef = useRef<number>(0);
  const lastPrintifySyncRef = useRef<number>(0);
  const isEmailSyncingRef = useRef(false);
  const isPrintifySyncingRef = useRef(false);

  const [syncState, setSyncState] = useState<SyncState>({
    isEmailSyncing: false,
    lastEmailSyncResult: null,
  });

  const doEmailSync = useCallback(async (force = false) => {
    // Prevent concurrent syncs
    if (isEmailSyncingRef.current) return;

    // Enforce minimum interval
    const now = Date.now();
    if (!force && now - lastEmailSyncRef.current < MIN_EMAIL_SYNC_INTERVAL) return;

    isEmailSyncingRef.current = true;
    lastEmailSyncRef.current = now;
    setSyncState((prev) => ({ ...prev, isEmailSyncing: true }));

    try {
      // If the background worker has synced recently, the browser doesn't
      // need to: just refresh the inbox from the DB instead.
      if (!force) {
        try {
          const statusRes = await fetch('/api/sync');
          if (statusRes.ok) {
            const status = await statusRes.json();
            const lastSyncAt = status.mailboxes?.[0]?.lastSyncAt;
            if (
              lastSyncAt &&
              Date.now() - new Date(lastSyncAt).getTime() < WORKER_HEARTBEAT_FRESH_MS
            ) {
              queryClient.invalidateQueries({ queryKey: ['threads'] });
              return;
            }
          }
        } catch {
          // Status check failed - fall through to a normal sync attempt
        }
      }

      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.ok) {
        const data = await res.json();
        setSyncState((prev) => ({
          ...prev,
          lastEmailSyncResult: { messagesProcessed: data.messagesProcessed || 0 },
        }));
        if (data.messagesProcessed > 0) {
          // Invalidate threads query to refresh inbox
          queryClient.invalidateQueries({ queryKey: ['threads'] });
        }
      }
      // Silently ignore non-ok responses (e.g., 503 when email not configured)
    } catch {
      // Silently ignore network errors during background sync
    } finally {
      isEmailSyncingRef.current = false;
      setSyncState((prev) => ({ ...prev, isEmailSyncing: false }));
    }
  }, [queryClient]);

  const doPrintifySync = useCallback(async () => {
    // Prevent concurrent syncs
    if (isPrintifySyncingRef.current) return;

    // Enforce minimum interval
    const now = Date.now();
    if (now - lastPrintifySyncRef.current < MIN_PRINTIFY_SYNC_INTERVAL) return;

    isPrintifySyncingRef.current = true;
    lastPrintifySyncRef.current = now;

    try {
      const res = await fetch('/api/admin/printify/sync', {
        method: 'POST',
      });

      if (res.ok) {
        // Invalidate printify sync status
        queryClient.invalidateQueries({ queryKey: ['printify-sync-status'] });
      }
      // Silently ignore non-ok responses (e.g., when Printify not configured)
    } catch {
      // Silently ignore network errors during background sync
    } finally {
      isPrintifySyncingRef.current = false;
    }
  }, [queryClient]);

  useEffect(() => {
    // Initial email sync on mount (immediate)
    doEmailSync();

    // Initial Printify sync (with a longer delay)
    const initialPrintifyTimeout = setTimeout(() => {
      doPrintifySync();
    }, 15000);

    const emailInterval = setInterval(doEmailSync, EMAIL_SYNC_INTERVAL);
    const printifyInterval = setInterval(doPrintifySync, PRINTIFY_SYNC_INTERVAL);

    // Also sync email when window gains focus
    const handleFocus = () => {
      doEmailSync();
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      clearTimeout(initialPrintifyTimeout);
      clearInterval(emailInterval);
      clearInterval(printifyInterval);
      window.removeEventListener('focus', handleFocus);
    };
  }, [doEmailSync, doPrintifySync]);

  // Return manual sync triggers and state (manual trigger always forces a
  // real sync, bypassing the worker-heartbeat shortcut)
  return {
    triggerSync: () => doEmailSync(true),
    triggerPrintifySync: doPrintifySync,
    ...syncState,
  };
}
