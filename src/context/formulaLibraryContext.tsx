import { createContext, useContext, type ReactNode } from 'react';
import type { UseFormulaLibrariesResult } from '@/hooks/useFormulaLibraries';

/**
 * The one live set of formula-library operations, shared rather than re-created.
 *
 * `useFormulaLibraries` owns the start-up restore, so calling it in two components
 * would reopen every remembered file twice. The app calls it once and hands the
 * result down here, exactly as it does for `fileIOContext`.
 */
export const FormulaLibraryContext = createContext<UseFormulaLibrariesResult | null>(null);

export const useFormulaLibraryState = (): UseFormulaLibrariesResult => {
  const ctx = useContext(FormulaLibraryContext);
  if (!ctx) throw new Error('useFormulaLibraryState must be inside FormulaLibraryProvider');
  return ctx;
};

export function FormulaLibraryProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: UseFormulaLibrariesResult;
}) {
  return <FormulaLibraryContext.Provider value={value}>{children}</FormulaLibraryContext.Provider>;
}
