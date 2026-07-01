'use client';

/**
 * Global keyboard shortcuts for the email inbox:
 *   j / k  - move selection down / up the thread list (and open it)
 *   e / c  - close the current thread
 *   #      - trash the current thread
 *   s      - snooze (PENDING) the current thread
 *   r      - focus the reply editor
 *
 * Never fires while focus is in an input, textarea, select, or a
 * contenteditable (the TipTap composer), and ignores chords with
 * Cmd/Ctrl/Alt so browser shortcuts stay untouched. Each surface registers
 * only the handlers it owns (the list wires j/k, the thread view the rest).
 */

import { useEffect, useRef } from 'react';

export interface InboxShortcutHandlers {
  onNext?: () => void; // j
  onPrev?: () => void; // k
  onClose?: () => void; // e or c
  onTrash?: () => void; // #
  onSnooze?: () => void; // s
  onReplyFocus?: () => void; // r
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useInboxShortcuts(handlers: InboxShortcutHandlers) {
  // Keep the latest handlers without re-binding the listener every render
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      const h = handlersRef.current;
      let handled = false;
      switch (event.key) {
        case 'j':
          h.onNext?.();
          handled = !!h.onNext;
          break;
        case 'k':
          h.onPrev?.();
          handled = !!h.onPrev;
          break;
        case 'e':
        case 'c':
          h.onClose?.();
          handled = !!h.onClose;
          break;
        case '#':
          h.onTrash?.();
          handled = !!h.onTrash;
          break;
        case 's':
          h.onSnooze?.();
          handled = !!h.onSnooze;
          break;
        case 'r':
          h.onReplyFocus?.();
          handled = !!h.onReplyFocus;
          break;
      }
      if (handled) event.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
