import { useCallback, useRef } from "react";

/**
 * Gives a handler one identity for the life of the component while it always
 * calls the newest version.
 * Why: screens pass fresh arrow functions on every render. Handed to a
 * memoized row as they are, they make every row redraw on every keystroke.
 * Input: the handler, or nothing. Output: a function that never changes.
 */
export function useEvent<Args extends unknown[], Result>(
  handler: ((...args: Args) => Result) | undefined,
): (...args: Args) => Result | undefined {
  const latest = useRef(handler);
  latest.current = handler;
  return useCallback((...args: Args) => latest.current?.(...args), []);
}
