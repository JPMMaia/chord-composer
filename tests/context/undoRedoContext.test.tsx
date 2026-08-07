import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  UndoRedoContext,
  useUndoRedoState,
  type UndoRedoContextValue,
} from '@/context/undoRedoContext';

const mockValue: UndoRedoContextValue = {
  undo: vi.fn(),
  redo: vi.fn(),
  canUndo: true,
  canRedo: false,
};

describe('undoRedoContext', () => {
  it('provides undo/redo values to consumers inside the provider', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <UndoRedoContext.Provider value={mockValue}>{children}</UndoRedoContext.Provider>
    );

    const { result } = renderHook(() => useUndoRedoState(), { wrapper });

    expect(result.current.undo).toBe(mockValue.undo);
    expect(result.current.redo).toBe(mockValue.redo);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('throws when used outside the provider', () => {
    expect(() => renderHook(() => useUndoRedoState())).toThrow(
      'useUndoRedoState must be inside UndoRedoProvider'
    );
  });
});
