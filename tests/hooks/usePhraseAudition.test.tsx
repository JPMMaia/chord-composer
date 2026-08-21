import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { usePhraseAudition } from '@/hooks/usePhraseAudition';
import { projectStore } from '@/store/projectStore';
import { editorStore } from '@/store/editorStore';
import { selectionStore } from '@/store/selectionStore';
import { openTestPhrase } from '../helpers/phrases';

/**
 * What Play means while a phrase is open.
 *
 * There is no second playback engine: a phrase is heard through the song it is
 * compiled into, so an audition is only a narrowing of the one range the scheduler
 * already honours — the placement's beats, repeat forced on, one instrument audible.
 * Every case here is about *which* beats and *which* instrument, because that is all
 * the hook decides.
 */

const state = () => projectStore.getState();
const trackId = () => state().project!.tracks[0].id;
const audition = () => renderHook(() => usePhraseAudition()).result.current;

/** A second instrument, so "only the one the phrase is on" can mean something. */
function secondTrack(): string {
  state().addTrack('Lead');
  return state().project!.tracks[1].id;
}

beforeEach(() => {
  state().resetProject();
  state().createProject();
  selectionStore.getState().clearSelection();
  editorStore.setState({ view: 'arrangement', phraseLoop: null });
  selectionStore.getState().selectTrack(trackId());
});

afterEach(cleanup);

describe('usePhraseAudition', () => {
  it('is nothing in the arrangement, where Play means the whole song', () => {
    openTestPhrase(trackId(), 2);
    state().closePhrase();

    expect(audition()).toBeNull();
  });

  it('covers the open placement, from its first beat to its last', () => {
    openTestPhrase(trackId(), 2);

    expect(audition()).toMatchObject({ baseBeat: 0, spanBeats: 8, loopStart: 0, loopEnd: 8 });
  });

  // A phrase heard at the third chorus is a stretch of song a long way from bar 1.
  it('is measured where the opened placement actually sits', () => {
    const { phraseId } = openTestPhrase(trackId(), 1);
    state().addBar();
    state().addBar();
    const clipId = state().placePhrase(phraseId, trackId(), 2)!;
    state().openClip(clipId);

    expect(audition()).toMatchObject({ baseBeat: 8, loopStart: 8, loopEnd: 12 });
  });

  // `openPhrase` names no block, and an undo can invalidate one that was named. The
  // first placement is the same one whose metre the editor draws the phrase in.
  it('falls back to the first placement when none was named', () => {
    const { phraseId } = openTestPhrase(trackId(), 1);
    state().addBar();
    state().placePhrase(phraseId, trackId(), 1);
    state().closePhrase();
    state().openPhrase(phraseId);

    expect(audition()!.baseBeat).toBe(0);
  });

  it('sounds only the instrument the placement is on', () => {
    const lead = secondTrack();
    openTestPhrase(trackId(), 1);

    expect(audition()!.audibleTrackIds).toEqual([trackId()]);
    expect(audition()!.audibleTrackIds).not.toContain(lead);
  });

  // The user opened this phrase to hear it. Honouring a mute set while working on the
  // arrangement would answer them with silence and no way to tell why.
  it('names the instrument even when it is muted', () => {
    openTestPhrase(trackId(), 1);
    state().toggleTrackMute(trackId());

    expect(audition()!.audibleTrackIds).toEqual([trackId()]);
  });

  describe('the loop drawn on the phrase ruler', () => {
    it('narrows the range to the stretch drawn, in song beats', () => {
      openTestPhrase(trackId(), 2);
      state().addBar();
      const clipId = state().project!.clips[0].id;
      state().moveClip(clipId, trackId(), 1);
      state().openClip(clipId);
      editorStore.getState().setPhraseLoop(2, 4);

      // Bar 1 starts at song beat 4, so the phrase's beats 2-4 are the song's 6-8.
      expect(audition()).toMatchObject({ localStart: 2, localEnd: 4, loopStart: 6, loopEnd: 8 });
    });

    it('is the whole phrase until one is drawn', () => {
      openTestPhrase(trackId(), 2);

      expect(audition()).toMatchObject({ localStart: 0, localEnd: 8 });
    });

    // Otherwise the loop would run off the end of the phrase and repeat whatever the
    // next placement on the row happens to have put there.
    it('is cut back to the phrase when the phrase is shortened under it', () => {
      const { phraseId } = openTestPhrase(trackId(), 4);
      editorStore.getState().setPhraseLoop(8, 16);
      state().setPhraseLength(phraseId, 3);

      expect(audition()).toMatchObject({ localStart: 8, localEnd: 12 });
    });

    // Clamping can leave nothing between the bounds, which would repeat silence for
    // as long as the user let it.
    it('reads as the whole phrase when nothing is left of it', () => {
      const { phraseId } = openTestPhrase(trackId(), 4);
      editorStore.getState().setPhraseLoop(12, 16);
      state().setPhraseLength(phraseId, 2);

      expect(audition()).toMatchObject({ localStart: 0, localEnd: 8 });
    });
  });
});
