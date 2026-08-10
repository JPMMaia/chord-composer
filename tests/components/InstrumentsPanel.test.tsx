import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { InstrumentsPanel } from '@/components/InstrumentsPanel';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { barChords } from '@/engine/timeline';

const tracks = () => projectStore.getState().project!.tracks;
const firstId = () => tracks()[0].id;

/** The row for an instrument, by its id. */
const row = (trackId: string) => screen.getByTestId(`instrument-row-${trackId}`);

describe('InstrumentsPanel', () => {
  beforeEach(() => {
    projectStore.getState().resetProject();
    selectionStore.getState().clearSelection();
    projectStore.getState().createProject();
  });

  it('renders a titled panel', () => {
    render(<InstrumentsPanel />);
    expect(screen.getByText('Instruments')).toBeInTheDocument();
  });

  it('lists the Piano every project starts with', () => {
    render(<InstrumentsPanel />);
    expect(screen.getByText('Piano')).toBeInTheDocument();
  });

  it('adds an instrument', () => {
    render(<InstrumentsPanel />);

    fireEvent.click(screen.getByLabelText('Add instrument'));

    expect(tracks()).toHaveLength(2);
    expect(screen.getByText('Instrument 2')).toBeInTheDocument();
  });

  // Adding an instrument is how you start writing for it, and the timeline only
  // shows what is selected — leaving the old one selected reads as a dead button.
  it('selects the instrument it just added', () => {
    selectionStore.getState().selectTrack(firstId());
    render(<InstrumentsPanel />);

    fireEvent.click(screen.getByLabelText('Add instrument'));

    expect(selectionStore.getState().selectedTrackId).toBe(tracks()[1].id);
  });

  it('removes an instrument', () => {
    projectStore.getState().addTrack('Strings');
    render(<InstrumentsPanel />);

    fireEvent.click(screen.getByLabelText('Remove Strings'));

    expect(tracks().map(t => t.name)).toEqual(['Piano']);
  });

  it('selects the instrument whose row is pressed', () => {
    projectStore.getState().addTrack('Strings');
    const strings = tracks()[1].id;
    render(<InstrumentsPanel />);

    fireEvent.pointerDown(row(strings));

    expect(selectionStore.getState().selectedTrackId).toBe(strings);
  });

  it('marks the selected instrument', () => {
    selectionStore.getState().selectTrack(firstId());
    render(<InstrumentsPanel />);

    expect(row(firstId()).className).toContain('bg-indigo-900/50');
  });

  it('mutes and unmutes an instrument', () => {
    render(<InstrumentsPanel />);

    fireEvent.click(screen.getByLabelText('Mute Piano'));
    expect(tracks()[0].muted).toBe(true);

    fireEvent.click(screen.getByLabelText('Unmute Piano'));
    expect(tracks()[0].muted).toBe(false);
  });

  it('solos and unsolos an instrument', () => {
    render(<InstrumentsPanel />);

    fireEvent.click(screen.getByLabelText('Solo Piano'));
    expect(tracks()[0].solo).toBe(true);

    fireEvent.click(screen.getByLabelText('Unsolo Piano'));
    expect(tracks()[0].solo).toBe(false);
  });

  // Solo is project-wide: soloing one instrument is what silences the others, so
  // the rows that are not soloed have to say so.
  it('marks the instruments a solo silences', () => {
    projectStore.getState().addTrack('Strings');
    render(<InstrumentsPanel />);

    fireEvent.click(screen.getByLabelText('Solo Piano'));

    expect(screen.getByLabelText('Solo Strings').className).toContain('text-yellow-600/70');
    expect(screen.getByLabelText('Unsolo Piano').className).toContain('bg-yellow-500');
  });

  it('hides and shows an instrument\'s notes', () => {
    render(<InstrumentsPanel />);

    fireEvent.click(screen.getByLabelText('Hide Piano notes'));
    expect(tracks()[0].visible).toBe(false);

    fireEvent.click(screen.getByLabelText('Show Piano notes'));
    expect(tracks()[0].visible).toBe(true);
  });

  // The two toggles mean different things — one is about sound, one about the
  // piano roll — so neither may drag the other along.
  it('keeps mute and visibility independent', () => {
    render(<InstrumentsPanel />);

    fireEvent.click(screen.getByLabelText('Mute Piano'));
    fireEvent.click(screen.getByLabelText('Hide Piano notes'));

    expect(tracks()[0].muted).toBe(true);
    expect(tracks()[0].visible).toBe(false);

    fireEvent.click(screen.getByLabelText('Show Piano notes'));
    expect(tracks()[0].muted).toBe(true);
  });

  it('changes an instrument sound', () => {
    render(<InstrumentsPanel />);

    fireEvent.change(screen.getByLabelText('Sound for Piano'), {
      target: { value: 'string_ensemble_1' },
    });

    expect(tracks()[0].instrument).toBe('string_ensemble_1');
  });

  it('offers the sounds grouped by General MIDI family', () => {
    render(<InstrumentsPanel />);
    const select = screen.getByLabelText('Sound for Piano');

    // 128 flat entries would be unusable, so they are grouped into the 16 families.
    expect(select.querySelectorAll('optgroup')).toHaveLength(16);
    expect(select.querySelectorAll('option')).toHaveLength(128);
    expect(within(select).getByText('Flute')).toBeInTheDocument();
  });

  it('shows each instrument in its own colour', () => {
    projectStore.getState().addTrack('Strings');
    render(<InstrumentsPanel />);

    const swatches = screen.getAllByTestId('instrument-swatch');
    expect(swatches).toHaveLength(2);
    expect(swatches[0].style.backgroundColor).not.toBe(swatches[1].style.backgroundColor);
  });

  it('duplicates an instrument', () => {
    render(<InstrumentsPanel />);

    fireEvent.click(screen.getByLabelText('Duplicate Piano'));

    expect(tracks()).toHaveLength(2);
    expect(tracks()[1].name).toBe('Piano (copy)');
    // Auto-selected after duplication (same convention as Add).
    expect(selectionStore.getState().selectedTrackId).toBe(tracks()[1].id);
  });

  it('duplicates an instrument and copies its chords', () => {
    projectStore.getState().addBar();
    const barId = projectStore.getState().project!.bars[0].id;
    projectStore.getState().insertSegment(
      barId,
      0,
      { id: 'seg1', kind: 'chord' as const, duration: 2, root: 'C' as const, quality: 'major' as const },
      firstId()
    );

    render(<InstrumentsPanel />);
    fireEvent.click(screen.getByLabelText('Duplicate Piano'));

    const copyId = tracks()[1].id;
    const bar = projectStore.getState().project!.bars[0];
    expect(barChords(bar, firstId()).length).toBe(1);
    expect(barChords(bar, copyId).length).toBe(1);
    // The copy has a new segment id, not the original's.
    expect(barChords(bar, copyId)[0].id).not.toBe('seg1');
    // But same musical content.
    expect(barChords(bar, copyId)[0].root).toBe('C');
    expect(barChords(bar, copyId)[0].quality).toBe('major');
  });

  it('renames an instrument on double-click then enter', () => {
    render(<InstrumentsPanel />);
    const name = within(row(firstId())).getByText('Piano');

    fireEvent.doubleClick(name);
    const input = screen.getByDisplayValue('Piano');
    fireEvent.change(input, { target: { value: 'Grand Piano' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(tracks()[0].name).toBe('Grand Piano');
  });

  it('renames an instrument on blur', () => {
    render(<InstrumentsPanel />);
    const name = within(row(firstId())).getByText('Piano');

    fireEvent.doubleClick(name);
    const input = screen.getByDisplayValue('Piano');
    fireEvent.change(input, { target: { value: 'Grand Piano' } });
    fireEvent.blur(input);

    expect(tracks()[0].name).toBe('Grand Piano');
  });

  it('cancels rename on escape without changing the name', () => {
    render(<InstrumentsPanel />);
    const name = within(row(firstId())).getByText('Piano');

    fireEvent.doubleClick(name);
    const input = screen.getByDisplayValue('Piano');
    fireEvent.change(input, { target: { value: 'Something Else' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(tracks()[0].name).toBe('Piano');
  });

  it('allows renaming an empty name', () => {
    projectStore.getState().renameTrack(firstId(), '');
    render(<InstrumentsPanel />);
    const nameSpan = within(row(firstId())).getByTitle('Double-click to rename');

    fireEvent.doubleClick(nameSpan);
    const input = screen.getByDisplayValue('');
    fireEvent.change(input, { target: { value: 'Drums' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(tracks()[0].name).toBe('Drums');
  });
});
