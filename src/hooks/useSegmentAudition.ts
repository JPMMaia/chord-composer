import { useCallback, useEffect, useRef } from 'react';
import type { ChordSegment } from '@/types/music';
import type { InstrumentPool } from '@/engine/instrumentPool';
import { auditionSegments } from '@/engine/audition';
import { editSurface, projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { flattenSegments } from '@/engine/timeline';
import { PHRASE_TRACK_KEY } from '@/engine/phrases';
import { projectScale, segmentScale } from '@/engine/scales';

/**
 * How long a stepped block sounds for, in milliseconds.
 *
 * Short, because this is feedback on an edit rather than playback: holding `↑`
 * through auto-repeat should give a run of separate pitches, not a smear.
 */
const PREVIEW_MS = 500;

export interface SegmentAuditionOptions {
  /** The live pool, or null while the audio graph is still down. */
  getPool?: () => InstrumentPool | null;
  /** Brings the graph up, for the first edit made before Play was ever pressed. */
  ensureAudio?: () => Promise<InstrumentPool>;
}

/**
 * Sound the blocks an edit just changed, on the instrument being edited.
 *
 * Returns a `preview(segmentIds)` that reads the segments back out of the store, so
 * callers pass ids and never stale objects: every segment transform rebuilds the
 * project around new objects, and what has to be heard is the state *after* the
 * write, not the one the caller was holding.
 *
 * Only one preview sounds at a time. A second call releases the first before
 * starting, which is what keeps a held arrow key from stacking a chord out of every
 * pitch it passed through.
 */
export function useSegmentAudition({
  getPool,
  ensureAudio,
}: SegmentAuditionOptions = {}): (segmentIds: string[]) => void {
  const releaseRef = useRef<() => void>(() => {});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    releaseRef.current();
    releaseRef.current = () => {};
  }, []);

  // A preview outlives nothing: unmounting the editor must not leave a held note.
  useEffect(() => stop, [stop]);

  return useCallback(
    (segmentIds: string[]) => {
      if (!getPool || segmentIds.length === 0) return;

      const project = projectStore.getState().project;
      const trackId = selectionStore.getState().selectedTrackId;
      if (!project || !trackId) return;

      const pool = getPool();
      if (!pool) {
        // Let this edit go unheard rather than awaiting inside a key handler; the
        // next one lands on a live graph.
        void ensureAudio?.().catch(() => {});
        return;
      }

      const surface = editSurface();
      if (!surface) return;

      const wanted = new Set(segmentIds);
      const segments: ChordSegment[] = flattenSegments(
        surface.bars,
        PHRASE_TRACK_KEY
      ).filter(s => wanted.has(s.id));
      if (segments.length === 0) return;

      stop();

      const fallback = projectScale(project.key, project.keyMode);
      releaseRef.current = auditionSegments(
        pool.get(trackId),
        segments,
        segment => segmentScale(segment, fallback),
        project.timeSignature
      );

      timerRef.current = setTimeout(stop, PREVIEW_MS);
    },
    [getPool, ensureAudio, stop]
  );
}
