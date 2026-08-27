import { describe, it, expect } from 'vitest';
import type { AutomationPoint, Bar, ChordSegment, Phrase, PhraseClip, Track } from '@/types/music';
import {
  PHRASE_TRACK_KEY,
  canPlaceClip,
  clipAt,
  clipBeats,
  clipEndBar,
  clipStartBeat,
  clipsOnTrack,
  clonePhrase,
  compileAutomation,
  compileBars,
  compiledSegmentId,
  createPhrase,
  insertPhraseBars,
  nextPhraseName,
  normalizeClips,
  phraseBarsAsTrack,
  phraseBarsForDisplay,
  phraseBarsWithContext,
  phraseLengthBars,
  placementCount,
  removePhraseBar,
  removePhraseBars,
  resizePhrase,
  sourceSegmentId,
  uniquePhraseName,
  unplacedPhrases,
} from '@/engine/phrases';
import { barChords, barNotes } from '@/engine/timeline';
import { laneKey } from '@/engine/parameterAutomation';

const TS = { beatsPerMeasure: 4, beatUnit: 4 };

function track(id: string): Track {
  return { id, name: id, instrument: '', volume: 0.8, pan: 0, muted: false, solo: false };
}

function segment(id: string, startBeat: number, duration = 1): ChordSegment {
  return { id, startBeat, duration, romanNumeral: 'I' };
}

/** A phrase of `lengthBars` bars, with one segment on beat 0 of each bar. */
function phrase(id: string, name: string, lengthBars: number): Phrase {
  const bars: Bar[] = [];
  for (let i = 0; i < lengthBars; i++) {
    bars.push({
      id: `${id}-bar-${i}`,
      barIndex: i,
      content: {
        [PHRASE_TRACK_KEY]: {
          chords: [segment(`${id}-seg-${i}`, 0)],
          notes: [{ id: `${id}-note-${i}`, pitch: 60, startBeat: 0, duration: 1, velocity: 100 }],
        },
      },
    });
  }
  return { id, name, bars };
}

function songBars(count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `song-bar-${i}`,
    barIndex: i,
    content: {},
  }));
}

function clip(id: string, phraseId: string, trackId: string, startBar: number): PhraseClip {
  return { id, phraseId, trackId, startBar };
}

describe('phrase geometry', () => {
  it('reports a phrase length in bars', () => {
    expect(phraseLengthBars(phrase('p', 'Verse', 4))).toBe(4);
  });

  it('ends a clip exclusive of the bar after its last', () => {
    const phrases = [phrase('p', 'Verse', 4)];
    expect(clipEndBar(clip('c', 'p', 't', 8), phrases)).toBe(12);
  });

  it('treats a dangling clip as covering nothing', () => {
    expect(clipEndBar(clip('c', 'gone', 't', 8), [])).toBe(8);
  });

  it('finds the clip covering a bar, and none in a gap', () => {
    const phrases = [phrase('p', 'Verse', 4)];
    const clips = [clip('c', 'p', 't', 4)];
    expect(clipAt(clips, phrases, 't', 4)?.id).toBe('c');
    expect(clipAt(clips, phrases, 't', 7)?.id).toBe('c');
    // Half-open: the bar it stops at the door of belongs to nobody.
    expect(clipAt(clips, phrases, 't', 8)).toBeNull();
    expect(clipAt(clips, phrases, 't', 3)).toBeNull();
    expect(clipAt(clips, phrases, 'other', 4)).toBeNull();
  });

  it('lists clips per row and counts placements', () => {
    const clips = [clip('a', 'p', 't1', 0), clip('b', 'p', 't2', 0), clip('c', 'q', 't1', 4)];
    expect(clipsOnTrack(clips, 't1').map(c => c.id)).toEqual(['a', 'c']);
    expect(placementCount(clips, 'p')).toBe(2);
    expect(placementCount(clips, 'nobody')).toBe(0);
  });
});

describe('canPlaceClip', () => {
  const phrases = [phrase('p', 'Verse', 4), phrase('q', 'Chorus', 2)];
  const clips = [clip('c', 'p', 't', 4)];

  it('allows a gap and refuses an overlap', () => {
    expect(canPlaceClip(clips, phrases, { phraseId: 'q', trackId: 't', startBar: 0 })).toBe(true);
    expect(canPlaceClip(clips, phrases, { phraseId: 'q', trackId: 't', startBar: 3 })).toBe(false);
  });

  it('allows abutting placements on both sides', () => {
    // ends exactly at 4, where the existing clip opens
    expect(canPlaceClip(clips, phrases, { phraseId: 'q', trackId: 't', startBar: 2 })).toBe(true);
    // opens exactly at 8, where the existing clip stops
    expect(canPlaceClip(clips, phrases, { phraseId: 'q', trackId: 't', startBar: 8 })).toBe(true);
  });

  it('ignores the clip being moved, so a nudge is not refused by its own old place', () => {
    expect(canPlaceClip(clips, phrases, { id: 'c', phraseId: 'p', trackId: 't', startBar: 5 })).toBe(true);
  });

  it('does not see other rows', () => {
    expect(canPlaceClip(clips, phrases, { phraseId: 'p', trackId: 'other', startBar: 4 })).toBe(true);
  });

  it('refuses an unknown phrase and a nonsense bar', () => {
    expect(canPlaceClip(clips, phrases, { phraseId: 'gone', trackId: 't', startBar: 0 })).toBe(false);
    expect(canPlaceClip(clips, phrases, { phraseId: 'p', trackId: 't', startBar: -1 })).toBe(false);
    expect(canPlaceClip(clips, phrases, { phraseId: 'p', trackId: 't', startBar: 1.5 })).toBe(false);
  });
});

describe('normalizeClips', () => {
  const phrases = [phrase('p', 'Verse', 4), phrase('q', 'Chorus', 2)];
  const tracks = [track('t1'), track('t2')];

  it('drops a clip whose phrase or track has gone', () => {
    const clips = [clip('a', 'p', 't1', 0), clip('b', 'gone', 't1', 8), clip('c', 'p', 'gone', 8)];
    expect(normalizeClips(clips, phrases, tracks).map(c => c.id)).toEqual(['a']);
  });

  it('drops malformed entries rather than repairing them', () => {
    const clips = [
      clip('a', 'p', 't1', 0),
      { id: '', phraseId: 'p', trackId: 't1', startBar: 8 },
      { id: 'b', phraseId: 'p', trackId: 't1', startBar: -2 },
      { id: 'c', phraseId: 'p', trackId: 't1', startBar: 1.5 },
    ] as PhraseClip[];
    expect(normalizeClips(clips, phrases, tracks).map(c => c.id)).toEqual(['a']);
  });

  it('keeps the earlier of two overlapping clips', () => {
    const clips = [clip('a', 'p', 't1', 0), clip('b', 'q', 't1', 2)];
    expect(normalizeClips(clips, phrases, tracks).map(c => c.id)).toEqual(['a']);
  });

  it('keeps overlaps that are on different rows', () => {
    const clips = [clip('a', 'p', 't1', 0), clip('b', 'q', 't2', 2)];
    expect(normalizeClips(clips, phrases, tracks).map(c => c.id).sort()).toEqual(['a', 'b']);
  });

  it('sorts by row then start', () => {
    const clips = [clip('c', 'q', 't2', 8), clip('a', 'p', 't1', 4), clip('b', 'q', 't1', 0)];
    expect(normalizeClips(clips, phrases, tracks).map(c => c.id)).toEqual(['b', 'a', 'c']);
  });

  it('keeps abutting clips', () => {
    const clips = [clip('a', 'q', 't1', 0), clip('b', 'q', 't1', 2)];
    expect(normalizeClips(clips, phrases, tracks).map(c => c.id)).toEqual(['a', 'b']);
  });

  it('survives a non-array', () => {
    expect(normalizeClips(undefined as unknown as PhraseClip[], phrases, tracks)).toEqual([]);
  });
});

describe('compileBars', () => {
  const phrases = [phrase('p', 'Verse', 2)];

  it('writes a phrase into the song bars its clip names', () => {
    const bars = compileBars(songBars(8), phrases, [clip('c', 'p', 't1', 4)]);

    expect(barChords(bars[0], 't1')).toEqual([]);
    expect(barChords(bars[3], 't1')).toEqual([]);
    expect(barChords(bars[4], 't1').map(s => s.id)).toEqual([compiledSegmentId('c', 'p-seg-0')]);
    expect(barChords(bars[5], 't1').map(s => s.id)).toEqual([compiledSegmentId('c', 'p-seg-1')]);
    expect(barChords(bars[6], 't1')).toEqual([]);
  });

  it('gives two placements of one phrase distinct ids', () => {
    const bars = compileBars(songBars(8), phrases, [
      clip('c1', 'p', 't1', 0),
      clip('c2', 'p', 't1', 4),
    ]);

    const first = barChords(bars[0], 't1')[0].id;
    const second = barChords(bars[4], 't1')[0].id;
    expect(first).not.toBe(second);
    // …but both lead back to the one segment that authored them.
    expect(sourceSegmentId(first)).toBe('p-seg-0');
    expect(sourceSegmentId(second)).toBe('p-seg-0');
  });

  it('files a clip under the instrument that plays it', () => {
    const bars = compileBars(songBars(4), phrases, [clip('c', 'p', 't2', 0)]);
    expect(barChords(bars[0], 't1')).toEqual([]);
    expect(barChords(bars[0], 't2')).toHaveLength(1);
  });

  it('carries the notes across too, since playback reads only those', () => {
    const bars = compileBars(songBars(4), phrases, [clip('c', 'p', 't1', 0)]);
    expect(bars[0].content['t1'].notes.map(n => n.pitch)).toEqual([60]);
  });

  it('extends the grid for a clip running past the end', () => {
    const bars = compileBars(songBars(2), phrases, [clip('c', 'p', 't1', 3)]);
    expect(bars).toHaveLength(5);
    expect(bars.map(b => b.barIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(barChords(bars[3], 't1')).toHaveLength(1);
  });

  it('inherits the metre of the last bar when it grows', () => {
    const bars = songBars(2);
    bars[1] = { ...bars[1], timeSignature: { beatsPerMeasure: 3, beatUnit: 4 } };
    const compiled = compileBars(bars, phrases, [clip('c', 'p', 't1', 2)]);
    expect(compiled[2].timeSignature).toEqual({ beatsPerMeasure: 3, beatUnit: 4 });
  });

  it('leaves the authored grid alone and rebuilds content from nothing', () => {
    const bars = songBars(4);
    bars[1] = { ...bars[1], timeSignature: { beatsPerMeasure: 3, beatUnit: 4 } };
    // Stale content from a previous compile must not survive.
    bars[2] = { ...bars[2], content: { t1: { chords: [segment('stale', 0)], notes: [] } } };

    const compiled = compileBars(bars, phrases, [clip('c', 'p', 't1', 0)]);
    expect(compiled[1].timeSignature).toEqual({ beatsPerMeasure: 3, beatUnit: 4 });
    expect(compiled.map(b => b.id)).toEqual(bars.map(b => b.id));
    expect(barChords(compiled[2], 't1')).toEqual([]);
  });

  it('produces empty content for no clips at all', () => {
    const compiled = compileBars(songBars(3), phrases, []);
    expect(compiled.every(b => Object.keys(b.content).length === 0)).toBe(true);
  });
});

describe('clonePhrase', () => {
  it('shares no id with its source, down to the segments', () => {
    const source = phrase('p', 'Verse', 2);
    const copy = clonePhrase(source, 'Verse 2');

    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe('Verse 2');
    expect(copy.bars).toHaveLength(2);

    const sourceIds = new Set([
      source.id,
      ...source.bars.map(b => b.id),
      ...source.bars.flatMap(b => b.content[PHRASE_TRACK_KEY].chords.map(c => c.id)),
      ...source.bars.flatMap(b => b.content[PHRASE_TRACK_KEY].notes.map(n => n.id)),
    ]);
    const copyIds = [
      copy.id,
      ...copy.bars.map(b => b.id),
      ...copy.bars.flatMap(b => b.content[PHRASE_TRACK_KEY].chords.map(c => c.id)),
      ...copy.bars.flatMap(b => b.content[PHRASE_TRACK_KEY].notes.map(n => n.id)),
    ];
    expect(copyIds.some(id => sourceIds.has(id))).toBe(false);
  });

  it('keeps the music itself, only the identities change', () => {
    const source = phrase('p', 'Verse', 1);
    const copy = clonePhrase(source, 'Verse 2');
    expect(copy.bars[0].content[PHRASE_TRACK_KEY].chords[0].romanNumeral).toBe('I');
  });
});

describe('createPhrase and resizePhrase', () => {
  it('creates the requested number of empty bars, never fewer than one', () => {
    expect(createPhrase('Verse', 4).bars).toHaveLength(4);
    expect(createPhrase('Verse', 0).bars).toHaveLength(1);
  });

  it('grows by appending empty bars and renumbers', () => {
    const grown = resizePhrase(phrase('p', 'Verse', 2), 4);
    expect(grown.bars).toHaveLength(4);
    expect(grown.bars.map(b => b.barIndex)).toEqual([0, 1, 2, 3]);
    expect(grown.bars[3].content).toEqual({});
  });

  it('shrinks by discarding the trailing bars', () => {
    const shrunk = resizePhrase(phrase('p', 'Verse', 4), 2);
    expect(shrunk.bars).toHaveLength(2);
    expect(shrunk.bars[0].content[PHRASE_TRACK_KEY].chords[0].id).toBe('p-seg-0');
  });

  it('hands back the same phrase when the length is unchanged', () => {
    const source = phrase('p', 'Verse', 3);
    expect(resizePhrase(source, 3)).toBe(source);
  });
});

describe('naming', () => {
  it('skips names already taken', () => {
    expect(nextPhraseName([])).toBe('Phrase 1');
    expect(nextPhraseName([phrase('a', 'Phrase 1', 1), phrase('b', 'Phrase 3', 1)])).toBe('Phrase 2');
  });

  it('suffixes a unique copy so the family sorts together', () => {
    const phrases = [phrase('a', 'Verse', 1)];
    expect(uniquePhraseName(phrases, 'Verse')).toBe('Verse 2');
    expect(uniquePhraseName([...phrases, phrase('b', 'Verse 2', 1)], 'Verse')).toBe('Verse 3');
    expect(uniquePhraseName(phrases, 'Chorus')).toBe('Chorus');
  });
});

describe('the library', () => {
  it('lists only phrases nothing plays', () => {
    const phrases = [phrase('p', 'Verse', 1), phrase('q', 'Chorus', 1)];
    expect(unplacedPhrases(phrases, [clip('c', 'p', 't', 0)]).map(p => p.id)).toEqual(['q']);
    expect(unplacedPhrases(phrases, []).map(p => p.id)).toEqual(['p', 'q']);
  });
});

describe('drawing against the beat axis', () => {
  it('accumulates bar lengths rather than multiplying, so a metre change lands right', () => {
    const bars = songBars(4);
    bars[1] = { ...bars[1], timeSignature: { beatsPerMeasure: 3, beatUnit: 4 } };
    expect(clipStartBeat(clip('c', 'p', 't', 3), bars, TS)).toBe(4 + 3 + 4);
  });

  it('measures a clip across the bars it actually covers', () => {
    const phrases = [phrase('p', 'Verse', 2)];
    const bars = songBars(4);
    bars[1] = { ...bars[1], timeSignature: { beatsPerMeasure: 3, beatUnit: 4 } };
    expect(clipBeats(clip('c', 'p', 't', 0), phrases, bars, TS)).toBe(7);
  });
});

describe('phraseBarsForDisplay', () => {
  const p = phrase('p', 'Verse', 2);

  it('borrows the metre of the song bars its first placement covers', () => {
    const bars = songBars(4);
    bars[2] = { ...bars[2], timeSignature: { beatsPerMeasure: 3, beatUnit: 4 } };
    const shown = phraseBarsForDisplay(p, {
      bars,
      clips: [clip('c', 'p', 't', 2)],
      timeSignature: TS,
    });
    expect(shown[0].timeSignature).toEqual({ beatsPerMeasure: 3, beatUnit: 4 });
    expect(shown[1].timeSignature).toBeUndefined();
  });

  it('leaves an unplaced phrase on the project metre', () => {
    const shown = phraseBarsForDisplay(p, { bars: songBars(4), clips: [], timeSignature: TS });
    expect(shown).toBe(p.bars);
  });

  // Which placement matters as soon as there are two: the editor is looking at one of
  // them, and the audition is playing that same one.
  it('borrows the metre of the placement it is given, not the first one', () => {
    const bars = songBars(6);
    bars[4] = { ...bars[4], timeSignature: { beatsPerMeasure: 5, beatUnit: 4 } };
    const second = clip('c2', 'p', 't', 4);
    const shown = phraseBarsForDisplay(
      p,
      { bars, clips: [clip('c1', 'p', 't', 0), second], timeSignature: TS },
      second
    );

    expect(shown[0].timeSignature).toEqual({ beatsPerMeasure: 5, beatUnit: 4 });
  });
});

/**
 * The phrase editor's surface with the rest of the band laid alongside it.
 *
 * Every case here is about the *union*: what comes across from the song, what stays
 * the phrase's own, and what happens where there is no song to borrow from.
 */
describe('phraseBarsWithContext', () => {
  const edited = phrase('p', 'Verse', 2);
  const other = phrase('q', 'Pad', 2);

  /** The song `edited` sits on row `t` of, with `other` playing on row `u` alongside. */
  function song(editedStart = 0, otherStart = 0) {
    const clips = [
      clip('c-edited', 'p', 't', editedStart),
      clip('c-other', 'q', 'u', otherStart),
    ];
    return {
      bars: compileBars(songBars(6), [edited, other], clips),
      clips,
      timeSignature: TS,
    };
  }

  it('lays the other instruments of the arrangement beside the phrase', () => {
    const project = song();
    const shown = phraseBarsWithContext(edited, project, 't', project.clips[0]);

    expect(Object.keys(shown[0].content).sort()).toEqual(['t', 'u']);
    expect(barNotes(shown[0], 'u').map(n => n.pitch)).toEqual([60]);
  });

  // The block lanes draw one instrument and never the others, so a compiled segment on
  // a context row would be an id nothing on this surface could use.
  it('brings notes across but no blocks', () => {
    const project = song();
    const shown = phraseBarsWithContext(edited, project, 't', project.clips[0]);

    expect(barChords(shown[0], 'u')).toEqual([]);
    expect(barNotes(shown[0], 'u')).toHaveLength(1);
  });

  /**
   * A note is filed in the bar it *starts* in and may sound long past it — a ten-bar
   * drone is one held note in bar 0. A placement starting later shares those beats and
   * has to be able to see it, or it is written against silence it can plainly hear.
   */
  describe('a held note that began before this placement', () => {
    /** One instrument holding a single note across `beats`, from song bar 0. */
    function droneSong(beats: number) {
      const drone: Phrase = {
        id: 'd',
        name: 'Drone',
        bars: [
          {
            id: 'd-bar-0',
            barIndex: 0,
            content: {
              [PHRASE_TRACK_KEY]: {
                chords: [segment('d-seg', 0, beats)],
                notes: [{ id: 'd-note', pitch: 50, startBeat: 0, duration: beats, velocity: 100 }],
              },
            },
          },
          ...phrase('dd', 'pad', 3).bars.map((b, i) => ({ ...b, id: `d-bar-${i + 1}`, barIndex: i + 1, content: {} })),
        ],
      };
      const clips = [clip('c-drone', 'd', 'u', 0), clip('c-edited', 'p', 't', 2)];
      return {
        drone,
        project: {
          bars: compileBars(songBars(8), [drone, edited], clips),
          clips,
          timeSignature: TS,
        },
      };
    }

    it('reaches a phrase that starts after it', () => {
      const { project } = droneSong(16);
      const shown = phraseBarsWithContext(edited, project, 't', project.clips[1]);

      expect(barNotes(shown[0], 'u').map(n => n.pitch)).toEqual([50]);
    });

    // It genuinely started earlier, so it is placed earlier — the roll clips at the
    // keyboard and draws the stretch that actually sounds here.
    it('is re-based to where it began, before the phrase', () => {
      const { project } = droneSong(16);
      const shown = phraseBarsWithContext(edited, project, 't', project.clips[1]);

      expect(barNotes(shown[0], 'u')[0].startBeat).toBe(-8);
    });

    it('is left out once it has stopped sounding by the time the phrase starts', () => {
      // Four beats from bar 0 ends at song beat 4; the phrase starts at beat 8.
      const { project } = droneSong(4);
      const shown = phraseBarsWithContext(edited, project, 't', project.clips[1]);

      expect(shown.every(b => b.content['u'] === undefined)).toBe(true);
    });
  });

  // The song's copy of this phrase carries `clipId::segmentId` ids, and the segment
  // actions only accept the phrase's own. Drawing the compiled copy would give the
  // user blocks that refused to be dragged.
  it('keeps the edited row authored, not the compiled copy the song holds', () => {
    const project = song();
    const shown = phraseBarsWithContext(edited, project, 't', project.clips[0]);

    expect(barChords(shown[0], 't').map(c => c.id)).toEqual(['p-seg-0']);
  });

  it('borrows only the bars this placement actually covers', () => {
    // `other` plays at bar 0, `edited` at bar 2 — they never sound together.
    const project = song(2, 0);
    const shown = phraseBarsWithContext(edited, project, 't', project.clips[0]);

    expect(Object.keys(shown[0].content)).toEqual(['t']);
    expect(Object.keys(shown[1].content)).toEqual(['t']);
  });

  // The bar cursor, Add Bar and Remove Bar all address phrase bars by their own ids.
  it('leaves the bars of the phrase carrying their own identity', () => {
    const project = song();
    const shown = phraseBarsWithContext(edited, project, 't', project.clips[0]);

    expect(shown.map(b => b.id)).toEqual(['p-bar-0', 'p-bar-1']);
    expect(shown.map(b => b.barIndex)).toEqual([0, 1]);
  });

  // The caller pairs a track id with a clip, and the two can disagree — the phrase
  // editor files the phrase under the panel's selected instrument, which drifts. Only
  // excluding the id it was filed under would then draw this phrase twice, once
  // authored and once compiled, and hide the row that actually disagreed.
  it('never draws the compiled copy of the phrase being edited', () => {
    const project = song();
    // Filed under the *strings* row, though the clip is played by the piano.
    const shown = phraseBarsWithContext(edited, project, 'u', project.clips[0]);

    expect(barChords(shown[0], 'u').map(c => c.id)).toEqual(['p-seg-0']);
    expect(shown[0].content['t']).toBeUndefined();
  });

  it('has nothing to borrow for a phrase that sits nowhere in the song', () => {
    const project = { bars: songBars(4), clips: [], timeSignature: TS };

    expect(phraseBarsWithContext(edited, project, 't', null)).toEqual(
      phraseBarsAsTrack(edited, project, 't')
    );
  });

  // A phrase played in two choruses sits next to different music in each.
  it('takes its context from the placement it is given', () => {
    const clips = [
      clip('c-first', 'p', 't', 0),
      clip('c-second', 'p', 't', 2),
      clip('c-other', 'q', 'u', 2),
    ];
    const project = { bars: compileBars(songBars(6), [edited, other], clips), clips, timeSignature: TS };

    expect(Object.keys(phraseBarsWithContext(edited, project, 't', clips[0])[0].content)).toEqual([
      't',
    ]);
    expect(
      Object.keys(phraseBarsWithContext(edited, project, 't', clips[1])[0].content).sort()
    ).toEqual(['t', 'u']);
  });
});

describe('removePhraseBar', () => {
  it('takes a bar out of the middle and closes the rest up behind it', () => {
    const shortened = removePhraseBar(phrase('p', 'Verse', 3), 'p-bar-1', TS);

    expect(shortened.bars).toHaveLength(2);
    expect(shortened.bars.map(b => b.id)).toEqual(['p-bar-0', 'p-bar-2']);
    expect(shortened.bars.map(b => b.barIndex)).toEqual([0, 1]);
  });

  // Zero bars would make every placement of it zero-length, and `validClips` drops
  // those — emptying one bar would take the whole arrangement with it.
  it('keeps the last bar, and ignores a bar it does not have', () => {
    const single = phrase('p', 'Verse', 1);
    expect(removePhraseBar(single, 'p-bar-0', TS)).toBe(single);

    const two = phrase('q', 'Verse', 2);
    expect(removePhraseBar(two, 'nope', TS)).toBe(two);
  });

  // The mirror of `insertPhraseBars`: the curves close up with the bars, or a swell
  // written for bar 3 would go on sounding over what is now bar 2.
  it('walks the curves past the departing bar back, and drops what was over it', () => {
    const source: Phrase = {
      ...phrase('p', 'Verse', 3),
      volumeAutomation: [
        { beat: 0, value: 0.2 },
        { beat: 5, value: 0.7 },
        { beat: 8, value: 1 },
      ],
      parameterAutomation: [
        {
          target: { kind: 'cc', controller: 11 },
          name: 'Expression',
          points: [
            { beat: 2, value: 0.1 },
            { beat: 8, value: 0.9 },
          ],
        },
      ],
    };

    // Bar 1 is beats 4-8, so the point on beat 5 goes with it.
    const shortened = removePhraseBar(source, 'p-bar-1', TS);

    expect(shortened.volumeAutomation).toEqual([
      { beat: 0, value: 0.2 },
      { beat: 4, value: 1 },
    ]);
    expect(shortened.parameterAutomation![0].points).toEqual([
      { beat: 2, value: 0.1 },
      { beat: 4, value: 0.9 },
    ]);
    expect(shortened.parameterAutomation![0].name).toBe('Expression');
    expect(source.volumeAutomation).toHaveLength(3);
  });

  // A curve written only over the bar being taken away has nothing left to say, and
  // only the absent form hands the placement back to the instrument's fader.
  it('drops a volume curve emptied by the removal, but keeps a named lane', () => {
    const source: Phrase = {
      ...phrase('p', 'Verse', 2),
      volumeAutomation: [{ beat: 5, value: 0.7 }],
      parameterAutomation: [
        { target: { kind: 'cc', controller: 11 }, name: 'Expression', points: [{ beat: 5, value: 0.7 }] },
      ],
    };

    const shortened = removePhraseBar(source, 'p-bar-1', TS);

    expect(shortened.volumeAutomation).toBeUndefined();
    expect(shortened.parameterAutomation).toEqual([
      { target: { kind: 'cc', controller: 11 }, name: 'Expression', points: [] },
    ]);
  });
});

describe('insertPhraseBars', () => {
  it('opens empty bars up at the index and pushes the rest along', () => {
    const grown = insertPhraseBars(phrase('p', 'Verse', 3), 1, 2, TS);

    expect(grown.bars).toHaveLength(5);
    expect(grown.bars.map(b => b.barIndex)).toEqual([0, 1, 2, 3, 4]);
    // The bars either side are the originals, still holding their blocks.
    expect(grown.bars[0].id).toBe('p-bar-0');
    expect(grown.bars.slice(3).map(b => b.id)).toEqual(['p-bar-1', 'p-bar-2']);
    expect(barChords(grown.bars[3], PHRASE_TRACK_KEY)).toHaveLength(1);
    // The new ones hold nothing, and are bars of their own rather than shared refs.
    expect(grown.bars[1].content).toEqual({});
    expect(grown.bars[2].content).toEqual({});
    expect(grown.bars[1].id).not.toBe(grown.bars[2].id);
  });

  it('inserts at the front and at the end', () => {
    expect(insertPhraseBars(phrase('p', 'Verse', 2), 0, 1, TS).bars[0].content).toEqual({});

    const appended = insertPhraseBars(phrase('q', 'Verse', 2), 2, 1, TS);
    expect(appended.bars).toHaveLength(3);
    expect(appended.bars[2].content).toEqual({});
  });

  it('clamps an index past the ends rather than refusing', () => {
    const past = insertPhraseBars(phrase('p', 'Verse', 2), 99, 1, TS);
    expect(past.bars[2].content).toEqual({});

    const before = insertPhraseBars(phrase('q', 'Verse', 2), -5, 1, TS);
    expect(before.bars[0].content).toEqual({});
  });

  it('hands the phrase straight back when there is nothing to insert', () => {
    const source = phrase('p', 'Verse', 2);
    expect(insertPhraseBars(source, 1, 0, TS)).toBe(source);
    expect(insertPhraseBars(source, 1, -3, TS)).toBe(source);
  });

  // The curves know nothing of bar lines, so they are the one thing that has to be
  // walked forward by hand — a swell written over bar 2 must stay over bar 2's music.
  it('walks the curves past the insertion point forward, and leaves the rest', () => {
    const source: Phrase = {
      ...phrase('p', 'Verse', 3),
      volumeAutomation: [
        { beat: 0, value: 0.2 },
        { beat: 4, value: 1 },
        { beat: 10, value: 0.5 },
      ],
      parameterAutomation: [
        {
          target: { kind: 'cc', controller: 11 },
          name: 'Expression',
          points: [
            { beat: 2, value: 0.1 },
            { beat: 8, value: 0.9 },
          ],
        },
      ],
    };

    // One 4/4 bar inserted before bar 1, i.e. at beat 4.
    const grown = insertPhraseBars(source, 1, 1, TS);

    expect(grown.volumeAutomation).toEqual([
      { beat: 0, value: 0.2 },
      { beat: 8, value: 1 },
      { beat: 14, value: 0.5 },
    ]);
    expect(grown.parameterAutomation![0].points).toEqual([
      { beat: 2, value: 0.1 },
      { beat: 12, value: 0.9 },
    ]);
    // The lane keeps its identity, not just its shape.
    expect(grown.parameterAutomation![0].name).toBe('Expression');
    expect(source.volumeAutomation).toEqual([
      { beat: 0, value: 0.2 },
      { beat: 4, value: 1 },
      { beat: 10, value: 0.5 },
    ]);
  });

  it('leaves a phrase with no curves without any', () => {
    const grown = insertPhraseBars(phrase('p', 'Verse', 2), 1, 1, TS);

    expect(grown.volumeAutomation).toBeUndefined();
    expect(grown.parameterAutomation).toBeUndefined();
  });
});

describe('removePhraseBars', () => {
  it('takes a run out at once and closes the curves up behind it', () => {
    const source: Phrase = {
      ...phrase('p', 'Verse', 4),
      volumeAutomation: [
        { beat: 0, value: 0.2 },
        { beat: 6, value: 0.7 },
        { beat: 12, value: 1 },
      ],
    };

    // Bars 1 and 2 are beats 4-12, so the point on beat 6 goes with them.
    const shortened = removePhraseBars(source, 1, 2, TS);

    expect(shortened.bars.map(b => b.id)).toEqual(['p-bar-0', 'p-bar-3']);
    expect(shortened.bars.map(b => b.barIndex)).toEqual([0, 1]);
    expect(shortened.volumeAutomation).toEqual([
      { beat: 0, value: 0.2 },
      { beat: 4, value: 1 },
    ]);
  });

  it('trims a run that overruns the end rather than refusing it', () => {
    const shortened = removePhraseBars(phrase('p', 'Verse', 3), 1, 9, TS);

    expect(shortened.bars.map(b => b.id)).toEqual(['p-bar-0']);
  });

  // Part of what was asked for is the one answer nobody wants; the count says
  // plainly how much is meant to go, and if that is everything the answer is no.
  it('refuses a run that would take every bar, and any run of nothing', () => {
    const source = phrase('p', 'Verse', 3);

    expect(removePhraseBars(source, 0, 3, TS)).toBe(source);
    expect(removePhraseBars(source, 0, 5, TS)).toBe(source);
    expect(removePhraseBars(source, 1, 0, TS)).toBe(source);
    expect(removePhraseBars(source, 9, 1, TS)).toBe(source);
  });
});

/**
 * `compileAutomation` — the curves an instrument plays, worked out from the phrases
 * placed on it.
 *
 * A curve belongs to the phrase and is written on the phrase's own beats. What the
 * scheduler and the exporter read is still a curve on the instrument in the song's
 * beats, so it is compiled at load and after every edit, exactly as `compileBars`
 * compiles the music. The instrument's fader is what the shape is scaled by: 1 in a
 * phrase means "the level the fader is at", not "full".
 */
describe('compileAutomation', () => {
  /** An instrument with its fader somewhere other than 1, so scaling shows. */
  function fader(id: string, volume: number): Track {
    return { ...track(id), volume };
  }

  /** The phrase helper, with a volume shape on it. */
  function shaped(id: string, lengthBars: number, points: AutomationPoint[]): Phrase {
    return { ...phrase(id, id, lengthBars), volumeAutomation: points };
  }

  const compile = (tracks: Track[], phrases: Phrase[], clips: PhraseClip[], bars = songBars(8)) =>
    compileAutomation(tracks, bars, phrases, clips, TS);

  it('leaves an instrument with no placements uncurved, so its fader stands alone', () => {
    const [out] = compile([fader('t', 0.5)], [], []);

    expect(out.volumeAutomation).toBeUndefined();
    expect(out.parameterAutomation).toBeUndefined();
  });

  it('moves the phrase-local beats to where the placement is', () => {
    const p = shaped('p', 1, [{ beat: 1, value: 1 }]);
    const [out] = compile([fader('t', 1)], [p], [clip('c', 'p', 't', 2)]);

    // Bar 2 starts on beat 8, so the phrase's beat 1 is the song's beat 9.
    expect(out.volumeAutomation).toContainEqual({ beat: 9, value: 1 });
  });

  it('scales the shape by the fader, rather than replacing it', () => {
    const p = shaped('p', 1, [{ beat: 0, value: 0.5 }]);
    const [out] = compile([fader('t', 0.5)], [p], [clip('c', 'p', 't', 0)]);

    expect(out.volumeAutomation![0]).toEqual({ beat: 0, value: 0.25 });
  });

  // Bars the phrase does not cover are not its to shape, so the curve holds to the
  // placement's last moment and then steps back to the plain fader level.
  it('hands the instrument back to the fader where the placement ends', () => {
    const p = shaped('p', 1, [{ beat: 0, value: 0.25 }]);
    const [out] = compile([fader('t', 1)], [p], [clip('c', 'p', 't', 0)]);

    const points = out.volumeAutomation!;
    expect(points[points.length - 1]).toEqual({ beat: 4, value: 1 });
    // Held right up to it: the step back is a ramp too short to hear.
    expect(points[points.length - 2].value).toBe(0.25);
    expect(points[points.length - 2].beat).toBeLessThan(4);
    expect(points[points.length - 2].beat).toBeGreaterThan(3.9);
  });

  // Otherwise the level the last placement ended on would bleed across a gap, or
  // across a block written to play flat.
  it('opens an unshaped placement at the fader', () => {
    const shapedPhrase = shaped('a', 1, [{ beat: 0, value: 0.2 }]);
    const flat = phrase('b', 'b', 1);
    const [out] = compile(
      [fader('t', 1)],
      [shapedPhrase, flat],
      [clip('c1', 'a', 't', 0), clip('c2', 'b', 't', 1)]
    );

    expect(out.volumeAutomation).toContainEqual({ beat: 4, value: 1 });
  });

  it('writes the same shape at every placement of the phrase', () => {
    const p = shaped('p', 1, [{ beat: 0, value: 0.5 }]);
    const [out] = compile([fader('t', 1)], [p], [clip('c1', 'p', 't', 0), clip('c2', 'p', 't', 2)]);

    expect(out.volumeAutomation).toContainEqual({ beat: 0, value: 0.5 });
    expect(out.volumeAutomation).toContainEqual({ beat: 8, value: 0.5 });
  });

  it('touches only the instrument the phrase is placed on', () => {
    const p = shaped('p', 1, [{ beat: 0, value: 0.5 }]);
    const out = compile([fader('t1', 1), fader('t2', 1)], [p], [clip('c', 'p', 't1', 0)]);

    expect(out[0].volumeAutomation).toBeDefined();
    expect(out[1].volumeAutomation).toBeUndefined();
  });

  it('ignores a placement whose phrase has gone', () => {
    const [out] = compile([fader('t', 1)], [], [clip('c', 'missing', 't', 0)]);

    expect(out.volumeAutomation).toBeUndefined();
  });

  // Nothing changed, so the same object comes back: React does not re-render, and
  // the scheduler does not mistake a fresh array for a curve that has been redrawn.
  it('returns the instrument untouched when nothing about it changed', () => {
    const p = shaped('p', 1, [{ beat: 0, value: 0.5 }]);
    const clips = [clip('c', 'p', 't', 0)];
    const [once] = compile([fader('t', 1)], [p], clips);
    const [twice] = compile([once], [p], clips);

    expect(twice).toBe(once);
  });

  describe('plugin lanes', () => {
    /** A phrase driving one plugin parameter. */
    function driven(id: string, lengthBars: number, points: AutomationPoint[]): Phrase {
      return {
        ...phrase(id, id, lengthBars),
        parameterAutomation: [{ target: { kind: 'param', paramId: 7 }, name: 'Cutoff', points }],
      };
    }

    it('moves a lane to the placement, like the volume shape', () => {
      const p = driven('p', 1, [{ beat: 1, value: 0.3 }]);
      const [out] = compile([fader('t', 1)], [p], [clip('c', 'p', 't', 1)]);

      expect(out.parameterAutomation).toEqual([
        { target: { kind: 'param', paramId: 7 }, name: 'Cutoff', points: [{ beat: 5, value: 0.3 }] },
      ]);
    });

    // A parameter is what it is: unlike volume, there is no fader behind it for a
    // value to be relative to.
    it('leaves a lane value alone, however the fader is set', () => {
      const p = driven('p', 1, [{ beat: 0, value: 0.3 }]);
      const [out] = compile([fader('t', 0.5)], [p], [clip('c', 'p', 't', 0)]);

      expect(out.parameterAutomation![0].points).toEqual([{ beat: 0, value: 0.3 }]);
    });

    it('gathers every placement into one lane per parameter', () => {
      const p = driven('p', 1, [{ beat: 0, value: 0.3 }]);
      const [out] = compile([fader('t', 1)], [p], [clip('c1', 'p', 't', 0), clip('c2', 'p', 't', 2)]);

      expect(out.parameterAutomation).toHaveLength(1);
      expect(out.parameterAutomation![0].points).toEqual([
        { beat: 0, value: 0.3 },
        { beat: 8, value: 0.3 },
      ]);
    });

    it('keeps two phrases driving different parameters apart', () => {
      const a = driven('a', 1, [{ beat: 0, value: 0.3 }]);
      const b: Phrase = {
        ...phrase('b', 'b', 1),
        parameterAutomation: [
          { target: { kind: 'cc', controller: 20 }, name: 'CC 20', points: [{ beat: 0, value: 0.9 }] },
        ],
      };
      const [out] = compile([fader('t', 1)], [a, b], [clip('c1', 'a', 't', 0), clip('c2', 'b', 't', 1)]);

      expect(out.parameterAutomation!.map(l => laneKey(l.target))).toEqual(['cc:20', 'param:7']);
    });

    // An empty lane is a gesture the user has yet to draw into; it drives nothing,
    // so nothing about it should reach the plugin.
    it('drops a lane with no points', () => {
      const p = driven('p', 1, []);
      const [out] = compile([fader('t', 1)], [p], [clip('c', 'p', 't', 0)]);

      expect(out.parameterAutomation).toBeUndefined();
    });
  });
});
