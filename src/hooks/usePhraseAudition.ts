import { useMemo } from 'react';
import type { PhraseClip } from '@/types/music';
import { projectStore } from '@/store/projectStore';
import { editorStore } from '@/store/editorStore';
import { clipBeats, clipStartBeat, phraseById } from '@/engine/phrases';

/**
 * What Play means while a phrase is open: that phrase, on its own instrument, over
 * and over.
 *
 * Opening a phrase is a statement about what the user is listening to. The song is
 * still what actually gets scheduled — a phrase becomes sound only through
 * `compileBars`, which writes it into the song's bars at each placement — so the
 * audition is not a second playback engine but a *narrowing* of the one there is:
 * a play range around the placement, repeat forced on, and one instrument audible.
 *
 * Which placement matters, because a phrase played in three choruses is three
 * stretches of song. `editingClipId` remembers the block that was opened; a phrase
 * opened without one, or an id an undo has since invalidated, falls back to the first
 * placement — the same rule `phraseBarsForDisplay` follows, so what is heard is the
 * stretch whose metre the editor is drawing.
 *
 * Null when there is nothing to audition: the arrangement is up, or the open phrase
 * has no placement at all and so occupies no song beats. Play then means what it has
 * always meant, which is the whole song.
 */
export interface PhraseAudition {
  /** The placement being heard. */
  clip: PhraseClip;
  /** The absolute song beat the placement starts on — the phrase's own beat 0. */
  baseBeat: number;
  /** How long the placement is, in beats. */
  spanBeats: number;
  /** The stretch to repeat, in the phrase's own beats. */
  localStart: number;
  localEnd: number;
  /** The same stretch in absolute song beats, which is what the scheduler wants. */
  loopStart: number;
  loopEnd: number;
  /** The only instrument that sounds: the row the placement sits on. */
  audibleTrackIds: string[];
}

export function usePhraseAudition(): PhraseAudition | null {
  const project = projectStore(s => s.project);
  const editingPhraseId = projectStore(s => s.editingPhraseId);
  const editingClipId = projectStore(s => s.editingClipId);
  const view = editorStore(s => s.view);
  const phraseLoop = editorStore(s => s.phraseLoop);

  return useMemo(() => {
    if (view !== 'phrase' || !project || !editingPhraseId) return null;
    if (!phraseById(project.phrases, editingPhraseId)) return null;

    const clip =
      project.clips.find(c => c.id === editingClipId && c.phraseId === editingPhraseId) ??
      project.clips.find(c => c.phraseId === editingPhraseId);
    if (!clip) return null;

    const baseBeat = clipStartBeat(clip, project.bars, project.timeSignature);
    const spanBeats = clipBeats(clip, project.phrases, project.bars, project.timeSignature);

    // A loop drawn before the phrase was shortened would otherwise repeat past the
    // end of it, playing whatever the next placement on the row put there.
    const clamped = {
      start: Math.min(phraseLoop?.start ?? 0, spanBeats),
      end: Math.min(phraseLoop?.end ?? spanBeats, spanBeats),
    };
    // Clamping can close the range entirely — a loop drawn in bar 4 of a phrase since
    // cut to two bars. A range with nothing in it would repeat silence forever, so it
    // reads as no range at all, which is the whole phrase.
    const whole = clamped.end - clamped.start <= 0;
    const localStart = whole ? 0 : clamped.start;
    const localEnd = whole ? spanBeats : clamped.end;

    return {
      clip,
      baseBeat,
      spanBeats,
      localStart,
      localEnd,
      loopStart: baseBeat + localStart,
      loopEnd: baseBeat + localEnd,
      audibleTrackIds: [clip.trackId],
    };
  }, [view, project, editingPhraseId, editingClipId, phraseLoop]);
}
