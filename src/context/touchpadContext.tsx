import { createContext, useContext, type ReactNode } from 'react';
import type { TouchpadExpression } from '@/hooks/useTouchpadExpression';

/**
 * The one live touchpad gesture, shared rather than re-created.
 *
 * `useTouchpadExpression` owns document-level pointer-lock and key listeners and a
 * flush timer, so calling it in two components would sample one gesture twice and
 * write the take twice over. The app calls it once — beside the MIDI keyboard, which
 * is mounted once for the same reason — and hands the result down here, the way
 * `fileIOContext` shares the one set of file operations.
 *
 * Null outside the provider rather than throwing, unlike `useFileIOState`: the button
 * that consumes this lives inside the timeline's CC strip, which the component tests
 * render on its own, and a gesture nothing has mounted is legitimately "no touchpad
 * here" rather than a wiring mistake.
 */
export const TouchpadContext = createContext<TouchpadExpression | null>(null);

export const useTouchpad = (): TouchpadExpression | null => useContext(TouchpadContext);

export function TouchpadProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: TouchpadExpression;
}) {
  return <TouchpadContext.Provider value={value}>{children}</TouchpadContext.Provider>;
}
