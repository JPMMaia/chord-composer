import type {
  AutomationPoint,
  Bar,
  ParameterAutomation,
  Note,
  Phrase,
  PhraseClip,
  Project,
  TimeSignature,
  Track,
  TrackContent,
} from '@/types/music';
import {
  allBarNotes,
  getBarBeats,
  getBarStartBeat,
  getTotalBeats,
  withBarContent,
} from '@/engine/timeline';
import { normalizePoints, samePoints } from '@/engine/volumeAutomation';
import {
  laneKey,
  normalizeParameterAutomation,
  sameLanes,
} from '@/engine/parameterAutomation';
import { generateId } from '@/utils/id';
import { TRACK_COLORS } from '@/utils/constants';

/**
 * Phrases — named, reusable blocks of one instrument's material — and the placements
 * that put them somewhere in the song.
 *
 * Kept free of React and of the store, in the spirit of `@/engine/sections`:
 * `normalizeClips` is the single gate every stored list passes through — the store on
 * every edit, the file loader on read — so nothing downstream has to defend against a
 * dangling, overlapping or malformed array.
 *
 * The one idea worth holding while reading this file: a phrase's bars are *local*,
 * numbered from zero, and a clip is the only thing that knows where they land in the
 * song. `compileBars` is where the two meet, and it is the only place in the app where
 * a phrase turns into something that can be played.
 */

/**
 * The key a phrase's own content is filed under inside its local bars.
 *
 * A constant rather than a track id, so the whole of `@/engine/timeline` — `barChords`,
 * `mapBarChords`, `placeSegmentInBar`, `clearRange`, `refitBars`, `findSegment`,
 * `flattenSegments` — works on a phrase unchanged, by being handed this where it would
 * otherwise be handed a `Track.id`. That reuse is the reason a phrase stores bars at
 * all rather than a flat segment list.
 *
 * Deliberately not shaped like a generated id, so a phrase's content can never be
 * mistaken for an instrument's and vice versa.
 */
export const PHRASE_TRACK_KEY = '__phrase__';

/**
 * The colour a phrase draws in, by its position in the project.
 *
 * Shares `TRACK_COLORS` with the instruments rather than owning a palette, unlike
 * `SECTION_COLORS`: a phrase block sits *on* an instrument's row and belongs to it in
 * a way a section band belongs to nobody, so reading in the same hues is honest here.
 */
export function phraseColorAt(index: number): string {
  return TRACK_COLORS[Math.abs(Math.trunc(index)) % TRACK_COLORS.length];
}

/** How many bars a phrase occupies. */
export function phraseLengthBars(phrase: Phrase): number {
  return phrase.bars.length;
}

/** A phrase by id, or null. */
export function phraseById(phrases: Phrase[], phraseId: string): Phrase | null {
  return phrases.find(p => p.id === phraseId) ?? null;
}

/**
 * The bar after the last one a clip covers — exclusive, like `Section.endBeat`.
 *
 * A clip whose phrase has gone returns its own `startBar`, i.e. covers nothing, so an
 * overlap test can be run against a dangling clip without having to check for one
 * first. `normalizeClips` drops it moments later regardless.
 */
export function clipEndBar(clip: PhraseClip, phrases: Phrase[]): number {
  const phrase = phraseById(phrases, clip.phraseId);
  return clip.startBar + (phrase ? phraseLengthBars(phrase) : 0);
}

/** Whether a value off a file is a usable clip. */
function isClip(clip: unknown): clip is PhraseClip {
  if (typeof clip !== 'object' || clip === null) return false;
  const { id, phraseId, trackId, startBar } = clip as PhraseClip;
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    typeof phraseId === 'string' &&
    typeof trackId === 'string' &&
    typeof startBar === 'number' &&
    Number.isInteger(startBar) &&
    startBar >= 0
  );
}

/**
 * Sorted by row then start, with everything that names nothing dropped.
 *
 * A clip whose `phraseId` or `trackId` resolves to nothing goes rather than being
 * repaired, following `readVoicing` and its neighbours in `fileIO`: inventing a target
 * hides a broken file instead of surfacing it. So does a zero-length one, which covers
 * no bar and could never be clicked, dragged or heard again.
 *
 * Overlaps are *not* resolved here — see `normalizeClips` and `relocateOverlaps`, which
 * are the two different right answers to an overlap depending on where it came from.
 */
export function validClips(
  clips: PhraseClip[],
  phrases: Phrase[],
  tracks: Track[]
): PhraseClip[] {
  if (!Array.isArray(clips)) return [];

  const phraseIds = new Set(phrases.map(p => p.id));
  const trackIds = new Set(tracks.map(t => t.id));

  return clips
    .filter(isClip)
    .filter(c => phraseIds.has(c.phraseId) && trackIds.has(c.trackId))
    .filter(c => clipEndBar(c, phrases) > c.startBar)
    // Ties break on the longer phrase first, so of two clips starting together the
    // wider one leads — the same instinct as `normalizeSections`, which keeps the
    // wider of two sections that start on the same beat.
    .sort(
      (a, b) =>
        a.trackId.localeCompare(b.trackId) ||
        a.startBar - b.startBar ||
        clipEndBar(b, phrases) - clipEndBar(a, phrases)
    );
}

/**
 * Push any placement overlapping the one before it on its row forward to clear it.
 *
 * The right answer to an overlap produced by an *edit* — a phrase grown by a block
 * dragged past its last bar, or by the resize grip. Shifting keeps every placement and
 * every note; dropping one would delete an arbitrary amount of music as a side effect
 * of lengthening something else.
 */
export function relocateOverlaps(clips: PhraseClip[], phrases: Phrase[]): PhraseClip[] {
  const byRow = new Map<string, PhraseClip[]>();
  for (const clip of clips) {
    const row = byRow.get(clip.trackId);
    if (row) row.push(clip);
    else byRow.set(clip.trackId, [clip]);
  }

  const moved = new Map<string, number>();
  for (const row of byRow.values()) {
    let free = 0;
    for (const clip of [...row].sort((a, b) => a.startBar - b.startBar)) {
      const start = Math.max(clip.startBar, free);
      if (start !== clip.startBar) moved.set(clip.id, start);
      free = start + (clipEndBar(clip, phrases) - clip.startBar);
    }
  }

  return moved.size === 0
    ? clips
    : clips.map(c => (moved.has(c.id) ? { ...c, startBar: moved.get(c.id)! } : c));
}

/**
 * `validClips`, with any surviving overlap resolved by dropping the *later* placement.
 *
 * The gate a file read passes through, and the opposite rule to `relocateOverlaps`
 * above. An overlap in a file means the data is already wrong, and shifting a clip to a
 * bar nobody put it in would quietly invent an arrangement rather than surface the
 * damage.
 *
 * The earlier clip wins, which is also the opposite of `normalizeSections`. A section
 * can be trimmed back to make room, so punch-in costs it only the overlap; a phrase has
 * a fixed length and cannot be trimmed, so punch-in would cost it everything.
 */
export function normalizeClips(
  clips: PhraseClip[],
  phrases: Phrase[],
  tracks: Track[]
): PhraseClip[] {
  const kept: PhraseClip[] = [];
  for (const clip of validClips(clips, phrases, tracks)) {
    const previous = kept[kept.length - 1];
    if (
      previous &&
      previous.trackId === clip.trackId &&
      clipEndBar(previous, phrases) > clip.startBar
    ) {
      continue;
    }
    kept.push(clip);
  }
  return kept;
}

/**
 * Whether a clip could sit at `startBar` on `trackId` without touching another.
 *
 * `candidate.id` names the clip being moved, which is excluded from the test so that
 * nudging a block by one bar is not refused for overlapping the place it is leaving.
 * Omit it for a clip that does not exist yet.
 */
export function canPlaceClip(
  clips: PhraseClip[],
  phrases: Phrase[],
  candidate: { id?: string; phraseId: string; trackId: string; startBar: number }
): boolean {
  if (!Number.isInteger(candidate.startBar) || candidate.startBar < 0) return false;

  const phrase = phraseById(phrases, candidate.phraseId);
  if (!phrase) return false;

  const start = candidate.startBar;
  const end = start + phraseLengthBars(phrase);
  if (end <= start) return false;

  return !clips.some(
    other =>
      other.id !== candidate.id &&
      other.trackId === candidate.trackId &&
      other.startBar < end &&
      clipEndBar(other, phrases) > start
  );
}

/**
 * The first bar at or after a clip's end where a copy of it would fit on its row.
 *
 * What "duplicate" means without a drag to say where: "again, right after this one".
 * Walking forward rather than refusing when the next span is taken keeps the command
 * usable on a row that is already densely packed, which is exactly the row a repeat is
 * most wanted on.
 */
export function freeBarAfter(clips: PhraseClip[], phrases: Phrase[], clip: PhraseClip): number {
  const length = clipEndBar(clip, phrases) - clip.startBar;
  let at = clipEndBar(clip, phrases);

  // Bounded by the row's own clips: past the last of them nothing can be in the way.
  for (let guard = 0; guard <= clips.length; guard++) {
    const free = canPlaceClip(clips, phrases, {
      phraseId: clip.phraseId,
      trackId: clip.trackId,
      startBar: at,
    });
    if (free) return at;
    at += length;
  }

  return at;
}

/** The clip covering a bar on a row, or null when that bar is silent there. */
export function clipAt(
  clips: PhraseClip[],
  phrases: Phrase[],
  trackId: string,
  bar: number
): PhraseClip | null {
  return (
    clips.find(
      c => c.trackId === trackId && c.startBar <= bar && clipEndBar(c, phrases) > bar
    ) ?? null
  );
}

/** Every clip on one instrument's row, in the order `normalizeClips` left them. */
export function clipsOnTrack(clips: PhraseClip[], trackId: string): PhraseClip[] {
  return clips.filter(c => c.trackId === trackId);
}

/** How many places a phrase is played. Zero means it is in the library only. */
export function placementCount(clips: PhraseClip[], phraseId: string): number {
  return clips.reduce((n, c) => n + (c.phraseId === phraseId ? 1 : 0), 0);
}

/** Phrases no clip references — the library strip's contents. */
export function unplacedPhrases(phrases: Phrase[], clips: PhraseClip[]): Phrase[] {
  const placed = new Set(clips.map(c => c.phraseId));
  return phrases.filter(p => !placed.has(p.id));
}

/**
 * The id a segment carries once compiled into the song, for one placement of its phrase.
 *
 * Two placements of one phrase put the same material into the timeline twice, and the
 * piano roll, the scheduler and `findSegment` all assume an id identifies one block.
 * Prefixing with the clip keeps them apart without the phrase having to know how many
 * times it is played.
 *
 * Reversible by `sourceSegmentId` below, which is what lets a click on a compiled block
 * in the arrangement lead back to the segment that authored it.
 */
export function compiledSegmentId(clipId: string, segmentId: string): string {
  return `${clipId}::${segmentId}`;
}

/** The authored segment id behind a compiled one, or the id itself if it is not compiled. */
export function sourceSegmentId(compiledId: string): string {
  const at = compiledId.indexOf('::');
  return at === -1 ? compiledId : compiledId.slice(at + 2);
}

/** The clip a compiled segment id belongs to, or null if it is not a compiled id. */
export function clipIdOfCompiled(compiledId: string): string | null {
  const at = compiledId.indexOf('::');
  return at === -1 ? null : compiledId.slice(0, at);
}

/** An empty phrase of `lengthBars` bars, ready to be written into. */
export function createPhrase(name: string, lengthBars: number, color?: string): Phrase {
  const bars: Bar[] = [];
  for (let i = 0; i < Math.max(1, Math.trunc(lengthBars)); i++) {
    bars.push({ id: generateId(), barIndex: i, content: {} });
  }
  return { id: generateId(), name, color, bars };
}

/**
 * A deep copy of a phrase with fresh ids throughout — what Make Unique produces.
 *
 * Every id is regenerated, down to the individual segments, because the copy has to be
 * editable without the original moving with it. Sharing a segment id between two
 * phrases would put the same id in the timeline twice from two different sources,
 * which is precisely the confusion `compiledSegmentId` exists to prevent.
 */
export function clonePhrase(phrase: Phrase, name: string): Phrase {
  return {
    id: generateId(),
    name,
    color: phrase.color,
    // Copied wholesale: the curves are as much the phrase as its chords are, and a
    // copy that played flat would not be a copy of what the user is looking at. They
    // need no new ids — a breakpoint is identified by its position in its lane.
    volumeAutomation: phrase.volumeAutomation,
    parameterAutomation: phrase.parameterAutomation,
    bars: phrase.bars.map(bar => ({
      ...bar,
      id: generateId(),
      content: Object.fromEntries(
        Object.entries(bar.content).map(([key, content]) => [
          key,
          {
            chords: content.chords.map(c => ({ ...c, id: generateId() })),
            notes: content.notes.map(n => ({ ...n, id: generateId() })),
          },
        ])
      ),
    })),
  };
}

/**
 * Grow or shrink a phrase to `lengthBars`, keeping the bars it already has.
 *
 * Shrinking discards the trailing bars outright rather than trying to salvage what was
 * in them. There is nowhere to put it: the phrase is the container, and a segment with
 * no bar is not a thing this app can represent. Undo is the safety net, as it is for
 * every other destructive edit here.
 */
export function resizePhrase(phrase: Phrase, lengthBars: number): Phrase {
  const target = Math.max(1, Math.trunc(lengthBars));
  if (target === phrase.bars.length) return phrase;

  const bars = phrase.bars.slice(0, target);
  while (bars.length < target) {
    bars.push({ id: generateId(), barIndex: bars.length, content: {} });
  }
  return { ...phrase, bars: bars.map((bar, i) => ({ ...bar, barIndex: i })) };
}

/**
 * A phrase's curves, put through one transform and handed back ready to spread.
 *
 * The bar-count edits below all move music that is stored in two places at once.
 * Chords and notes ride inside the bars, so re-arranging the bar list carries them
 * along for free. The curves do not: `volumeAutomation` and every lane of
 * `parameterAutomation` run along a beat axis local to the phrase that knows nothing
 * of bar lines, so a bar opened up or closed up in front of them leaves them sounding
 * over the wrong music unless they are walked by hand. This is that hand, written once
 * so `insertPhraseBars` and `removePhraseBar` cannot drift apart on it.
 *
 * `move` may drop points as well as move them — a bar being taken away takes what was
 * written over it with it — so the result is renormalised, and an emptied volume curve
 * comes back absent rather than empty. That is the rule `updateVolumeAutomation`
 * states: only the absent form hands the placement back to the instrument's fader.
 * A lane is kept even when emptied, since a lane is something the user named.
 */
function withCurves(
  phrase: Phrase,
  move: (points: AutomationPoint[]) => AutomationPoint[]
): Pick<Phrase, 'volumeAutomation' | 'parameterAutomation'> {
  const volume = phrase.volumeAutomation ? normalizePoints(move(phrase.volumeAutomation)) : [];
  return {
    volumeAutomation: volume.length > 0 ? volume : undefined,
    parameterAutomation: phrase.parameterAutomation
      ? normalizeParameterAutomation(
          phrase.parameterAutomation.map(lane => ({ ...lane, points: move(lane.points) }))
        )
      : undefined,
  };
}

/**
 * A phrase with empty bars opened up in the middle of it, at `index`.
 *
 * The other half of `removePhraseBar`: one closes a bar up, this one makes room. Both
 * exist because a bar cursor can sit anywhere in a phrase, so neither gesture can be
 * expressed by `resizePhrase`, which only ever works at the end.
 *
 * The material moves in two different ways, because it is stored in two different
 * places. Chords and notes live *inside* the bars, so splicing the bar list is the
 * whole of it — every block keeps the beat it holds within its own bar, and simply
 * finds itself a bar or more later. The curves do not: they run along a beat axis
 * local to the phrase and know nothing of bar lines, so every breakpoint from the
 * insertion beat on has to be walked forward by hand, or a swell written for bar 3
 * would go on sounding over the silence just inserted in front of it.
 *
 * The metre comes in from the caller rather than off the bars: a phrase's own bars
 * carry none, borrowing the song's through `phraseBarsForDisplay`, and the curves have
 * to be measured in the same beats the timeline draws them in.
 *
 * Clamped rather than rejected, and a non-positive `count` does nothing — the caller is
 * a context menu, and a sloppy one simply does not apply, exactly as for `insertBar`.
 * An edit that changes nothing hands the phrase straight back, so the store can skip a
 * no-op write.
 */
export function insertPhraseBars(
  phrase: Phrase,
  index: number,
  count: number,
  projectTs: TimeSignature
): Phrase {
  const amount = Math.trunc(count);
  if (amount <= 0) return phrase;

  const at = Math.max(0, Math.min(Math.trunc(index), phrase.bars.length));
  const bars = [...phrase.bars];
  const fresh: Bar[] = Array.from({ length: amount }, () => ({
    id: generateId(),
    barIndex: 0,
    content: {},
  }));
  bars.splice(at, 0, ...fresh);

  // Summed bar by bar rather than multiplied out, so both figures stay honest if a
  // phrase bar ever carries a metre of its own.
  const startBeat = getBarStartBeat(phrase.bars, at, projectTs);
  const addedBeats = fresh.reduce((sum, bar) => sum + getBarBeats(bar, projectTs), 0);

  return {
    ...phrase,
    bars: bars.map((bar, i) => ({ ...bar, barIndex: i })),
    ...withCurves(phrase, points =>
      points.map(p => (p.beat >= startBeat ? { ...p, beat: p.beat + addedBeats } : p))
    ),
  };
}

/**
 * A phrase with one of its bars taken out, and the bars after it closed up behind.
 *
 * The counterpart of `resizePhrase`, which only ever trims the end. A bar cursor can
 * sit anywhere in a phrase, so "remove this bar" has to mean the bar the user is
 * looking at rather than the last one — the same thing `removeBar` means for the song.
 *
 * The curves close up with the bars, through the same `withCurves` that opens them up
 * in `insertPhraseBars`. What was written *over* the departing bar goes with it rather
 * than piling up on the seam: the bar's material is being discarded, and a breakpoint
 * is part of that material — the same call `resizePhrase` makes about the bars it
 * trims. Everything past the bar walks back by its width, so a swell written for the
 * bar after it stays over the bar after it.
 *
 * The last remaining bar is kept: a phrase with no bars covers nothing, so
 * `clipEndBar` would report it as zero-length and `validClips` would drop every
 * placement of it — deleting the arrangement as a side effect of emptying one bar.
 */
export function removePhraseBar(
  phrase: Phrase,
  barId: string,
  projectTs: TimeSignature
): Phrase {
  const at = phrase.bars.findIndex(bar => bar.id === barId);
  return at === -1 ? phrase : removePhraseBars(phrase, at, 1, projectTs);
}

/**
 * The same edit by position and length — a run of bars taken out at once.
 *
 * What the ruler's menu removes, and the form `removePhraseBar` is written in terms
 * of: the menu names a bar and a count, while the bar cursor names an id, and only the
 * first of the two can ask for more than one bar.
 *
 * A run that would take every bar is refused outright rather than trimmed to leave
 * one. A partly-applied removal is the one answer nobody asked for — the count says
 * plainly how much is meant to go, and if that is everything the answer is no.
 */
export function removePhraseBars(
  phrase: Phrase,
  index: number,
  count: number,
  projectTs: TimeSignature
): Phrase {
  const amount = Math.trunc(count);
  if (amount <= 0) return phrase;

  const at = Math.max(0, Math.trunc(index));
  if (at >= phrase.bars.length) return phrase;

  const span = Math.min(amount, phrase.bars.length - at);
  if (span >= phrase.bars.length) return phrase;

  const gone = phrase.bars.slice(at, at + span);
  const startBeat = getBarStartBeat(phrase.bars, at, projectTs);
  const goneBeats = gone.reduce((sum, bar) => sum + getBarBeats(bar, projectTs), 0);
  const endBeat = startBeat + goneBeats;

  return {
    ...phrase,
    bars: phrase.bars
      .filter((_, i) => i < at || i >= at + span)
      .map((bar, i) => ({ ...bar, barIndex: i })),
    ...withCurves(phrase, points =>
      points
        .filter(p => p.beat < startBeat || p.beat >= endBeat)
        .map(p => (p.beat >= endBeat ? { ...p, beat: p.beat - goneBeats } : p))
    ),
  };
}

/**
 * A default name for a new phrase: "Phrase 1", "Phrase 2", …
 *
 * Skips names already taken rather than counting, exactly as `nextSectionName` does, so
 * two quick drags never produce two identically-named blocks — which would make the
 * arrangement unreadable at the moment the user is laying it out.
 */
export function nextPhraseName(phrases: Phrase[]): string {
  const taken = new Set(phrases.map(p => p.name));
  for (let n = 1; ; n++) {
    const name = `Phrase ${n}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * A name for a copy that has just been made unique: "Verse", "Verse 2", "Verse 3", …
 *
 * Suffixes rather than prefixes with "Copy of", so the two sort together in the library
 * and the family stays legible after the third or fourth split.
 */
export function uniquePhraseName(phrases: Phrase[], base: string): string {
  const taken = new Set(phrases.map(p => p.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** The bar grid the clips need — long enough that no placement runs off the end. */
function barsNeeded(clips: PhraseClip[], phrases: Phrase[]): number {
  return clips.reduce((max, clip) => Math.max(max, clipEndBar(clip, phrases)), 0);
}

/**
 * Append empty bars until there are `count` of them, each inheriting the previous
 * bar's metre — the rule `createBar` and `refitBars` already follow when a block spills
 * off the end of the song.
 */
function grownTo(bars: Bar[], count: number): Bar[] {
  if (bars.length >= count) return bars;
  const result = [...bars];
  while (result.length < count) {
    result.push({
      id: generateId(),
      barIndex: result.length,
      timeSignature: result[result.length - 1]?.timeSignature,
      content: {},
    });
  }
  return result;
}

/**
 * The song's bars with every clip's material written into them.
 *
 * This is the single point where a phrase becomes something that can be played, and the
 * reason nothing downstream had to change to accommodate phrases at all: playback, the
 * piano roll, the exporters and the song timer all read `Project.bars`, and this keeps
 * that array saying exactly what it used to say.
 *
 * For each clip, the phrase's local bar `i` is copied into song bar `clip.startBar + i`
 * under the clip's track id. Segment and note ids are rewritten per clip so that two
 * placements of one phrase do not put the same id into the timeline twice.
 *
 * The grid itself is authored, not derived: `barIndex` and `timeSignature` are left
 * exactly as they were, and the only structural change is appending bars when a clip
 * runs past the end. Content, by contrast, is rebuilt from nothing every time — there
 * is no merge with what was there before, because anything that was there before was
 * this function's own output.
 */
export function compileBars(
  bars: Bar[],
  phrases: Phrase[],
  clips: PhraseClip[]
): Bar[] {
  const grid = grownTo(bars, Math.max(bars.length, barsNeeded(clips, phrases)));
  let result = grid.map(bar => (Object.keys(bar.content).length === 0 ? bar : { ...bar, content: {} }));

  for (const clip of clips) {
    const phrase = phraseById(phrases, clip.phraseId);
    if (!phrase) continue;

    for (let i = 0; i < phrase.bars.length; i++) {
      const target = clip.startBar + i;
      if (target >= result.length) break;

      const source = phrase.bars[i].content[PHRASE_TRACK_KEY];
      if (!source || (source.chords.length === 0 && source.notes.length === 0)) continue;

      const content: TrackContent = {
        chords: source.chords.map(c => ({ ...c, id: compiledSegmentId(clip.id, c.id) })),
        notes: source.notes.map(n => ({ ...n, id: compiledSegmentId(clip.id, n.id) })),
      };
      result[target] = withBarContent(result[target], clip.trackId, content);
    }
  }

  return result;
}

/**
 * How long the step back to the fader at the end of a placement takes, in beats.
 *
 * Two breakpoints cannot share a beat — `normalizePoints` dedupes them — so a step
 * has to be a very short ramp instead. A 64th of a beat is under 8 ms at 120 bpm:
 * inaudible as a slide, and gentler on the ear than the click a true step would make.
 */
const CURVE_STEP_BEATS = 1 / 64;

/**
 * The instruments with their curves recompiled from the phrases placed on them.
 *
 * The automation half of `compileBars`, and the reason a curve can belong to a phrase
 * at all: the phrase states a *shape* over its own bars, and this shifts a copy of it
 * to every placement, so playback, the exporters and the fader go on reading one flat
 * curve in absolute song beats and know nothing about phrases.
 *
 * Volume is scaled by `Track.volume` on the way through — the phrase says how loud
 * relative to the instrument, the instrument says how loud — which is what lets one
 * swell be played by the piano and the strings at their own levels. A parameter lane
 * is not scaled: a plugin parameter has no fader behind it to be relative to.
 *
 * Between the placements the instrument returns to its fader: a clip with no curve
 * opens with a point at the fader's level, and a clip with one closes with a step back
 * to it, so a swell in bars 5-8 does not leave the instrument quiet for the rest of the
 * song. A track whose placements are all unautomated gets no curve at all, which is
 * what hands it back to the flat `volume` and re-enables its fader.
 *
 * Tracks whose compiled curves are unchanged are returned by identity, so an edit
 * elsewhere in the project neither re-renders the stack nor makes the scheduler re-pin
 * a curve it is already playing.
 */
export function compileAutomation(
  tracks: Track[],
  bars: Bar[],
  phrases: Phrase[],
  clips: PhraseClip[],
  projectTs: Project['timeSignature']
): Track[] {
  const byTrack = new Map<string, PhraseClip[]>();
  for (const clip of clips) {
    const row = byTrack.get(clip.trackId);
    if (row) row.push(clip);
    else byTrack.set(clip.trackId, [clip]);
  }

  return tracks.map(track => {
    // Ascending, because the later of two points on one beat wins: that is what makes
    // a placement's opening point override the previous placement's closing one when
    // the two butt up against each other.
    const row = [...(byTrack.get(track.id) ?? [])].sort((a, b) => a.startBar - b.startBar);

    const volume: AutomationPoint[] = [];
    const lanes = new Map<string, ParameterAutomation>();
    let automated = false;

    for (const clip of row) {
      const phrase = phraseById(phrases, clip.phraseId);
      if (!phrase) continue;

      const startBeat = clipStartBeat(clip, bars, projectTs);
      const endBeat = startBeat + clipBeats(clip, phrases, bars, projectTs);

      const curve = normalizePoints(phrase.volumeAutomation ?? []);
      if (curve.length > 0) {
        automated = true;
        for (const point of curve) {
          volume.push({ beat: startBeat + point.beat, value: point.value * track.volume });
        }
        // Held to the placement's last moment, then handed back: what comes after this
        // clip is not this phrase's to shape.
        const last = curve[curve.length - 1].value * track.volume;
        volume.push({ beat: Math.max(startBeat, endBeat - CURVE_STEP_BEATS), value: last });
        volume.push({ beat: endBeat, value: track.volume });
      } else {
        // Nothing shapes this placement, so it plays at the fader rather than at
        // whatever level the placement before it happened to end on.
        volume.push({ beat: startBeat, value: track.volume });
      }

      for (const lane of phrase.parameterAutomation ?? []) {
        const key = laneKey(lane.target);
        const shifted = normalizePoints(lane.points).map(point => ({
          beat: startBeat + point.beat,
          value: point.value,
        }));
        const existing = lanes.get(key);
        if (existing) existing.points.push(...shifted);
        else lanes.set(key, { target: lane.target, name: lane.name, points: shifted });
      }
    }

    const nextVolume = automated ? normalizePoints(volume) : undefined;
    const nextLanes = lanes.size
      ? normalizeParameterAutomation([...lanes.values()], { dropEmpty: true })
      : [];

    if (
      samePoints(track.volumeAutomation, nextVolume) &&
      sameLanes(track.parameterAutomation ?? [], nextLanes)
    ) {
      return track;
    }

    return {
      ...track,
      volumeAutomation: nextVolume,
      parameterAutomation: nextLanes.length > 0 ? nextLanes : undefined,
    };
  });
}

/** `compileBars` applied to a whole project, with the clips normalised on the way in. */
export function compileProject(project: Project): Project {
  const clips = normalizeClips(project.clips, project.phrases, project.tracks);
  const bars = compileBars(project.bars, project.phrases, clips);
  return {
    ...project,
    clips,
    bars,
    tracks: compileAutomation(project.tracks, bars, project.phrases, clips, project.timeSignature),
  };
}

/**
 * The metre a phrase's bars should be shown in while it is edited.
 *
 * A phrase carries no metre of its own, so it borrows the one from the song bars the
 * placement being edited covers, and falls back to the project's own when it is
 * unplaced. That makes the phrase editor show the bar the user will actually hear —
 * right in the ordinary case of a phrase placed once, and honest about being a guess
 * only when the same phrase straddles a metre change, which nothing could get right.
 *
 * `clip` names *which* placement, and matters as soon as a phrase is placed twice: the
 * editor is looking at one of them, and the audition is playing that same one. Omitting
 * it falls back to the first placement, which is what every caller with no placement in
 * hand means.
 */
export function phraseBarsForDisplay(
  phrase: Phrase,
  project: Pick<Project, 'bars' | 'clips' | 'timeSignature'>,
  clip?: PhraseClip | null
): Bar[] {
  const placement = clip ?? project.clips.find(c => c.phraseId === phrase.id);
  if (!placement) return phrase.bars;

  return phrase.bars.map((bar, i) => {
    const songBar = project.bars[placement.startBar + i];
    return songBar?.timeSignature === bar.timeSignature
      ? bar
      : { ...bar, timeSignature: songBar?.timeSignature };
  });
}

/**
 * A phrase's bars filed under an instrument, for the views that draw by track id.
 *
 * The piano roll takes `bars` and `tracks` and reads `bar.content[track.id]`, which a
 * phrase's own bars answer with nothing — they file everything under
 * `PHRASE_TRACK_KEY`, precisely so the same phrase can be played by any instrument.
 * Re-keying here rather than teaching the roll about phrases keeps the roll a plain
 * function of bars, which is what lets it draw the arrangement unchanged.
 *
 * The ids are the phrase's own, not `compiledSegmentId`s: this is the surface being
 * edited, so a block the roll draws is one the segment actions will accept.
 */
export function phraseBarsAsTrack(
  phrase: Phrase,
  project: Pick<Project, 'bars' | 'clips' | 'timeSignature'>,
  trackId: string,
  clip?: PhraseClip | null
): Bar[] {
  return phraseBarsForDisplay(phrase, project, clip).map(bar => {
    const content = bar.content[PHRASE_TRACK_KEY];
    return content ? { ...bar, content: { [trackId]: content } } : { ...bar, content: {} };
  });
}

/**
 * The same bars, with the rest of the arrangement laid alongside them.
 *
 * What the phrase editor draws when it is showing context: the phrase on its own row,
 * plus whatever every *other* instrument sounds over the bars this placement occupies.
 * The piano roll needs no notion of phrases for that — it reads `bar.content` by track
 * id and dims the rows that are not the selected one, exactly as it does in the
 * arrangement — so the whole feature is a question of what is put on the surface.
 *
 * Gathered by *beat* rather than bar by bar, which is the only way to get a held note
 * right. A note is stored in the bar it **starts** in and may sound arbitrarily far past
 * it: a ten-bar drone is one forty-beat note filed in bar 0. Copying the content of the
 * bars this placement covers finds nothing on that row, so every phrase starting later
 * than the drone would be written against silence it can plainly hear. So the search is
 * over the whole song, and the test is whether a note's *span* reaches this placement.
 *
 * Such a note is re-based onto the phrase's own beat axis, which lands it at a negative
 * offset in local bar 0 — honestly, since it did begin before this phrase did. The roll
 * clips at the keyboard, so what draws is the part that actually sounds here.
 *
 * Only notes come across; the context rows carry no `chords`. The block lanes show one
 * instrument and never draw the others, so a compiled segment would be an id nothing on
 * this surface could use, on a row nothing on this surface can edit.
 *
 * Two rows are deliberately left out, and they are usually the same one. `trackId` is
 * where the phrase has just been filed, and `clip.trackId` is the row the song compiled
 * it onto: both hold this same phrase, whose compiled copy carries `compiledSegmentId`
 * ids — `clipId::segmentId` — while this is the surface being *edited*, and a block the
 * roll draws has to be one the segment actions will accept. They come apart when the
 * caller files the phrase under something other than the row it is played on, and
 * excluding only one would then draw the phrase twice — once authored, once compiled —
 * while hiding whatever really plays on the other row.
 *
 * A null `clip` is an unplaced phrase: it sits nowhere in the song, so there is no
 * stretch of arrangement to borrow, and this is just `phraseBarsAsTrack`.
 */
export function phraseBarsWithContext(
  phrase: Phrase,
  project: Pick<Project, 'bars' | 'clips' | 'timeSignature'>,
  trackId: string,
  clip: PhraseClip | null
): Bar[] {
  const bars = phraseBarsAsTrack(phrase, project, trackId, clip);
  if (!clip || bars.length === 0) return bars;

  const projectTs = project.timeSignature;
  const clipStart = clipStartBeat(clip, project.bars, projectTs);

  // The phrase's own beat axis: where each local bar starts, and how long the whole
  // placement is. Accumulated rather than multiplied, since bars may each carry a metre.
  const localStarts: number[] = [];
  let spanBeats = 0;
  for (const bar of bars) {
    localStarts.push(spanBeats);
    spanBeats += getBarBeats(bar, projectTs);
  }

  // Collected per local bar so the bars can be rebuilt in one pass below.
  const context = new Map<number, Map<string, Note[]>>();
  let songBeat = 0;
  for (const songBar of project.bars) {
    for (const { note, trackId: id } of allBarNotes(songBar)) {
      if (id === trackId || id === clip.trackId) continue;

      // Where the note sits on the phrase's own axis. Negative means it began before
      // this placement did, which a held note legitimately can.
      const start = songBeat + note.startBeat - clipStart;
      if (start + note.duration <= 0 || start >= spanBeats) continue;

      // The bar it starts in — or the first, for one that started before them all.
      let target = 0;
      for (let i = localStarts.length - 1; i >= 0; i--) {
        if (start >= localStarts[i]) { target = i; break; }
      }

      const rows = context.get(target) ?? new Map<string, Note[]>();
      const notes = rows.get(id) ?? [];
      notes.push({ ...note, startBeat: start - localStarts[target] });
      rows.set(id, notes);
      context.set(target, rows);
    }
    songBeat += getBarBeats(songBar, projectTs);
  }

  if (context.size === 0) return bars;

  return bars.map((bar, i) => {
    const rows = context.get(i);
    if (!rows) return bar;
    const added = Object.fromEntries(
      [...rows].map(([id, notes]) => [id, { chords: [], notes }])
    );
    // The phrase's own row is spread last so it always wins the merge.
    return { ...bar, content: { ...added, ...bar.content } };
  });
}

/**
 * How long a phrase is in beats, under the metre it is displayed in.
 *
 * Used to size the phrase editor's scroll extent, which needs a beat count rather than
 * a bar count because the beat axis is what everything horizontal is measured in.
 */
export function phraseBeats(
  phrase: Phrase,
  project: Pick<Project, 'bars' | 'clips' | 'timeSignature'>
): number {
  return getTotalBeats(phraseBarsForDisplay(phrase, project), project.timeSignature);
}

/**
 * The absolute beat a clip starts on, for drawing it against the shared beat axis.
 *
 * Bars may each carry their own metre, so this accumulates rather than multiplying —
 * the same walk `getBarStartBeat` does, and for the same reason.
 */
export function clipStartBeat(
  clip: PhraseClip,
  bars: Bar[],
  projectTs: Project['timeSignature']
): number {
  let beat = 0;
  for (let i = 0; i < clip.startBar && i < bars.length; i++) {
    beat += getBarBeats(bars[i], projectTs);
  }
  return beat;
}

/** How many beats wide a clip draws, under the metre of the bars it covers. */
export function clipBeats(
  clip: PhraseClip,
  phrases: Phrase[],
  bars: Bar[],
  projectTs: Project['timeSignature']
): number {
  let beats = 0;
  for (let i = clip.startBar; i < clipEndBar(clip, phrases); i++) {
    beats += bars[i] ? getBarBeats(bars[i], projectTs) : getBarBeats({ id: '', barIndex: i, content: {} }, projectTs);
  }
  return beats;
}
