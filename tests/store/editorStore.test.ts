import { describe, it, expect, beforeEach } from 'vitest';
import { editorStore } from '@/store/editorStore';
import { DEFAULT_SNAP_BEATS, SNAP_OPTIONS } from '@/engine/timeline';
import { MAX_SEGMENT_OCTAVE, MIN_SEGMENT_OCTAVE } from '@/utils/constants';

describe('editorStore', () => {
  beforeEach(() => {
    editorStore.setState({
      snapBeats: DEFAULT_SNAP_BEATS,
      scrollX: 0,
      maxScrollX: 0,
      viewportWidth: 0,
      paletteMode: 'chords',
      paletteOctave: 4,
      recordArmed: false,
      recordQuantize: true,
    });
  });

  it('starts on the default snap resolution', () => {
    expect(editorStore.getState().snapBeats).toBe(DEFAULT_SNAP_BEATS);
  });

  it('accepts every offered snap resolution', () => {
    for (const option of SNAP_OPTIONS) {
      editorStore.getState().setSnapBeats(option.beats);
      expect(editorStore.getState().snapBeats).toBe(option.beats);
    }
  });

  it('ignores a resolution that is not on the menu', () => {
    // Guards against a stale <select> value silently disabling snapping.
    editorStore.getState().setSnapBeats(0);
    editorStore.getState().setSnapBeats(1.7);
    expect(editorStore.getState().snapBeats).toBe(DEFAULT_SNAP_BEATS);
  });

  describe('palette settings', () => {
    it('starts on chords at octave 4', () => {
      expect(editorStore.getState().paletteMode).toBe('chords');
      expect(editorStore.getState().paletteOctave).toBe(4);
    });

    it('switches mode and octave', () => {
      editorStore.getState().setPaletteMode('sevenths');
      editorStore.getState().setPaletteOctave(6);
      expect(editorStore.getState().paletteMode).toBe('sevenths');
      expect(editorStore.getState().paletteOctave).toBe(6);
    });

    it('clamps the octave to the registers a segment may live in', () => {
      editorStore.getState().setPaletteOctave(99);
      expect(editorStore.getState().paletteOctave).toBe(MAX_SEGMENT_OCTAVE);
      editorStore.getState().setPaletteOctave(-1);
      expect(editorStore.getState().paletteOctave).toBe(MIN_SEGMENT_OCTAVE);
    });
  });

  describe('recording', () => {
    it('starts disarmed, with quantize on', () => {
      expect(editorStore.getState().recordArmed).toBe(false);
      expect(editorStore.getState().recordQuantize).toBe(true);
    });

    it('arms and disarms', () => {
      editorStore.getState().setRecordArmed(true);
      expect(editorStore.getState().recordArmed).toBe(true);
      editorStore.getState().setRecordArmed(false);
      expect(editorStore.getState().recordArmed).toBe(false);
    });

    it('turns quantize off', () => {
      editorStore.getState().setRecordQuantize(false);
      expect(editorStore.getState().recordQuantize).toBe(false);
    });
  });

  describe('shared horizontal scroll', () => {
    it('starts unscrolled', () => {
      expect(editorStore.getState().scrollX).toBe(0);
      expect(editorStore.getState().maxScrollX).toBe(0);
    });

    it('derives the scroll limit from the content and viewport widths', () => {
      editorStore.getState().setScrollExtent(2000, 800);
      expect(editorStore.getState().maxScrollX).toBe(1200);
      expect(editorStore.getState().viewportWidth).toBe(800);
    });

    it('has nowhere to scroll when the content fits', () => {
      editorStore.getState().setScrollExtent(400, 800);
      expect(editorStore.getState().maxScrollX).toBe(0);
    });

    it('clamps the offset to the scrollable range', () => {
      editorStore.getState().setScrollExtent(2000, 800);

      editorStore.getState().setScrollX(-50);
      expect(editorStore.getState().scrollX).toBe(0);

      editorStore.getState().setScrollX(5000);
      expect(editorStore.getState().scrollX).toBe(1200);
    });

    it('pulls the view back when the content shrinks under it', () => {
      // Removing bars or narrowing the window must not leave the view parked
      // past the end of the project, showing nothing.
      editorStore.getState().setScrollExtent(2000, 800);
      editorStore.getState().setScrollX(1200);

      editorStore.getState().setScrollExtent(1000, 800);
      expect(editorStore.getState().scrollX).toBe(200);
    });

    it('falls back to the start on a non-finite offset rather than poisoning the axis', () => {
      editorStore.getState().setScrollExtent(2000, 800);
      editorStore.getState().setScrollX(400);
      editorStore.getState().setScrollX(Number.NaN);
      expect(editorStore.getState().scrollX).toBe(0);
    });
  });
});
