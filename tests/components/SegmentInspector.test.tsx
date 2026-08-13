import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SegmentInspector } from '@/components/SegmentInspector';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { barChords, barNotes } from '@/engine/timeline';
import { generateId } from '@/utils/id';
import type { ChordSegment } from '@/types/music';

const state = () => projectStore.getState();
const trackId = () => state().project!.tracks[0].id;
const bars = () => state().project!.bars;

/** A C major triad, ready to drop into a bar. */
function chordSegment(overrides: Partial<ChordSegment> = {}): ChordSegment {
  return {
    id: generateId(),
    kind: 'chord',
    duration: 4,
    root: 'C',
    quality: 'major',
    romanNumeral: 'I',
    chordSymbol: 'C',
    octave: 4,
    ...overrides,
  };
}

/** Put a segment in a bar and select it, as clicking a block would. */
function placeAndSelect(segment: ChordSegment, barIndex = 0): ChordSegment {
  state().insertSegment(bars()[barIndex].id, 0, segment, trackId());
  selectionStore.getState().selectSegment(segment.id);
  return segment;
}

const segmentOf = (id: string): ChordSegment =>
  bars()
    .flatMap(b => barChords(b, trackId()))
    .find(c => c.id === id)!;

const pitchesOf = (id: string): number[] => {
  const bar = bars().find(b => barChords(b, trackId()).some(c => c.id === id))!;
  return barNotes(bar, trackId()).map(n => n.pitch);
};

describe('SegmentInspector', () => {
  beforeEach(() => {
    state().resetProject();
    selectionStore.getState().clearSelection();
    state().createProject();
    state().addBar();
    state().addBar();
    state().addBar();
    selectionStore.getState().selectTrack(trackId());
  });

  it('says so when nothing is selected', () => {
    render(<SegmentInspector />);
    expect(screen.getByText('No segment selected')).toBeInTheDocument();
  });

  // Selection deliberately does not follow the bar cursor, so a panel that only
  // looked in the "current" bar would blank out on a plainly selected chord.
  it('shows a chord that lives in a bar other than the selected one', () => {
    const segment = placeAndSelect(chordSegment(), 2);
    selectionStore.getState().selectBar(bars()[0].id);

    render(<SegmentInspector />);

    expect(screen.getByTestId('segment-inspector')).toBeInTheDocument();
    expect(screen.queryByText('No segment selected')).not.toBeInTheDocument();
    expect(screen.getByTestId('spacing-drop2')).toBeInTheDocument();
    expect(segmentOf(segment.id)).toBeDefined();
  });

  describe('inversion', () => {
    it('offers one button per chord tone and marks the current one', () => {
      placeAndSelect(chordSegment());
      render(<SegmentInspector />);

      expect(screen.getByTestId('inversion-0')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByTestId('inversion-3')).not.toBeInTheDocument();
    });

    it('sets the inversion it names', () => {
      const segment = placeAndSelect(chordSegment());
      render(<SegmentInspector />);

      fireEvent.click(screen.getByTestId('inversion-2'));

      expect(segmentOf(segment.id).inversion).toBe(2);
    });

    it('offers a fourth inversion for a seventh chord', () => {
      placeAndSelect(chordSegment({ quality: 'dominant7' }));
      render(<SegmentInspector />);

      expect(screen.getByTestId('inversion-3')).toBeInTheDocument();
    });
  });

  describe('spacing', () => {
    it('applies a preset and re-voices the notes', () => {
      const segment = placeAndSelect(chordSegment());
      render(<SegmentInspector />);

      fireEvent.click(screen.getByTestId('spacing-drop2'));

      expect(segmentOf(segment.id).voicing?.spacing).toBe('drop2');
      expect(pitchesOf(segment.id)).toEqual([52, 60, 67]);
    });

    it('lights no preset once a voice has been hand-tweaked', () => {
      placeAndSelect(chordSegment());
      const { rerender } = render(<SegmentInspector />);

      fireEvent.click(screen.getByTestId('spacing-drop2'));
      rerender(<SegmentInspector />);
      expect(screen.getByTestId('spacing-drop2')).toHaveAttribute('aria-pressed', 'true');

      fireEvent.click(screen.getByTestId('voice-down-2'));
      rerender(<SegmentInspector />);

      for (const preset of ['close', 'open', 'drop2', 'drop3']) {
        expect(screen.getByTestId(`spacing-${preset}`)).toHaveAttribute('aria-pressed', 'false');
      }
    });

    // Every quality this app can build has at least three tones, so drop 3 is
    // always reachable; the guard behind it only matters if a two-note quality
    // is ever added. Both chord sizes are checked so that stays true.
    it('offers drop 3 on every chord size the app can build', () => {
      placeAndSelect(chordSegment());
      const { rerender } = render(<SegmentInspector />);
      expect(screen.getByTestId('spacing-drop3')).not.toBeDisabled();

      state().resetProject();
      state().createProject();
      state().addBar();
      selectionStore.getState().selectTrack(trackId());
      placeAndSelect(chordSegment({ quality: 'maj7' }));
      rerender(<SegmentInspector />);

      expect(screen.getByTestId('spacing-drop3')).not.toBeDisabled();
    });

    it('notes that open and drop 2 coincide on a triad', () => {
      placeAndSelect(chordSegment());
      render(<SegmentInspector />);

      expect(screen.getByTestId('spacing-open')).toHaveAttribute(
        'title',
        'On a triad, open position is the same as drop 2'
      );
    });
  });

  describe('voices', () => {
    it('names the pitch each chord tone currently sounds', () => {
      placeAndSelect(chordSegment());
      render(<SegmentInspector />);

      expect(screen.getByTestId('voice-pitch-0')).toHaveTextContent('C4');
      expect(screen.getByTestId('voice-pitch-1')).toHaveTextContent('E4');
      expect(screen.getByTestId('voice-pitch-2')).toHaveTextContent('G4');
    });

    it('moves one voice an octave without touching the others', () => {
      const segment = placeAndSelect(chordSegment());
      render(<SegmentInspector />);

      fireEvent.click(screen.getByTestId('voice-down-1'));

      expect(pitchesOf(segment.id)).toEqual([52, 60, 67]);
    });

    it('disables a step that would leave the piano roll', () => {
      placeAndSelect(chordSegment({ octave: 1 }));
      render(<SegmentInspector />);

      // C1 is 24; another octave down is 12, below the roll's lowest key.
      expect(screen.getByTestId('voice-down-0')).toBeDisabled();
    });
  });

  describe('doubling', () => {
    it('adds and removes a doubled voice', () => {
      const segment = placeAndSelect(chordSegment());
      const { rerender } = render(<SegmentInspector />);

      fireEvent.click(screen.getByTestId('doubling-0-down'));
      expect(pitchesOf(segment.id)).toEqual([48, 60, 64, 67]);

      rerender(<SegmentInspector />);
      expect(screen.getByTestId('doubling-0-down')).toHaveAttribute('aria-pressed', 'true');

      fireEvent.click(screen.getByTestId('doubling-0-down'));
      expect(pitchesOf(segment.id)).toEqual([60, 64, 67]);
    });
  });

  describe('break', () => {
    it('starts as a block chord', () => {
      placeAndSelect(chordSegment());
      render(<SegmentInspector />);

      expect(screen.getByTestId('break-none')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByTestId('arpeggio-pattern')).not.toBeInTheDocument();
    });

    it('reveals the pattern control once arpeggio is chosen, and applies it', () => {
      const segment = placeAndSelect(chordSegment({ duration: 3 }));
      const { rerender } = render(<SegmentInspector />);

      fireEvent.click(screen.getByTestId('break-arpeggio'));
      rerender(<SegmentInspector />);

      const pattern = screen.getByTestId('arpeggio-pattern');
      expect(pattern).toBeInTheDocument();

      fireEvent.change(pattern, { target: { value: 'down' } });

      expect(segmentOf(segment.id).voicing?.break).toEqual({
        mode: 'arpeggio',
        pattern: 'down',
      });
    });

    it('staggers the onsets when strummed', () => {
      const segment = placeAndSelect(chordSegment());
      const { rerender } = render(<SegmentInspector />);

      fireEvent.click(screen.getByTestId('break-strum'));
      rerender(<SegmentInspector />);

      // 1/16 of a beat — the widest stagger still narrower than a written note.
      fireEvent.change(screen.getByTestId('strum-spread'), { target: { value: '0.0625' } });

      const bar = bars().find(b => barChords(b, trackId()).some(c => c.id === segment.id))!;
      expect(barNotes(bar, trackId()).map(n => n.startBeat)).toEqual([0, 0.0625, 0.125]);
    });
  });

  it('resets a voiced chord back to a plain block chord', () => {
    const segment = placeAndSelect(chordSegment());
    const original = pitchesOf(segment.id);
    render(<SegmentInspector />);

    fireEvent.click(screen.getByTestId('spacing-open'));
    fireEvent.click(screen.getByTestId('doubling-0-down'));
    expect(pitchesOf(segment.id)).not.toEqual(original);

    fireEvent.click(screen.getByTestId('reset-voicing'));

    expect(segmentOf(segment.id).voicing).toBeUndefined();
    expect(pitchesOf(segment.id)).toEqual(original);
  });

  describe('key', () => {
    it('retunes the selected chord and records its new key', () => {
      const segment = placeAndSelect(chordSegment({ scale: { root: 'C', type: 'major' } }));
      expect(pitchesOf(segment.id)).toEqual([60, 64, 67]);

      render(<SegmentInspector />);
      fireEvent.change(screen.getByLabelText('Root Note'), { target: { value: 'D' } });

      expect(segmentOf(segment.id).scale).toEqual({ root: 'D', type: 'major' });
      expect(segmentOf(segment.id).chordSymbol).toBe('D');
      expect(pitchesOf(segment.id)).toEqual([62, 66, 69]);
    });

    // The whole point of the key living on the segment rather than the bar.
    it('leaves the other blocks in the same bar alone', () => {
      const selected = chordSegment({ id: 'sel', duration: 1 });
      const neighbour = chordSegment({ id: 'nb', duration: 1 });
      state().insertSegment(bars()[0].id, 0, selected, trackId());
      state().insertSegment(bars()[0].id, 1, neighbour, trackId());
      selectionStore.getState().selectSegment(selected.id);

      render(<SegmentInspector />);
      fireEvent.change(screen.getByLabelText('Root Note'), { target: { value: 'G' } });

      expect(segmentOf('sel').root).toBe('G');
      expect(segmentOf('nb').root).toBe('C');
    });

    it('shows the key a block was written in', () => {
      placeAndSelect(chordSegment({ scale: { root: 'E', type: 'phrygian' } }));

      render(<SegmentInspector />);

      expect((screen.getByLabelText('Root Note') as HTMLSelectElement).value).toBe('E');
      expect((screen.getByLabelText('Scale Type') as HTMLSelectElement).value).toBe('phrygian');
    });

    it('falls back to the project key for a block that carries none', () => {
      placeAndSelect(chordSegment());

      render(<SegmentInspector />);

      expect((screen.getByLabelText('Root Note') as HTMLSelectElement).value).toBe('C');
      expect((screen.getByLabelText('Scale Type') as HTMLSelectElement).value).toBe('major');
    });

    it('reads blank where the selected blocks disagree, per field', () => {
      const first = chordSegment({ scale: { root: 'C', type: 'major' } });
      const second = chordSegment({ scale: { root: 'G', type: 'major' } });
      state().insertSegment(bars()[0].id, 0, first, trackId());
      state().insertSegment(bars()[1].id, 0, second, trackId());
      selectionStore.getState().setSelectedSegments([first.id, second.id]);

      render(<SegmentInspector />);

      // Roots differ, so the root reads blank — but both are major, so the type
      // still states what they agree on.
      expect((screen.getByLabelText('Root Note') as HTMLSelectElement).value).toBe('');
      expect((screen.getByLabelText('Scale Type') as HTMLSelectElement).value).toBe('major');
    });

    it('sets the type across a mixed selection without touching its roots', () => {
      const first = chordSegment({ id: 'a', scale: { root: 'C', type: 'major' } });
      const second = chordSegment({
        id: 'b',
        root: 'G',
        chordSymbol: 'G',
        scale: { root: 'G', type: 'major' },
      });
      state().insertSegment(bars()[0].id, 0, first, trackId());
      state().insertSegment(bars()[1].id, 0, second, trackId());
      selectionStore.getState().setSelectedSegments([first.id, second.id]);

      render(<SegmentInspector />);
      fireEvent.change(screen.getByLabelText('Scale Type'), {
        target: { value: 'naturalMinor' },
      });

      expect(segmentOf('a').scale).toEqual({ root: 'C', type: 'naturalMinor' });
      expect(segmentOf('b').scale).toEqual({ root: 'G', type: 'naturalMinor' });
    });

    // A note has no chord tones, but it does sit on a scale degree.
    it('is offered for a single note, and retunes it', () => {
      const note: ChordSegment = {
        id: generateId(),
        kind: 'note',
        pitch: 60,
        duration: 1,
        scale: { root: 'C', type: 'major' },
      };
      placeAndSelect(note);

      render(<SegmentInspector />);
      fireEvent.change(screen.getByLabelText('Root Note'), { target: { value: 'D' } });

      expect(segmentOf(note.id).pitch).toBe(62);
    });
  });

  describe('a selection of several chords', () => {
    it('applies a preset to every one of them', () => {
      const first = chordSegment();
      const second = chordSegment({ root: 'G', romanNumeral: 'V', chordSymbol: 'G' });
      state().insertSegment(bars()[0].id, 0, first, trackId());
      state().insertSegment(bars()[1].id, 0, second, trackId());
      selectionStore.getState().setSelectedSegments([first.id, second.id]);

      render(<SegmentInspector />);
      fireEvent.click(screen.getByTestId('spacing-drop2'));

      expect(segmentOf(first.id).voicing?.spacing).toBe('drop2');
      expect(segmentOf(second.id).voicing?.spacing).toBe('drop2');
    });

    it('lights nothing where the selected chords disagree', () => {
      const first = chordSegment({ voicing: { spacing: 'drop2', offsets: [0, -1, 0] } });
      const second = chordSegment({ root: 'G', romanNumeral: 'V' });
      state().insertSegment(bars()[0].id, 0, first, trackId());
      state().insertSegment(bars()[1].id, 0, second, trackId());
      selectionStore.getState().setSelectedSegments([first.id, second.id]);

      render(<SegmentInspector />);

      expect(screen.getByText('2 segments selected')).toBeInTheDocument();
      expect(screen.getByTestId('spacing-drop2')).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByTestId('spacing-close')).toHaveAttribute('aria-pressed', 'false');
    });

    // "The 7th" means nothing across a triad and a seventh chord at once.
    it('hides the per-tone controls when the chords differ in size', () => {
      const triad = chordSegment();
      const seventh = chordSegment({ quality: 'dominant7' });
      state().insertSegment(bars()[0].id, 0, triad, trackId());
      state().insertSegment(bars()[1].id, 0, seventh, trackId());
      selectionStore.getState().setSelectedSegments([triad.id, seventh.id]);

      render(<SegmentInspector />);

      expect(screen.queryByTestId('voice-down-0')).not.toBeInTheDocument();
      expect(screen.queryByTestId('inversion-0')).not.toBeInTheDocument();
      // Spacing and break still apply to any chord, so they stay.
      expect(screen.getByTestId('spacing-drop2')).toBeInTheDocument();
      expect(screen.getByTestId('break-arpeggio')).toBeInTheDocument();
    });
  });

  describe('velocity', () => {
    it('shows the shared value and commits a move', () => {
      const segment = placeAndSelect(chordSegment({ velocity: 55 }));
      render(<SegmentInspector />);

      expect(screen.getByTestId('segment-velocity')).toHaveValue('55');
      expect(screen.getByTestId('segment-velocity-value')).toHaveTextContent('55');

      fireEvent.change(screen.getByTestId('segment-velocity'), { target: { value: '40' } });

      expect(segmentOf(segment.id).velocity).toBe(40);
      expect(barNotes(bars()[0], trackId()).every(n => n.velocity === 40)).toBe(true);
    });

    it('reads 100 for a segment that has never been given one', () => {
      placeAndSelect(chordSegment());
      render(<SegmentInspector />);

      expect(screen.getByTestId('segment-velocity-value')).toHaveTextContent('100');
    });

    it('goes blank when the selection disagrees, and still sets both', () => {
      const quiet = chordSegment({ velocity: 40 });
      const loud = chordSegment({ velocity: 110 });
      state().insertSegment(bars()[0].id, 0, quiet, trackId());
      state().insertSegment(bars()[1].id, 0, loud, trackId());
      selectionStore.getState().setSelectedSegments([quiet.id, loud.id]);

      render(<SegmentInspector />);
      expect(screen.getByTestId('segment-velocity-value')).toHaveTextContent('—');

      fireEvent.change(screen.getByTestId('segment-velocity'), { target: { value: '70' } });

      expect(segmentOf(quiet.id).velocity).toBe(70);
      expect(segmentOf(loud.id).velocity).toBe(70);
    });

    it('is offered for a note, which has no voicing controls at all', () => {
      const note: ChordSegment = { id: generateId(), kind: 'note', pitch: 60, duration: 1 };
      placeAndSelect(note);

      render(<SegmentInspector />);

      expect(screen.getByTestId('segment-velocity')).toBeInTheDocument();
      expect(screen.queryByTestId('spacing-drop2')).not.toBeInTheDocument();
    });
  });

  it('offers no voicing controls for a single note', () => {
    const note: ChordSegment = { id: generateId(), kind: 'note', pitch: 60, duration: 1 };
    placeAndSelect(note);

    render(<SegmentInspector />);

    expect(screen.getByText('A single note has no chord tones to voice.')).toBeInTheDocument();
    expect(screen.queryByTestId('spacing-drop2')).not.toBeInTheDocument();
  });

  describe('a recorded block', () => {
    function customSegment(overrides: Partial<ChordSegment> = {}): ChordSegment {
      return {
        id: generateId(),
        kind: 'custom',
        duration: 2,
        customNotes: [
          { pitch: 60, startBeat: 0, duration: 2, velocity: 88 },
          { pitch: 64, startBeat: 0.5, duration: 1.5, velocity: 71 },
        ],
        ...overrides,
      };
    }

    it('lists the notes it holds, with their positions and velocities', () => {
      placeAndSelect(customSegment());
      render(<SegmentInspector />);

      const rows = screen.getAllByTestId(/^custom-note-/);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent('C4');
      expect(rows[0]).toHaveTextContent('88');
      expect(rows[1]).toHaveTextContent('E4');
      expect(rows[1]).toHaveTextContent('71');
    });

    it('names it as recorded rather than as a chord', () => {
      placeAndSelect(customSegment());
      render(<SegmentInspector />);

      expect(screen.getByTestId('segment-inspector')).toHaveTextContent('Recorded');
    });

    it('offers no kind conversion — there is no degree to convert', () => {
      placeAndSelect(customSegment());
      render(<SegmentInspector />);

      expect(screen.queryByTestId('segment-kind-select')).not.toBeInTheDocument();
    });

    it('offers no key or voicing controls', () => {
      placeAndSelect(customSegment());
      render(<SegmentInspector />);

      expect(screen.queryByTestId('spacing-drop2')).not.toBeInTheDocument();
      expect(screen.queryByTestId('inversion-0')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/scale root/i)).not.toBeInTheDocument();
    });

    /** Three notes struck together — what holding a chord records. */
    const heldChord = () =>
      customSegment({
        customNotes: [
          { pitch: 60, startBeat: 0, duration: 2 },
          { pitch: 64, startBeat: 0, duration: 2 },
          { pitch: 67, startBeat: 0, duration: 2 },
        ],
      });

    it('offers to convert a held chord into a chord', () => {
      placeAndSelect(heldChord());
      render(<SegmentInspector />);

      const button = screen.getByTestId('convert-custom');
      expect(button).toHaveTextContent('Convert to chord');
      expect(button).toBeEnabled();
    });

    it('offers to convert a played line into notes', () => {
      placeAndSelect(customSegment());
      render(<SegmentInspector />);

      expect(screen.getByTestId('convert-custom')).toHaveTextContent('Convert to notes');
    });

    it('converts on click, and leaves the result selected and editable', () => {
      const take = heldChord();
      placeAndSelect(take);
      render(<SegmentInspector />);

      fireEvent.click(screen.getByTestId('convert-custom'));

      expect(segmentOf(take.id).kind).toBe('chord');
      expect(selectionStore.getState().selectedSegmentIds).toEqual([take.id]);
      // The panel now speaks for a chord: the controls a recording withholds.
      expect(screen.getByTestId('segment-kind-select')).toBeInTheDocument();
      expect(screen.getByTestId('inversion-0')).toBeInTheDocument();
      expect(screen.queryByTestId('convert-custom')).not.toBeInTheDocument();
    });

    it('selects every note a converted line produced', () => {
      const take = customSegment();
      placeAndSelect(take);
      render(<SegmentInspector />);

      fireEvent.click(screen.getByTestId('convert-custom'));

      expect(selectionStore.getState().selectedSegmentIds).toHaveLength(2);
      expect(screen.getByTestId('segment-inspector')).toHaveTextContent('2 segments selected');
    });

    it('refuses a block it cannot name, and says why in the panel and the tooltip', () => {
      placeAndSelect(
        customSegment({
          customNotes: [
            { pitch: 60, startBeat: 0, duration: 2 },
            { pitch: 62, startBeat: 0, duration: 2 },
            { pitch: 64, startBeat: 0, duration: 2 },
          ],
        })
      );
      render(<SegmentInspector />);

      const button = screen.getByTestId('convert-custom');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', expect.stringContaining("don't spell a chord"));
      // Stated in the panel too — a tooltip alone is invisible on a touch screen.
      expect(screen.getByTestId('convert-custom-reason')).toHaveTextContent("don't spell a chord");
    });

    it('offers nothing for a chord segment', () => {
      placeAndSelect(chordSegment());
      render(<SegmentInspector />);

      expect(screen.queryByTestId('convert-custom')).not.toBeInTheDocument();
    });

    it('converts a whole selection of recordings at once', () => {
      const first = heldChord();
      const second = customSegment();
      state().insertSegment(bars()[0].id, 0, first, trackId());
      state().insertSegment(bars()[1].id, 0, second, trackId());
      selectionStore.getState().setSelectedSegments([first.id, second.id]);

      render(<SegmentInspector />);
      expect(screen.getByTestId('convert-custom')).toHaveTextContent('Convert 2 blocks');
      fireEvent.click(screen.getByTestId('convert-custom'));

      expect(segmentOf(first.id).kind).toBe('chord');
      expect(segmentOf(second.id).kind).toBe('note');
    });

    it('withholds the button when one of the selected blocks cannot be converted', () => {
      // All or nothing, like every other control here: half a conversion would
      // leave the selection in two different states with one press.
      const good = heldChord();
      const bad = customSegment({
        customNotes: [
          { pitch: 60, startBeat: 0, duration: 2 },
          { pitch: 62, startBeat: 0, duration: 2 },
          { pitch: 64, startBeat: 0, duration: 2 },
        ],
      });
      state().insertSegment(bars()[0].id, 0, good, trackId());
      state().insertSegment(bars()[1].id, 0, bad, trackId());
      selectionStore.getState().setSelectedSegments([good.id, bad.id]);

      render(<SegmentInspector />);

      expect(screen.getByTestId('convert-custom')).toBeDisabled();
    });

    it('says the velocity slider is only a fallback for its notes', () => {
      placeAndSelect(customSegment());
      render(<SegmentInspector />);

      expect(screen.getByTestId('segment-velocity')).toBeInTheDocument();
      expect(screen.getByText(/Recorded notes keep the velocity/)).toBeInTheDocument();
    });

    it('withholds that caption once anything else is selected too', () => {
      // The slider then means what it plainly says for the chord alongside it.
      const chord = chordSegment();
      const take = customSegment();
      state().insertSegment(bars()[0].id, 0, chord, trackId());
      state().insertSegment(bars()[1].id, 0, take, trackId());
      selectionStore.getState().setSelectedSegments([chord.id, take.id]);

      render(<SegmentInspector />);

      expect(screen.queryByText(/Recorded notes keep the velocity/)).not.toBeInTheDocument();
    });

    it('keeps the kind dropdown away from a selection that includes one', () => {
      // Converting the chord would be fine; converting the take alongside it is
      // not, so the control is withheld rather than silently applied to half.
      const chord = chordSegment();
      const take = customSegment();
      state().insertSegment(bars()[0].id, 0, chord, trackId());
      state().insertSegment(bars()[1].id, 0, take, trackId());
      selectionStore.getState().setSelectedSegments([chord.id, take.id]);

      render(<SegmentInspector />);

      expect(screen.queryByTestId('segment-kind-select')).not.toBeInTheDocument();
    });
  });
});
