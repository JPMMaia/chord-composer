import { projectStore } from '@/store/projectStore';
import { PHRASE_TRACK_KEY } from '@/engine/phrases';
import type { Bar, ChordSegment, Note, TrackContent } from '@/types/music';

/**
 * Put the store in the state the timeline actually edits in: one phrase, placed at
 * bar 0, open.
 *
 * Every segment action addresses the *open phrase* rather than the song, so a test
 * that drops, drags or transposes a block needs one open or it is testing the
 * arrangement view's shrug. Called from `beforeEach`, this restores what those tests
 * assumed before phrases existed — one part, spanning the song, ready to write into.
 *
 * Returns the phrase id and the clip id, for the tests that care which.
 */
export function openTestPhrase(
  trackId: string,
  lengthBars: number = 1
): { phraseId: string; clipId: string } {
  const store = projectStore.getState();
  const clipId = store.addPhraseClip(trackId, 0, lengthBars);
  if (!clipId) throw new Error('openTestPhrase: could not place a phrase');

  const clip = projectStore.getState().project!.clips.find(c => c.id === clipId)!;
  projectStore.getState().openClip(clipId);
  return { phraseId: clip.phraseId, clipId };
}

/** The bars of the phrase currently open — what the timeline is showing. */
export function editedBars(): Bar[] {
  const state = projectStore.getState();
  const phrase = state.project!.phrases.find(p => p.id === state.editingPhraseId);
  if (!phrase) throw new Error('editedBars: no phrase is open');
  return phrase.bars;
}

/** The open phrase's segments in one of its bars. */
export function editedChords(barIndex: number): ChordSegment[] {
  return editedBars()[barIndex]?.content[PHRASE_TRACK_KEY]?.chords ?? [];
}

/** Phrase-local bar content, for building fixtures by hand. */
export function phraseContent(
  chords: ChordSegment[] = [],
  notes: Note[] = []
): Record<string, TrackContent> {
  return { [PHRASE_TRACK_KEY]: { chords, notes } };
}

/**
 * The bars an edit lands in: the open phrase's, or the song's when none is open.
 *
 * The one accessor the pre-phrase tests need in order to go on meaning what they meant.
 * A test about *segments* opens a phrase and reads its local bars, because that is
 * where authoring happens now; a test about the *grid* — adding, inserting, removing
 * bars, changing a metre — opens none and goes on reading the song, which is still
 * exactly what it authors.
 */
export function editableBars(): Bar[] {
  const state = projectStore.getState();
  const phrase = state.project!.phrases.find(p => p.id === state.editingPhraseId);
  return phrase ? phrase.bars : state.project!.bars;
}

/**
 * The key content is filed under on `editableBars()`.
 *
 * A phrase files its material under `PHRASE_TRACK_KEY` rather than under the instrument
 * playing it, so a test holding a track id has to be told which of the two it is
 * looking at.
 */
export function editKey(trackId: string): string {
  return projectStore.getState().editingPhraseId ? PHRASE_TRACK_KEY : trackId;
}

/**
 * Add a bar to whatever surface is being edited.
 *
 * `addBar` lengthens the *song*, which is no longer the same thing as lengthening what
 * the timeline is showing: with a phrase open, the editable bars are the phrase's, and
 * a test that wants somewhere else to put a block wants the phrase to grow.
 */
export function addEditableBar(): void {
  const state = projectStore.getState();
  const phrase = state.project!.phrases.find(p => p.id === state.editingPhraseId);
  if (!phrase) {
    state.addBar();
    return;
  }
  state.setPhraseLength(phrase.id, phrase.bars.length + 1);
}
