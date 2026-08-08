import { createContext, useContext, type ReactNode } from 'react';
import type { UseFileIOResult } from '@/hooks/useFileIO';

/**
 * The one live set of file operations, shared rather than re-created.
 *
 * `useFileIO` owns the auto-save timer and the start-up recovery check, so calling
 * it in two components would run two timers over the same file and check for
 * recovery twice. The app calls it once and hands the result down here, the same
 * way `undoRedoContext` shares the one history stack.
 */
export const FileIOContext = createContext<UseFileIOResult | null>(null);

export const useFileIOState = (): UseFileIOResult => {
  const ctx = useContext(FileIOContext);
  if (!ctx) throw new Error('useFileIOState must be inside FileIOProvider');
  return ctx;
};

export function FileIOProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: UseFileIOResult;
}) {
  return <FileIOContext.Provider value={value}>{children}</FileIOContext.Provider>;
}
