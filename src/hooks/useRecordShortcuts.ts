import { useEffect, useRef } from 'react';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { auditionSegment } from '@/engine/audition';
import { getPaletteItems, paletteItemToSegment } from '@/engine/palette';
import { songTimeToBeat } from '@/engine/scheduler';
import { MIN_SEGMENT_BEATS, snapBeat } from '@/engine/timeline';
import type { InstrumentPool } from '@/engine/instrumentPool';
import type { ChordSegment } from '@/types/music';

/** True for the elements that own their own keys — text fields, dropdowns. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  );
}

/**
 * The degree a keyboard event names, or null if it names none. `1` is the tonic.
 *
 * Read off `code` — the physical key — rather than `key`, so the number row keeps
 * working on a layout that shifts it, and so a modifier pressed *during* a held note
 * cannot change the key's identity out from under the keyup.
 */
function degreeOf(e: KeyboardEvent): number | null {
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1] ?? (e.code ? null : e.key);
  if (!digit || digit.length !== 1 || digit < '1' || digit > '9') return null;
  return Number(digit) - 1;
}

/** Stable identity for a held key, for the same reason `degreeOf` prefers `code`. */
function keyIdOf(e: KeyboardEvent): string {
  return e.code || e.key;
}

/** A key currently held down. */
interface OpenTake {
  /** The block on the timeline, or the one merely being previewed. */
  segment: ChordSegment;
  /** Where it was committed, in absolute beats. Null when only auditioning. */
  pressBeat: number | null;
  /** The instrument it was committed to, captured so a mid-take switch cannot strand it. */
  trackId: string;
  /** Silences the preview. Safe to call more than once. */
  release: () => void;
}

interface UseRecordShortcutsProps {
  isPlaying: boolean;
  /** Live song position in seconds, straight off the audio clock. */
  getSongTime: () => number;
  getPool: () => InstrumentPool | null;
}

/**
 * The number keys play the scale palette, and record it.
 *
 * `1`–`9` are the degrees of the palette's current key, in its current mode and
 * register — so `2` is `Dm` in C major with the palette on chords, `Dm7` on sevenths
 * and `D4` on notes. Pressing a key sounds the block; **while armed and playing** it
 * also writes it to the timeline at the playhead, and releasing the key sets its
 * length. `r` arms and disarms.
 *
 * The take is committed on key-*down*, at the minimum length, and re-committed at its
 * full length on key-up. Writing only at the end would leave the timeline showing
 * nothing during the very gesture that is filling it; `recordSegment` re-places a
 * block it already holds, so the two calls are the same call.
 *
 * The position comes from `getSongTime` rather than from the playhead React renders,
 * which is up to a scheduling pass (50 ms) stale — a tenth of a beat at 120 BPM, and
 * plainly audible in the result.
 */
export function useRecordShortcuts({
  isPlaying,
  getSongTime,
  getPool,
}: UseRecordShortcutsProps): void {
  const recordSegment = projectStore(s => s.recordSegment);

  /** Keys held down, by `e.key`. Outlives renders, so a re-render cannot drop a take. */
  const heldRef = useRef(new Map<string, OpenTake>());
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  useEffect(() => {
    const held = heldRef.current;

    /** Where the playhead is now, in absolute beats, snapped as the user asked. */
    const beatNow = (): number => {
      const project = projectStore.getState().project;
      const raw = songTimeToBeat(getSongTime(), project?.bpm ?? 120);
      const { recordQuantize, snapBeats } = editorStore.getState();
      // Unquantized still lands on the 0.25 floor the engine works in; the choice is
      // between the musical grid and the finest one, not between grid and chaos.
      return snapBeat(raw, recordQuantize ? snapBeats : MIN_SEGMENT_BEATS);
    };

    /**
     * End a take: silence it, and give its block the length the key was held for.
     *
     * Quantized, a block is at least one grid step long — tapping a key on a 1/4 grid
     * means a beat, not the 0.25 the arithmetic would otherwise round it down to.
     */
    const close = (key: string, commit: boolean) => {
      const take = held.get(key);
      if (!take) return;
      held.delete(key);
      take.release();

      if (!commit || take.pressBeat === null) return;

      const { recordQuantize, snapBeats } = editorStore.getState();
      const floor = recordQuantize ? snapBeats : MIN_SEGMENT_BEATS;
      const duration = Math.max(floor, beatNow() - take.pressBeat);
      recordSegment(take.trackId, take.pressBeat, { ...take.segment, duration });
    };

    const closeAll = (commit: boolean) => {
      for (const key of [...held.keys()]) close(key, commit);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;
      // Leave every modifier combination to the shortcuts that own them — Ctrl+1 is
      // a browser tab switch, and Ctrl+R a reload.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === 'r' || e.key === 'R') {
        const { recordArmed, setRecordArmed } = editorStore.getState();
        setRecordArmed(!recordArmed);
        e.preventDefault();
        return;
      }

      const degree = degreeOf(e);
      if (degree === null) return;
      const keyId = keyIdOf(e);
      // Auto-repeat would otherwise start a fresh take every 30 ms for as long as
      // the key is down, which is the opposite of what holding it means.
      if (e.repeat || held.has(keyId)) {
        e.preventDefault();
        return;
      }

      const project = projectStore.getState().project;
      const trackId = selectionStore.getState().selectedTrackId;
      if (!project || !trackId) return;

      const { paletteScale, paletteMode, paletteOctave, recordArmed } = editorStore.getState();
      const items = getPaletteItems(paletteScale, paletteMode, paletteOctave);
      // A pentatonic key has five degrees, not seven; `6` simply names nothing.
      if (degree >= items.length) return;

      const segment = paletteItemToSegment(items[degree], MIN_SEGMENT_BEATS, paletteScale);
      const release = auditionSegment(
        getPool()?.get(trackId),
        segment,
        paletteScale,
        project.timeSignature
      );

      // Armed but stopped still sounds the block: trying chords against a silent
      // timeline is how a progression gets chosen in the first place.
      let pressBeat: number | null = null;
      if (recordArmed && isPlayingRef.current) {
        pressBeat = beatNow();
        recordSegment(trackId, pressBeat, segment);
      }

      held.set(keyId, { segment, pressBeat, trackId, release });
      e.preventDefault();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const keyId = keyIdOf(e);
      if (!held.has(keyId)) return;
      close(keyId, true);
      e.preventDefault();
    };

    // Losing the window means losing the keyup, so the take is closed at whatever
    // length it had reached rather than left ringing and one tick long.
    const handleBlur = () => closeAll(true);

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      // Unmounting is not a musical event: silence what is held, but do not write
      // a length measured against a playhead that is going away.
      closeAll(false);
    };
  }, [recordSegment, getSongTime, getPool]);

  // Playback ending ends every take with it. The blocks keep the length they had
  // reached rather than being re-committed: Stop rewinds the playhead, so there is no
  // longer a position to measure a release against — and a block left short is one
  // drag from right, where a block given a wild length is not.
  useEffect(() => {
    if (isPlaying) return;
    const held = heldRef.current;
    for (const take of held.values()) take.release();
    held.clear();
  }, [isPlaying]);
}
