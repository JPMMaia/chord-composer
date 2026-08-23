import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TouchpadPanel } from '@/components/TouchpadPanel';
import { TouchpadContext } from '@/context/touchpadContext';
import { projectStore } from '@/store/projectStore';
import type { Vst3CcInfo } from '@/engine/vst3Cc';
import type { TouchpadExpression } from '@/hooks/useTouchpadExpression';
import type { Track } from '@/types/music';

/** What the mocked plugin maps, deliberately not the whole 0-127 range. */
const MAPPED_CC: Vst3CcInfo[] = [11, 20, 21].map(controller => ({
  controller,
  paramId: 1000 + controller,
}));

const trackId = () => projectStore.getState().project!.tracks[0].id;
const track = (): Track => projectStore.getState().project!.tracks[0];
const assigned = () => track().touchpadTarget;

const gesture = (over: Partial<TouchpadExpression> = {}): TouchpadExpression => ({
  performing: false,
  controllerValue: 64,
  target: null,
  begin: vi.fn(),
  end: vi.fn(),
  ...over,
});

function show(
  options: {
    supported?: Vst3CcInfo[];
    suggested?: number | null;
    touchpad?: TouchpadExpression;
  } = {}
) {
  const { supported = MAPPED_CC, suggested = 20, touchpad = gesture() } = options;
  return render(
    <TouchpadContext.Provider value={touchpad}>
      <TouchpadPanel track={track()} supported={supported} suggested={suggested} />
    </TouchpadContext.Provider>
  );
}

const field = () =>
  screen.getByLabelText('Controller the touchpad performs') as HTMLInputElement;
const assignButton = () => screen.getByRole('button', { name: /^Assign/ });
const performButton = () => screen.getByRole('button', { name: /^Perform/ });

beforeEach(() => {
  projectStore.getState().resetProject();
  projectStore.getState().createProject();
});

describe('TouchpadPanel', () => {
  it('starts on the controller the strip is offering', () => {
    show({ suggested: 20 });
    expect(field().value).toBe('20');
  });

  it('assigns the controller to the instrument', () => {
    show();
    fireEvent.change(field(), { target: { value: '11' } });
    fireEvent.click(assignButton());

    expect(assigned()).toEqual({ kind: 'cc', controller: 11 });
  });

  it('takes CC 11 by hand, which the strip will never suggest', () => {
    // 11 is in `vst3Cc`'s reserved list, so `nextFreeCc` never offers it — but a harp
    // library bound to expression is exactly what this panel is for.
    show({ suggested: 20 });
    fireEvent.change(field(), { target: { value: '11' } });
    fireEvent.click(assignButton());

    expect(assigned()).toEqual({ kind: 'cc', controller: 11 });
  });

  it('unassigns when the assigned controller is clicked again', () => {
    projectStore.getState().setTrackTouchpadTarget(trackId(), { kind: 'cc', controller: 20 });
    show();

    expect(screen.getByRole('button', { name: 'Assigned' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Assigned' }));
    expect(assigned()).toBeUndefined();
  });

  it('shows what is already assigned when the panel opens', () => {
    projectStore.getState().setTrackTouchpadTarget(trackId(), { kind: 'cc', controller: 11 });
    show({ suggested: 20 });

    // The suggestion must not move an assignment the user made.
    expect(field().value).toBe('11');
  });

  it('refuses a controller outside the range', () => {
    show();
    fireEvent.change(field(), { target: { value: '200' } });

    expect((assignButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns when the plugin does not map the chosen controller', () => {
    // An unmapped controller resolves to no ParamID natively and every send is
    // dropped in silence, which looks exactly like a broken touchpad.
    show({ supported: MAPPED_CC });
    fireEvent.change(field(), { target: { value: '77' } });

    expect(screen.getByRole('status').textContent).toMatch(/does not accept/i);
  });

  it('says nothing about mapping when there is no mapping to check against', () => {
    // A General MIDI sound, or a plugin publishing no `IMidiMapping`, reports nothing
    // either way — so claiming the controller is wrong would be an invention.
    show({ supported: [] });
    fireEvent.change(field(), { target: { value: '77' } });

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('cannot be performed until something is assigned', () => {
    show();
    expect((performButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('enters the gesture when Perform is held, and leaves the release to the hook', () => {
    // Once the lock is taken every mouse event targets the locked element, so this
    // button never sees the `pointerup` — `begin(true)` is what says so.
    projectStore.getState().setTrackTouchpadTarget(trackId(), { kind: 'cc', controller: 11 });
    const touchpad = gesture();
    show({ touchpad });

    fireEvent.pointerDown(performButton());
    expect(touchpad.begin).toHaveBeenCalledWith(true);
  });

  it('shows the live value while performing, since the cursor is gone', () => {
    projectStore.getState().setTrackTouchpadTarget(trackId(), { kind: 'cc', controller: 11 });
    show({ touchpad: gesture({ performing: true, controllerValue: 118 }) });

    expect(performButton().textContent).toBe('Perform 118');
  });
});
