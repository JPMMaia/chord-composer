import { useEffect, useRef } from 'react';
import { projectStore } from '@/store/projectStore';
import { editorStore } from '@/store/editorStore';
import { PHRASE_TRACK_KEY, phraseBarsForDisplay, phraseById } from '@/engine/phrases';
import { barChords, barNotes, getBarIndexAtBeat } from '@/engine/timeline';
import type { Phrase, Project } from '@/types/music';

/**
 * While recording into a phrase, running off the end lengthens it instead of looping.
 *
 * Play with a phrase open is an *audition* — a play range around the placement with
 * repeat forced on (see `usePhraseAudition` and the config in `App`) — which is right
 * for listening back and wrong for recording: a take could never grow past the length
 * the phrase already had, because the playhead was thrown back to the top before it
 * could get there.
 *
 * The fix is not a second transport mode but a bar added *ahead of* the seam. The
 * audition's range is derived from the phrase's own length and `usePlayback` re-reads
 * its config every scheduling pass, so a phrase that grows before the playhead arrives
 * moves the seam out from under it: playback simply carries on, with no wrap to hear
 * and nothing in the scheduler to change.
 *
 * A bar of lead, rather than a beat or a tick, is what makes that seamless — it is
 * comfortably longer than a scheduling pass plus the look-ahead window, so no note and
 * no metronome click is ever scheduled against a seam that is about to move. It also
 * keeps every recorded onset inside the phrase, which is what `recordSegment` requires.
 *
 * A play range drawn on the phrase ruler is left alone: that is an explicit "repeat
 * this", and punching in over a loop is a way of working rather than an accident.
 */
export function useRecordExtend(active: boolean, playheadBeat: number): void {
  const project = projectStore(s => s.project);
  const editingPhraseId = projectStore(s => s.editingPhraseId);
  const phraseLoop = editorStore(s => s.phraseLoop);

  const enabled = active && editingPhraseId !== null && phraseLoop === null;

  /** How long the phrase was when the take opened. Nothing below this is ever trimmed. */
  const openLengthRef = useRef<number | null>(null);
  /** The playhead the last pass saw, or null when the take has only just opened. */
  const lastBeatRef = useRef<number | null>(null);

  // The edges of a take: what it found, and what it leaves behind. Bars it reached for
  // but never wrote anything into go again when it ends, so a phrase comes out exactly
  // as long as what was played.
  //
  // Declared above the growth below, and deliberately depending on neither the project
  // nor the playhead: this has to run once per take, at its two edges, and it has to
  // read the phrase's length before the first bar is added rather than after.
  useEffect(() => {
    if (!enabled || !editingPhraseId) return;
    const opening = phraseById(projectStore.getState().project?.phrases ?? [], editingPhraseId);
    if (!opening) return;
    openLengthRef.current = opening.bars.length;
    lastBeatRef.current = null;

    return () => {
      const openLength = openLengthRef.current;
      openLengthRef.current = null;
      lastBeatRef.current = null;
      if (openLength === null) return;

      const phrase = phraseById(projectStore.getState().project?.phrases ?? [], editingPhraseId);
      if (!phrase) return;

      const target = Math.max(openLength, lastWrittenBar(phrase) + 1, 1);
      if (target >= phrase.bars.length) return;
      resize(editingPhraseId, target);
    };
  }, [enabled, editingPhraseId]);

  // Grow: the playhead entering the last bar means the take is about to need another.
  useEffect(() => {
    if (!enabled || !project || !editingPhraseId) return;

    // A bar is added in response to the playhead *moving*, so the commit the take
    // opens on adds nothing: the recording pass is opened on that same commit — see
    // the order these are mounted in — and it must take its baseline from the phrase
    // as the user left it, not from one already a bar longer.
    const advanced = lastBeatRef.current !== null && playheadBeat > lastBeatRef.current;
    lastBeatRef.current = playheadBeat;
    if (!advanced) return;

    const phrase = phraseById(project.phrases, editingPhraseId);
    if (!phrase) return;

    const bars = displayBars(phrase, project);
    if (getBarIndexAtBeat(bars, project.timeSignature, playheadBeat) < bars.length - 1) return;

    resize(editingPhraseId, phrase.bars.length + 1);
    // `project` is a dependency because the growth has to be re-judged against the
    // phrase it just lengthened — that is what stops it running away a bar per pass.
  }, [enabled, project, editingPhraseId, playheadBeat]);
}

/** The bars as the editor draws them: the phrase's, wearing the metre they are played in. */
function displayBars(phrase: Phrase, project: Project) {
  const clip =
    project.clips.find(c => c.id === projectStore.getState().editingClipId) ??
    project.clips.find(c => c.phraseId === phrase.id) ??
    null;
  return phraseBarsForDisplay(phrase, project, clip);
}

/** The last bar of the phrase holding anything, or -1 for an empty phrase. */
function lastWrittenBar(phrase: Phrase): number {
  for (let i = phrase.bars.length - 1; i >= 0; i--) {
    const bar = phrase.bars[i];
    if (barChords(bar, PHRASE_TRACK_KEY).length > 0 || barNotes(bar, PHRASE_TRACK_KEY).length > 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Set the phrase's length without a history entry of its own.
 *
 * Gated exactly as a recorded block is: the bars a take adds belong to the take, so
 * Ctrl+Z scraps both together rather than picking the phrase back apart a bar at a time.
 */
function resize(phraseId: string, lengthBars: number): void {
  projectStore.getState().withRecording(() =>
    projectStore.getState().setPhraseLength(phraseId, lengthBars)
  );
}
