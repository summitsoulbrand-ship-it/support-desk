'use client';

import { useEffect, useState } from 'react';

/**
 * Returns a copy of `value` that only updates after it has stopped changing
 * for `delayMs`. Used to keep fast-changing inputs (search boxes) out of
 * React Query keys so we don't fire a network request per keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
