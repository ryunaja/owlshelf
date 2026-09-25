import { useState, useEffect } from "react";

/**
 * Like useState, but the value is kept in sync with localStorage.
 * - Reads the stored JSON on first mount; falls back to `initialValue`.
 * - Writes back to localStorage whenever the value changes.
 */
export function useLocalStorage<T>(key: string, initialValue: T) {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  // Persist to localStorage whenever the value changes
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(storedValue));
    } catch {
      console.warn(`useLocalStorage: could not write key "${key}"`);
    }
  }, [key, storedValue]);

  return [storedValue, setStoredValue] as const;
}
