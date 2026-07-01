'use client';

/**
 * Tiny external store for background-send failures.
 *
 * Send & Close advances to the next thread immediately and runs the SMTP
 * round-trip in the background - so a failure can surface while the operator
 * is anywhere else in the inbox. Errors land here and the inbox list renders
 * them as a persistent, dismissible banner. The unsent reply itself is
 * restored into the per-thread draft store, so nothing is lost.
 */

import { useSyncExternalStore } from 'react';

export interface SendError {
  id: number;
  threadId: string;
  subject: string;
  message: string;
}

let errors: SendError[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function addSendError(error: Omit<SendError, 'id'>) {
  errors = [...errors, { ...error, id: nextId++ }];
  emit();
}

export function dismissSendError(id: number) {
  errors = errors.filter((e) => e.id !== id);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => errors;

export function useSendErrors(): SendError[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
