import { createContext, useContext, type ReactNode } from 'react';

export interface UndoRedoContextValue {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export const UndoRedoContext = createContext<UndoRedoContextValue | null>(null);

export const useUndoRedoState = () => {
  const ctx = useContext(UndoRedoContext);
  if (!ctx) throw new Error('useUndoRedoState must be inside UndoRedoProvider');
  return ctx;
};

export function UndoRedoProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: UndoRedoContextValue;
}) {
  return <UndoRedoContext.Provider value={value}>{children}</UndoRedoContext.Provider>;
}
