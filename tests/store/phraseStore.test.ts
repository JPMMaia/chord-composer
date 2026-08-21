import { describe, it, expect, beforeEach } from 'vitest';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { PHRASE_TRACK_KEY, clipEndBar, phraseById } from '@/engine/phrases';
import { barChords } from '@/engine/timeline';
import type { ChordSegment } from '@/types/music';

/** Bars are added one at a time; every test wants a few. */
function withBars(count: number) {
  const store = projectStore.getState();
  while (projectStore.getState().project!.bars.length < count) store.addBar();
}

function trackIds(): string[] {
  return projectStore.getState().project!.tracks.map(t => t.id);
}

function segment(id: string, startBeat = 0, duration = 1): ChordSegment {
  return { id, startBeat, duration, romanNumeral: 'I', root: 'C', quality: 'major' };
}

/** The open phrase's chords in one of its local bars. */
function phraseChords(phraseId: string, barIndex: number): ChordSegment[] {
  const phrase = phraseById(projectStore.getState().project!.phrases, phraseId)!;
  return barChords(phrase.bars[barIndex], PHRASE_TRACK_KEY);
}

/** The compiled song's chords for one instrument in one song bar. */
function songChords(barIndex: number, trackId: string): ChordSegment[] {
  return barChords(projectStore.getState().project!.bars[barIndex], trackId);
}

beforeEach(() => {
  projectStore.getState().resetProject();
  projectStore.getState().createProject();
  selectionStore.getState().clearSelection();
  withBars(16);
});

describe('placing phrases', () => {
  it('creates a phrase and a placement, and opens nothing by itself', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 4, 2)!;

    const project = projectStore.getState().project!;
    expect(project.phrases).toHaveLength(1);
    expect(project.phrases[0].bars).toHaveLength(2);
    expect(project.clips).toEqual([
      { id: clipId, phraseId: project.phrases[0].id, trackId: track, startBar: 4 },
    ]);
    expect(projectStore.getState().editingPhraseId).toBeNull();
  });

  it('refuses a placement that would overlap one already there', () => {
    const [track] = trackIds();
    projectStore.getState().addPhraseClip(track, 0, 4);
    const before = projectStore.getState().project;

    expect(projectStore.getState().addPhraseClip(track, 2, 4)).toBeNull();
    expect(projectStore.getState().project).toBe(before);
  });

  it('allows the same bars on a different row', () => {
    const [first] = trackIds();
    projectStore.getState().addTrack('Bass');
    const second = trackIds()[1];

    projectStore.getState().addPhraseClip(first, 0, 4);
    expect(projectStore.getState().addPhraseClip(second, 0, 4)).not.toBeNull();
    expect(projectStore.getState().project!.clips).toHaveLength(2);
  });

  it('opening a placement selects the instrument that plays it', () => {
    const [first] = trackIds();
    projectStore.getState().addTrack('Bass');
    const second = trackIds()[1];
    selectionStore.getState().selectTrack(first);

    const clipId = projectStore.getState().addPhraseClip(second, 0, 2)!;
    projectStore.getState().openClip(clipId);

    expect(selectionStore.getState().selectedTrackId).toBe(second);
  });
});

describe('editing through the open phrase', () => {
  it('writes a dropped block into the phrase, and it appears where the clip is', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 4, 2)!;
    projectStore.getState().openClip(clipId);

    const phraseId = projectStore.getState().editingPhraseId!;
    const bar = phraseById(projectStore.getState().project!.phrases, phraseId)!.bars[0];
    projectStore.getState().insertSegment(bar.id, 0, segment('s1'), track);

    expect(phraseChords(phraseId, 0).map(c => c.id)).toEqual(['s1']);
    // …and it is playable, at bar 4, on that instrument.
    expect(songChords(4, track)).toHaveLength(1);
    expect(songChords(0, track)).toHaveLength(0);
    expect(songChords(4, track)[0].romanNumeral).toBe('I');
  });

  it('generates the derived notes the scheduler reads', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 1)!;
    projectStore.getState().openClip(clipId);
    const phraseId = projectStore.getState().editingPhraseId!;
    const bar = phraseById(projectStore.getState().project!.phrases, phraseId)!.bars[0];

    projectStore.getState().insertSegment(bar.id, 0, segment('s1'), track);

    expect(projectStore.getState().project!.bars[0].content[track].notes.length).toBeGreaterThan(0);
  });

  it('does nothing at all when no phrase is open', () => {
    const [track] = trackIds();
    projectStore.getState().addPhraseClip(track, 0, 2);
    const before = projectStore.getState().project!;
    const bar = before.phrases[0].bars[0];

    projectStore.getState().insertSegment(bar.id, 0, segment('s1'), track);
    projectStore.getState().removeSegments(['s1']);
    projectStore.getState().moveSegments([{ segmentId: 's1', absoluteBeat: 4 }]);
    projectStore.getState().resizeSegmentDuration('s1', 2, 1);
    projectStore.getState().stepSegmentsPitch(['s1'], 1);

    expect(projectStore.getState().project).toBe(before);
  });

  it('moves and deletes blocks inside the phrase', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 2)!;
    projectStore.getState().openClip(clipId);
    const phraseId = projectStore.getState().editingPhraseId!;
    const bars = phraseById(projectStore.getState().project!.phrases, phraseId)!.bars;

    projectStore.getState().insertSegment(bars[0].id, 0, segment('s1'), track);
    projectStore.getState().moveSegments([{ segmentId: 's1', absoluteBeat: 4 }]);
    expect(phraseChords(phraseId, 0)).toHaveLength(0);
    expect(phraseChords(phraseId, 1).map(c => c.id)).toEqual(['s1']);

    projectStore.getState().removeSegments(['s1']);
    expect(phraseChords(phraseId, 1)).toHaveLength(0);
  });
});

describe('linked placements', () => {
  it('one edit reaches every placement of the phrase', () => {
    const [track] = trackIds();
    const first = projectStore.getState().addPhraseClip(track, 0, 2)!;
    projectStore.getState().openClip(first);
    const phraseId = projectStore.getState().editingPhraseId!;
    const bar = phraseById(projectStore.getState().project!.phrases, phraseId)!.bars[0];

    projectStore.getState().linkClip(first, track, 8);
    expect(projectStore.getState().project!.clips.map(c => c.phraseId)).toEqual([
      phraseId,
      phraseId,
    ]);

    projectStore.getState().insertSegment(bar.id, 0, segment('s1'), track);

    // Both placements sound it, from the one definition, under different ids.
    expect(songChords(0, track)).toHaveLength(1);
    expect(songChords(8, track)).toHaveLength(1);
    expect(songChords(0, track)[0].id).not.toBe(songChords(8, track)[0].id);
  });

  it('Make Unique decouples one placement and follows it in the editor', () => {
    const [track] = trackIds();
    const first = projectStore.getState().addPhraseClip(track, 0, 2)!;
    projectStore.getState().openClip(first);
    const original = projectStore.getState().editingPhraseId!;
    const bar = phraseById(projectStore.getState().project!.phrases, original)!.bars[0];
    projectStore.getState().insertSegment(bar.id, 0, segment('s1'), track);

    const second = projectStore.getState().linkClip(first, track, 8)!;
    projectStore.getState().openClip(second);
    projectStore.getState().makeClipUnique(second);

    const project = projectStore.getState().project!;
    expect(project.phrases).toHaveLength(2);
    const copyId = project.clips.find(c => c.id === second)!.phraseId;
    expect(copyId).not.toBe(original);
    // The editor followed the block that was split.
    expect(projectStore.getState().editingPhraseId).toBe(copyId);
    // The copy starts life identical, with its own ids.
    expect(phraseChords(copyId, 0)).toHaveLength(1);
    expect(phraseChords(copyId, 0)[0].id).not.toBe('s1');

    // Editing the copy now leaves the original alone.
    const copyBar = phraseById(projectStore.getState().project!.phrases, copyId)!.bars[1];
    projectStore.getState().insertSegment(copyBar.id, 0, segment('s2'), track);
    expect(songChords(9, track)).toHaveLength(1);
    expect(songChords(1, track)).toHaveLength(0);
  });

  it('a linked duplicate adds a placement and no phrase', () => {
    const [track] = trackIds();
    const first = projectStore.getState().addPhraseClip(track, 0, 2)!;

    projectStore.getState().linkClip(first, track, 8);

    expect(projectStore.getState().project!.phrases).toHaveLength(1);
    expect(projectStore.getState().project!.clips).toHaveLength(2);
  });

  it('leaves a phrase with a single placement alone', () => {
    const [track] = trackIds();
    const only = projectStore.getState().addPhraseClip(track, 0, 2)!;
    const before = projectStore.getState().project;

    projectStore.getState().makeClipUnique(only);
    expect(projectStore.getState().project).toBe(before);
  });
});

describe('moving placements', () => {
  it('moves a block to another row, and that instrument plays it', () => {
    const [first] = trackIds();
    projectStore.getState().addTrack('Bass');
    const second = trackIds()[1];

    const clipId = projectStore.getState().addPhraseClip(first, 0, 2)!;
    projectStore.getState().openClip(clipId);
    const phraseId = projectStore.getState().editingPhraseId!;
    const bar = phraseById(projectStore.getState().project!.phrases, phraseId)!.bars[0];
    projectStore.getState().insertSegment(bar.id, 0, segment('s1'), first);

    projectStore.getState().moveClip(clipId, second, 4);

    expect(songChords(0, first)).toHaveLength(0);
    expect(songChords(4, second)).toHaveLength(1);
    expect(projectStore.getState().project!.clips[0]).toMatchObject({
      trackId: second,
      startBar: 4,
    });
  });

  it('refuses a move onto an occupied span and changes nothing', () => {
    const [track] = trackIds();
    const a = projectStore.getState().addPhraseClip(track, 0, 4)!;
    projectStore.getState().addPhraseClip(track, 8, 4);
    const before = projectStore.getState().project;

    projectStore.getState().moveClip(a, track, 6);
    expect(projectStore.getState().project).toBe(before);
  });

  it('lets a block be nudged without its own old place refusing it', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 4, 4)!;

    projectStore.getState().moveClip(clipId, track, 5);
    expect(projectStore.getState().project!.clips[0].startBar).toBe(5);
  });
});

describe('the library', () => {
  it('keeps the phrase when its last placement goes', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 2)!;
    projectStore.getState().removeClip(clipId);

    const project = projectStore.getState().project!;
    expect(project.clips).toHaveLength(0);
    expect(project.phrases).toHaveLength(1);
  });

  it('places a library phrase again', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 2)!;
    const phraseId = projectStore.getState().project!.phrases[0].id;
    projectStore.getState().removeClip(clipId);

    expect(projectStore.getState().placePhrase(phraseId, track, 6)).not.toBeNull();
    expect(songChords(6, track)).toBeDefined();
    expect(projectStore.getState().project!.clips[0].startBar).toBe(6);
  });

  it('removePhrase takes its placements with it and closes the editor', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 2)!;
    projectStore.getState().openClip(clipId);
    const phraseId = projectStore.getState().editingPhraseId!;

    projectStore.getState().removePhrase(phraseId);

    expect(projectStore.getState().project!.phrases).toHaveLength(0);
    expect(projectStore.getState().project!.clips).toHaveLength(0);
    expect(projectStore.getState().editingPhraseId).toBeNull();
  });
});

describe('independent duplicates', () => {
  it('gives the copy music of its own, so editing it leaves the original alone', () => {
    const [track] = trackIds();
    const first = projectStore.getState().addPhraseClip(track, 0, 2)!;
    projectStore.getState().openClip(first);
    const original = projectStore.getState().editingPhraseId!;
    const bar = phraseById(projectStore.getState().project!.phrases, original)!.bars[0];
    projectStore.getState().insertSegment(bar.id, 0, segment('s1'), track);

    const copyId = projectStore.getState().duplicateClip(first, track, 8)!;

    const project = projectStore.getState().project!;
    expect(project.phrases).toHaveLength(2);
    const copyPhrase = project.clips.find(c => c.id === copyId)!.phraseId;
    expect(copyPhrase).not.toBe(original);
    // It starts life identical, under ids of its own.
    expect(phraseChords(copyPhrase, 0)).toHaveLength(1);
    expect(phraseChords(copyPhrase, 0)[0].id).not.toBe('s1');
    expect(songChords(8, track)).toHaveLength(1);

    projectStore.getState().openClip(copyId);
    const copyBar = phraseById(projectStore.getState().project!.phrases, copyPhrase)!.bars[1];
    projectStore.getState().insertSegment(copyBar.id, 0, segment('s2'), track);

    expect(songChords(9, track)).toHaveLength(1);
    expect(songChords(1, track)).toHaveLength(0);
  });

  it('names the copy after the phrase it came from', () => {
    const [track] = trackIds();
    const first = projectStore.getState().addPhraseClip(track, 0, 2)!;
    const original = projectStore.getState().project!.phrases[0].id;
    projectStore.getState().renamePhrase(original, 'Verse');

    projectStore.getState().duplicateClip(first, track, 8);

    expect(projectStore.getState().project!.phrases.map(p => p.name)).toEqual([
      'Verse',
      'Verse 2',
    ]);
  });

  // A refused duplicate that had already cloned the phrase would leave an identical
  // orphan behind in the library for nothing.
  it('refuses an occupied span and leaves no phrase behind', () => {
    const [track] = trackIds();
    const first = projectStore.getState().addPhraseClip(track, 0, 2)!;
    projectStore.getState().addPhraseClip(track, 8, 2);
    const before = projectStore.getState().project!;

    expect(projectStore.getState().duplicateClip(first, track, 8)).toBeNull();
    expect(projectStore.getState().project).toBe(before);
    expect(projectStore.getState().project!.phrases).toHaveLength(2);
  });

  it('refuses a clip or a track it does not know', () => {
    const [track] = trackIds();
    const first = projectStore.getState().addPhraseClip(track, 0, 2)!;

    expect(projectStore.getState().duplicateClip('nope', track, 8)).toBeNull();
    expect(projectStore.getState().duplicateClip(first, 'nope', 8)).toBeNull();
    expect(projectStore.getState().project!.phrases).toHaveLength(1);
  });
});

describe('phrase length', () => {
  it('grows every placement at once', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 2)!;
    const phraseId = projectStore.getState().project!.phrases[0].id;
    projectStore.getState().linkClip(clipId, track, 8);

    projectStore.getState().setPhraseLength(phraseId, 4);

    expect(projectStore.getState().project!.phrases[0].bars).toHaveLength(4);
    expect(projectStore.getState().project!.clips.map(c => c.startBar)).toEqual([0, 8]);
  });

  it('pushes a placement along rather than refusing the growth', () => {
    const [track] = trackIds();
    projectStore.getState().addPhraseClip(track, 0, 2)!;
    const grown = projectStore.getState().project!.phrases[0].id;
    projectStore.getState().addPhraseClip(track, 2, 2);

    projectStore.getState().setPhraseLength(grown, 4);

    const clips = projectStore.getState().project!.clips;
    expect(clips.find(c => c.phraseId === grown)!.startBar).toBe(0);
    expect(clips.find(c => c.phraseId !== grown)!.startBar).toBe(4);
  });

  it('shrinking discards the trailing bars', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 2)!;
    projectStore.getState().openClip(clipId);
    const phraseId = projectStore.getState().editingPhraseId!;
    const bars = phraseById(projectStore.getState().project!.phrases, phraseId)!.bars;
    projectStore.getState().insertSegment(bars[1].id, 0, segment('s1'), track);

    projectStore.getState().setPhraseLength(phraseId, 1);

    expect(projectStore.getState().project!.phrases[0].bars).toHaveLength(1);
    expect(songChords(1, track)).toHaveLength(0);
  });

  it('removes one bar from the middle, and the song recompiles behind it', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 3)!;
    projectStore.getState().openClip(clipId);
    const phraseId = projectStore.getState().editingPhraseId!;
    const bars = phraseById(projectStore.getState().project!.phrases, phraseId)!.bars;
    projectStore.getState().insertSegment(bars[2].id, 0, segment('last'), track);

    projectStore.getState().removePhraseBarAt(phraseId, bars[1].id);

    const phrase = phraseById(projectStore.getState().project!.phrases, phraseId)!;
    expect(phrase.bars).toHaveLength(2);
    expect(phrase.bars.map(b => b.id)).toEqual([bars[0].id, bars[2].id]);
    // The block that was in bar 3 of the phrase now sounds in song bar 2.
    expect(songChords(1, track)).toHaveLength(1);
    expect(songChords(2, track)).toHaveLength(0);
  });

  it('closes the curves up behind a removed bar, at every placement', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 3)!;
    const phraseId = projectStore.getState().project!.phrases[0].id;
    projectStore.getState().addVolumePoint(phraseId, 0, 0.2);
    projectStore.getState().addVolumePoint(phraseId, 8, 1);
    projectStore.getState().placePhrase(phraseId, track, 8);
    const bars = phraseById(projectStore.getState().project!.phrases, phraseId)!.bars;

    projectStore.getState().removePhraseBarAt(phraseId, bars[1].id);

    const project = projectStore.getState().project!;
    expect(phraseById(project.phrases, phraseId)!.volumeAutomation).toEqual([
      { beat: 0, value: 0.2 },
      { beat: 4, value: 1 },
    ]);
    const beats = project.tracks.find(t => t.id === track)!.volumeAutomation!.map(p => p.beat);
    expect(beats).toContain(4);
    expect(beats).toContain(36);
    expect(clipId).toBeTruthy();
  });

  it('will not take the last bar, nor a bar the phrase does not have', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 1)!;
    const phraseId = projectStore.getState().project!.phrases[0].id;
    const only = phraseById(projectStore.getState().project!.phrases, phraseId)!.bars[0];

    projectStore.getState().removePhraseBarAt(phraseId, only.id);
    projectStore.getState().removePhraseBarAt(phraseId, 'nope');

    expect(phraseById(projectStore.getState().project!.phrases, phraseId)!.bars).toHaveLength(1);
    expect(projectStore.getState().project!.clips.map(c => c.id)).toEqual([clipId]);
  });
});

describe('insertPhraseBarsAt', () => {
  it('makes room in the middle, and the song recompiles in front of it', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 2)!;
    projectStore.getState().openClip(clipId);
    const phraseId = projectStore.getState().editingPhraseId!;
    const bars = phraseById(projectStore.getState().project!.phrases, phraseId)!.bars;
    projectStore.getState().insertSegment(bars[1].id, 0, segment('second'), track);

    projectStore.getState().insertPhraseBarsAt(phraseId, 1, 1);

    const phrase = phraseById(projectStore.getState().project!.phrases, phraseId)!;
    expect(phrase.bars).toHaveLength(3);
    expect(phrase.bars.map(b => b.id)).toEqual([bars[0].id, phrase.bars[1].id, bars[1].id]);
    expect(phraseChords(phraseId, 1)).toHaveLength(0);
    // The block that sounded in song bar 2 now sounds in song bar 3.
    expect(songChords(1, track)).toHaveLength(0);
    expect(songChords(2, track)).toHaveLength(1);
  });

  it('grows every placement of the phrase at once', () => {
    const [track] = trackIds();
    projectStore.getState().addPhraseClip(track, 0, 2)!;
    const phraseId = projectStore.getState().project!.phrases[0].id;
    projectStore.getState().placePhrase(phraseId, track, 8);

    projectStore.getState().insertPhraseBarsAt(phraseId, 1, 2);

    const project = projectStore.getState().project!;
    expect(project.phrases[0].bars).toHaveLength(4);
    expect(project.clips.map(c => clipEndBar(c, project.phrases))).toEqual([4, 12]);
  });

  // A resize names only a length, and there is a way to honour it: the neighbour moves.
  it('pushes a placement the growth runs into along, rather than refusing', () => {
    const [track] = trackIds();
    projectStore.getState().addPhraseClip(track, 0, 2)!;
    const grown = projectStore.getState().project!.phrases[0].id;
    projectStore.getState().addPhraseClip(track, 2, 2);

    projectStore.getState().insertPhraseBarsAt(grown, 1, 2);

    const clips = projectStore.getState().project!.clips;
    expect(clips.find(c => c.phraseId === grown)!.startBar).toBe(0);
    expect(clips.find(c => c.phraseId !== grown)!.startBar).toBe(4);
  });

  it('carries the phrase curves forward, and every placement of them with it', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 2)!;
    const phraseId = projectStore.getState().project!.phrases[0].id;
    projectStore.getState().addVolumePoint(phraseId, 0, 0.2);
    projectStore.getState().addVolumePoint(phraseId, 4, 1);
    projectStore.getState().placePhrase(phraseId, track, 8);

    projectStore.getState().insertPhraseBarsAt(phraseId, 1, 1);

    const project = projectStore.getState().project!;
    expect(phraseById(project.phrases, phraseId)!.volumeAutomation).toEqual([
      { beat: 0, value: 0.2 },
      { beat: 8, value: 1 },
    ]);
    // The compiled curve on the instrument follows, at both placements.
    const beats = project.tracks.find(t => t.id === track)!.volumeAutomation!.map(p => p.beat);
    expect(beats).toContain(8);
    expect(beats).toContain(40);
    expect(clipId).toBeTruthy();
  });

  it('does nothing for an unknown phrase, or for nothing to insert', () => {
    const [track] = trackIds();
    projectStore.getState().addPhraseClip(track, 0, 2);
    const phraseId = projectStore.getState().project!.phrases[0].id;
    const before = projectStore.getState().project;

    projectStore.getState().insertPhraseBarsAt('nope', 1, 1);
    projectStore.getState().insertPhraseBarsAt(phraseId, 1, 0);
    projectStore.getState().insertPhraseBarsAt(phraseId, 1, Number.NaN);

    expect(projectStore.getState().project).toBe(before);
  });
});

describe('removePhraseBarsAt', () => {
  it('takes a run of bars out, and the song recompiles behind it', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 4)!;
    projectStore.getState().openClip(clipId);
    const phraseId = projectStore.getState().editingPhraseId!;
    const bars = phraseById(projectStore.getState().project!.phrases, phraseId)!.bars;
    projectStore.getState().insertSegment(bars[3].id, 0, segment('last'), track);

    projectStore.getState().removePhraseBarsAt(phraseId, 1, 2);

    const phrase = phraseById(projectStore.getState().project!.phrases, phraseId)!;
    expect(phrase.bars.map(b => b.id)).toEqual([bars[0].id, bars[3].id]);
    // The block that sounded in song bar 4 now sounds in song bar 2.
    expect(songChords(3, track)).toHaveLength(0);
    expect(songChords(1, track)).toHaveLength(1);
  });

  it('shortens every placement at once', () => {
    const [track] = trackIds();
    projectStore.getState().addPhraseClip(track, 0, 4)!;
    const phraseId = projectStore.getState().project!.phrases[0].id;
    projectStore.getState().placePhrase(phraseId, track, 8);

    projectStore.getState().removePhraseBarsAt(phraseId, 0, 2);

    const project = projectStore.getState().project!;
    expect(project.clips.map(c => clipEndBar(c, project.phrases))).toEqual([2, 10]);
  });

  it('refuses a run that would leave the phrase with no bars', () => {
    const [track] = trackIds();
    projectStore.getState().addPhraseClip(track, 0, 2);
    const phraseId = projectStore.getState().project!.phrases[0].id;
    const before = projectStore.getState().project;

    projectStore.getState().removePhraseBarsAt(phraseId, 0, 2);
    projectStore.getState().removePhraseBarsAt('nope', 0, 1);
    projectStore.getState().removePhraseBarsAt(phraseId, 0, Number.NaN);

    expect(projectStore.getState().project).toBe(before);
  });
});

describe('the bar grid ripples the placements', () => {
  it('inserting bars shifts everything from there on', () => {
    const [track] = trackIds();
    projectStore.getState().addPhraseClip(track, 0, 2);
    projectStore.getState().addPhraseClip(track, 8, 2);

    projectStore.getState().insertBar(4, 2);

    expect(projectStore.getState().project!.clips.map(c => c.startBar)).toEqual([0, 10]);
  });

  it('removing a bar closes the placements up behind it', () => {
    const [track] = trackIds();
    projectStore.getState().addPhraseClip(track, 0, 2);
    projectStore.getState().addPhraseClip(track, 8, 2);
    const barId = projectStore.getState().project!.bars[4].id;

    projectStore.getState().removeBar(barId);

    expect(projectStore.getState().project!.clips.map(c => c.startBar)).toEqual([0, 7]);
  });
});

describe('instruments', () => {
  it('removing an instrument drops its placements but keeps its phrases', () => {
    const [first] = trackIds();
    projectStore.getState().addTrack('Bass');
    const second = trackIds()[1];
    projectStore.getState().addPhraseClip(first, 0, 2);
    projectStore.getState().addPhraseClip(second, 0, 2);

    projectStore.getState().removeTrack(second);

    const project = projectStore.getState().project!;
    expect(project.clips).toHaveLength(1);
    expect(project.clips[0].trackId).toBe(first);
    expect(project.phrases).toHaveLength(2);
  });

  it('duplicating an instrument doubles the part, linked', () => {
    const [track] = trackIds();
    const clipId = projectStore.getState().addPhraseClip(track, 0, 2)!;
    projectStore.getState().openClip(clipId);
    const phraseId = projectStore.getState().editingPhraseId!;
    const bar = phraseById(projectStore.getState().project!.phrases, phraseId)!.bars[0];
    projectStore.getState().insertSegment(bar.id, 0, segment('s1'), track);

    const copyId = projectStore.getState().duplicateTrack(track)!;

    const project = projectStore.getState().project!;
    expect(project.phrases).toHaveLength(1);
    expect(project.clips).toHaveLength(2);
    expect(project.clips.every(c => c.phraseId === phraseId)).toBe(true);
    expect(songChords(0, copyId)).toHaveLength(1);
  });
});
