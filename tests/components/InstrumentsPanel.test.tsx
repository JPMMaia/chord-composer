import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { InstrumentsPanel } from '@/components/InstrumentsPanel';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';

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
});
