import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InstrumentsPanel } from '@/components/InstrumentsPanel';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';

const state = () => projectStore.getState();
const tracks = () => state().project!.tracks;
const groups = () => state().project!.trackGroups ?? [];

const idOf = (name: string) => tracks().find(t => t.name === name)!.id;
const groupIdOf = (name: string) => groups().find(g => g.name === name)!.id;

const row = (trackId: string) => screen.getByTestId(`instrument-row-${trackId}`);

/** The sidebar's instruments, as `group/name` or `name`. */
const order = () =>
  tracks().map(t => {
    const group = groups().find(g => g.id === t.groupId);
    return group ? `${group.name}/${t.name}` : t.name;
  });

/**
 * A drag payload, as far as jsdom is concerned.
 *
 * jsdom builds no `DataTransfer` for a synthetic drag event, so one is supplied. It
 * carries the same two entries the panel writes — the custom type and the
 * `text/plain` fallback — so what the tests exercise is the real payload.
 */
function dataTransfer(type: string, id: string) {
  const store: Record<string, string> = { [type]: id, 'text/plain': id };
  return {
    types: [type, 'text/plain'],
    getData: (key: string) => store[key] ?? '',
    setData: (key: string, value: string) => {
      store[key] = value;
    },
    dropEffect: '',
    effectAllowed: '',
  };
}

const INSTRUMENT = 'application/x-instrument';
const GROUP = 'application/x-instrument-group';

/**
 * Fire a drag event carrying a payload and a pointer position.
 *
 * Built as a `MouseEvent` rather than through `fireEvent.dragOver`, because jsdom
 * has no `DragEvent` and the fallback it substitutes drops `clientY` — which is
 * the whole of what decides which half of a row a drop landed in.
 */
function fireDrag(
  target: HTMLElement,
  type: 'dragover' | 'drop',
  transfer: ReturnType<typeof dataTransfer>,
  clientY: number
) {
  const event = new MouseEvent(type, { clientY, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  fireEvent(target, event);
}

/** Drag an instrument onto a target, landing in the given half of it. */
function dragInstrumentTo(trackId: string, target: HTMLElement, edge: 'above' | 'below') {
  const transfer = dataTransfer(INSTRUMENT, trackId);
  // Elements have no layout in jsdom, so every box is 0×0 at the origin and the
  // midpoint the panel compares against is 0.
  const clientY = edge === 'above' ? -1 : 1;
  fireDrag(target, 'dragover', transfer, clientY);
  fireDrag(target, 'drop', transfer, clientY);
}

describe('InstrumentsPanel groups', () => {
  beforeEach(() => {
    state().resetProject();
    selectionStore.getState().clearSelection();
    state().createProject(); // one instrument: Piano
    state().addTrack('Bass');
    state().addTrack('Lead');
  });

  describe('creating and removing', () => {
    it('adds a group', () => {
      render(<InstrumentsPanel />);

      fireEvent.click(screen.getByLabelText('Add group'));

      expect(groups().map(g => g.name)).toEqual(['Group 1']);
      expect(screen.getByText('Group 1')).toBeInTheDocument();
    });

    // A group is a label. Removing a label must never remove what it labelled.
    it('keeps every instrument when its group is removed', () => {
      state().addTrackGroup('Rhythm');
      state().moveTrack(idOf('Piano'), groupIdOf('Rhythm'), null);
      render(<InstrumentsPanel />);

      fireEvent.click(screen.getByLabelText('Remove group Rhythm'));

      expect(groups()).toHaveLength(0);
      expect(tracks().map(t => t.name).sort()).toEqual(['Bass', 'Lead', 'Piano']);
    });

    it('renames a group in place', () => {
      state().addTrackGroup('Rhythm');
      render(<InstrumentsPanel />);

      fireEvent.doubleClick(screen.getByText('Rhythm'));
      const input = screen.getByLabelText('Rename Rhythm');
      fireEvent.change(input, { target: { value: 'Backline' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(groups()[0].name).toBe('Backline');
    });

    it('adds an instrument straight into a group', () => {
      state().addTrackGroup('Rhythm');
      render(<InstrumentsPanel />);

      fireEvent.click(screen.getByLabelText('Add instrument to Rhythm'));

      const added = tracks()[tracks().length - 1];
      expect(added.groupId).toBe(groupIdOf('Rhythm'));
      expect(selectionStore.getState().selectedTrackId).toBe(added.id);
    });

    it('says so when a group has nothing in it', () => {
      state().addTrackGroup('Rhythm');
      render(<InstrumentsPanel />);

      expect(screen.getByText(/Empty — drag instruments/)).toBeInTheDocument();
    });
  });

  describe('collapsing', () => {
    beforeEach(() => {
      state().addTrackGroup('Rhythm');
      state().moveTrack(idOf('Piano'), groupIdOf('Rhythm'), null);
    });

    it('folds its instruments away', () => {
      render(<InstrumentsPanel />);
      expect(row(idOf('Piano'))).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Collapse Rhythm'));

      expect(screen.queryByTestId(`instrument-row-${idOf('Piano')}`)).not.toBeInTheDocument();
      // The ungrouped instruments are untouched by a fold.
      expect(row(idOf('Bass'))).toBeInTheDocument();
    });

    it('shows how many it is hiding', () => {
      state().toggleTrackGroupCollapsed(groupIdOf('Rhythm'));
      render(<InstrumentsPanel />);

      expect(screen.getByText('1')).toBeInTheDocument();
    });

    it('brings them back', () => {
      state().toggleTrackGroupCollapsed(groupIdOf('Rhythm'));
      render(<InstrumentsPanel />);

      fireEvent.click(screen.getByLabelText('Expand Rhythm'));

      expect(row(idOf('Piano'))).toBeInTheDocument();
    });
  });

  describe('group mute and solo', () => {
    beforeEach(() => {
      state().addTrackGroup('Rhythm');
      state().moveTrack(idOf('Piano'), groupIdOf('Rhythm'), null);
    });

    // The group's flag sits beside the members' own rather than overwriting them,
    // so ungrouping hands back the mix the user built.
    it('mutes the group without lighting the M on its instruments', () => {
      render(<InstrumentsPanel />);

      fireEvent.click(screen.getByLabelText('Mute group Rhythm'));

      expect(groups()[0].muted).toBe(true);
      expect(tracks().every(t => t.muted === false)).toBe(true);
      expect(screen.getByLabelText('Unmute group Rhythm')).toBeInTheDocument();
    });

    it('solos the group', () => {
      render(<InstrumentsPanel />);

      fireEvent.click(screen.getByLabelText('Solo group Rhythm'));

      expect(groups()[0].solo).toBe(true);
      expect(tracks().every(t => t.solo === false)).toBe(true);
    });
  });

  describe('drag and drop', () => {
    it('reorders ungrouped instruments', () => {
      render(<InstrumentsPanel />);

      dragInstrumentTo(idOf('Lead'), row(idOf('Piano')), 'above');

      expect(order()).toEqual(['Lead', 'Piano', 'Bass']);
    });

    it('drops an instrument below the row it landed on', () => {
      render(<InstrumentsPanel />);

      dragInstrumentTo(idOf('Piano'), row(idOf('Bass')), 'below');

      expect(order()).toEqual(['Bass', 'Piano', 'Lead']);
    });

    it('moves an instrument into a group dropped on its header', () => {
      state().addTrackGroup('Rhythm');
      render(<InstrumentsPanel />);

      const header = screen.getByTestId(`instrument-group-${groupIdOf('Rhythm')}`)
        .firstElementChild as HTMLElement;
      dragInstrumentTo(idOf('Bass'), header, 'above');

      expect(tracks().find(t => t.name === 'Bass')!.groupId).toBe(groupIdOf('Rhythm'));
    });

    it('keeps an instrument in its group when dropped on a member', () => {
      state().addTrackGroup('Rhythm');
      state().moveTrack(idOf('Piano'), groupIdOf('Rhythm'), null);
      state().moveTrack(idOf('Bass'), groupIdOf('Rhythm'), null);
      render(<InstrumentsPanel />);

      dragInstrumentTo(idOf('Bass'), row(idOf('Piano')), 'above');

      expect(order()).toEqual(['Lead', 'Rhythm/Bass', 'Rhythm/Piano']);
    });

    // Without a target below the last group there would be no way to pull the last
    // instrument out of it — every row above belongs to a group.
    it('ungroups an instrument dropped on the tail', () => {
      state().addTrackGroup('Rhythm');
      state().moveTrack(idOf('Piano'), groupIdOf('Rhythm'), null);
      render(<InstrumentsPanel />);

      dragInstrumentTo(idOf('Piano'), screen.getByTestId('instruments-drop-end'), 'below');

      expect(tracks().find(t => t.name === 'Piano')!.groupId).toBeUndefined();
    });

    it('reorders groups', () => {
      state().addTrackGroup('Rhythm');
      state().addTrackGroup('Horns');
      render(<InstrumentsPanel />);

      const rhythmHeader = screen.getByTestId(`instrument-group-${groupIdOf('Rhythm')}`)
        .firstElementChild as HTMLElement;
      const transfer = dataTransfer(GROUP, groupIdOf('Horns'));
      fireDrag(rhythmHeader, 'dragover', transfer, 0);
      fireDrag(rhythmHeader, 'drop', transfer, 0);

      expect(groups().map(g => g.name)).toEqual(['Horns', 'Rhythm']);
    });
  });

  // Reordering by drag alone is unreachable without a pointer.
  describe('keyboard reordering', () => {
    it('moves an instrument up with Alt+ArrowUp', () => {
      render(<InstrumentsPanel />);

      fireEvent.keyDown(screen.getByLabelText('Reorder Lead'), {
        key: 'ArrowUp',
        altKey: true,
      });

      expect(order()).toEqual(['Piano', 'Lead', 'Bass']);
    });

    it('moves an instrument down with Alt+ArrowDown', () => {
      render(<InstrumentsPanel />);

      fireEvent.keyDown(screen.getByLabelText('Reorder Piano'), {
        key: 'ArrowDown',
        altKey: true,
      });

      expect(order()).toEqual(['Bass', 'Piano', 'Lead']);
    });

    it('walks an instrument into the group below it', () => {
      state().addTrackGroup('Rhythm');
      state().moveTrack(idOf('Piano'), groupIdOf('Rhythm'), null);
      // Piano is now the last row, inside Rhythm; Lead sits just above it.
      render(<InstrumentsPanel />);

      fireEvent.keyDown(screen.getByLabelText('Reorder Lead'), {
        key: 'ArrowDown',
        altKey: true,
      });

      // Moving down past Piano lands after it, inside the group it just entered.
      expect(order()).toEqual(['Bass', 'Rhythm/Piano', 'Rhythm/Lead']);
    });

    it('does nothing at the top of the list', () => {
      render(<InstrumentsPanel />);
      const before = state().project;

      fireEvent.keyDown(screen.getByLabelText('Reorder Piano'), {
        key: 'ArrowUp',
        altKey: true,
      });

      expect(state().project).toBe(before);
    });

    it('ignores an arrow without Alt, which is how the list is scrolled', () => {
      render(<InstrumentsPanel />);
      const before = state().project;

      fireEvent.keyDown(screen.getByLabelText('Reorder Lead'), { key: 'ArrowUp' });

      expect(state().project).toBe(before);
    });
  });
});
