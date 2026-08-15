import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRecordSession } from '@/hooks/useRecordSession';
import { projectStore } from '@/store/projectStore';

const state = () => projectStore.getState();

function mountProject() {
  state().resetProject();
  state().createProject();
}

describe('useRecordSession', () => {
  let ur: { beginPass: ReturnType<typeof vi.fn>; endPass: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mountProject();
    ur = { beginPass: vi.fn(), endPass: vi.fn() };
  });

  const mount = (active: boolean) =>
    renderHook(({ active }: { active: boolean }) => useRecordSession(active, ur), {
      initialProps: { active },
    });

  it('does nothing while not recording', () => {
    mount(false);
    expect(ur.beginPass).not.toHaveBeenCalled();
    expect(ur.endPass).not.toHaveBeenCalled();
  });

  it('opens a pass on the live project when recording starts', () => {
    mount(true);
    expect(ur.beginPass).toHaveBeenCalledTimes(1);
    expect(ur.beginPass).toHaveBeenCalledWith(state().project);
  });

  it('closes the pass when recording stops', () => {
    const { rerender } = mount(true);
    rerender({ active: false });
    expect(ur.endPass).toHaveBeenCalledTimes(1);
  });

  it('closes the pass on unmount', () => {
    const { unmount } = mount(true);
    unmount();
    expect(ur.endPass).toHaveBeenCalledTimes(1);
  });

  it('re-opens the pass when another project is loaded mid-take', () => {
    const { rerender } = mount(true);
    mountProject();
    rerender({ active: true });
    expect(ur.endPass).toHaveBeenCalledTimes(1);
    expect(ur.beginPass).toHaveBeenCalledTimes(2);
    expect(ur.beginPass).toHaveBeenLastCalledWith(state().project);
  });
});
