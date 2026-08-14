import type { Section } from '@/types/music';
import { MIN_SEGMENT_BEATS } from '@/engine/timeline';

/**
 * Named spans over the arrangement — the shape of the piece, written down.
 *
 * Kept free of React and of the store, in the spirit of `@/engine/volumeAutomation`:
 * `normalizeSections` is the single gate every stored list passes through — the store
 * on every edit, the file loader on read — so nothing downstream has to defend against
 * an unsorted, overlapping or malformed array.
 *
 * Positions are absolute beats throughout, like the play range and unlike a chord
 * segment: a section is drawn across the music rather than owned by one bar.
 */

/**
 * Section colours, cycled by position.
 *
 * Deliberately not `TRACK_COLORS`: a band sitting above the ruler in an instrument's
 * hue would read as belonging to that instrument, and a section belongs to none.
 * These are the muted end of the wheel, since the band is a backdrop for its own
 * label rather than something to look at.
 */
export const SECTION_COLORS = [
  '#6366f1', // indigo
  '#0ea5e9', // sky
  '#22c55e', // green
  '#eab308', // yellow
  '#f97316', // orange
  '#f43f5e', // rose
];

/** The colour a section draws in, by its position in the project. */
export function sectionColorAt(index: number): string {
  return SECTION_COLORS[Math.abs(Math.trunc(index)) % SECTION_COLORS.length];
}

/** Whether a value off a file or a pointer is a usable section. */
function isSection(section: unknown): section is Section {
  if (typeof section !== 'object' || section === null) return false;
  const { id, name, startBeat, endBeat, color } = section as Section;
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    typeof name === 'string' &&
    typeof startBeat === 'number' &&
    typeof endBeat === 'number' &&
    Number.isFinite(startBeat) &&
    Number.isFinite(endBeat) &&
    (color === undefined || typeof color === 'string')
  );
}

/**
 * Sorted by start, clamped into the song, and free of overlaps.
 *
 * An overlap resolves by trimming the *earlier* section back to where the later one
 * begins — punch-in semantics, as `clearRange` uses for blocks — so dropping a section
 * over its neighbour shortens that neighbour rather than shoving the rest of the piece
 * along. Anything left shorter than `MIN_SEGMENT_BEATS` is dropped: a band too thin to
 * read its own name is not a label.
 *
 * Gaps are preserved. Music nobody has named is a legitimate state, and closing the
 * holes would silently invent sections the author never drew.
 */
export function normalizeSections(sections: Section[], songEnd: number): Section[] {
  if (!Array.isArray(sections)) return [];

  const limit = Number.isFinite(songEnd) && songEnd > 0 ? songEnd : 0;
  const clamp = (beat: number) => Math.max(0, Math.min(beat, limit));

  const sorted = sections
    .filter(isSection)
    .map(s => ({
      id: s.id,
      name: s.name,
      startBeat: clamp(Math.min(s.startBeat, s.endBeat)),
      endBeat: clamp(Math.max(s.startBeat, s.endBeat)),
      color: s.color,
    }))
    // Ties break on the longer span first, so the trim below leaves the wider of two
    // sections starting together rather than the arbitrary one that sorted first.
    .sort((a, b) => a.startBeat - b.startBeat || b.endBeat - a.endBeat);

  const kept: Section[] = [];
  for (const section of sorted) {
    const previous = kept[kept.length - 1];
    if (previous && previous.endBeat > section.startBeat) {
      previous.endBeat = section.startBeat;
      // The trim may have left nothing worth showing; the later section wins the
      // space outright in that case.
      if (previous.endBeat - previous.startBeat < MIN_SEGMENT_BEATS) kept.pop();
    }
    if (section.endBeat - section.startBeat < MIN_SEGMENT_BEATS) continue;
    kept.push(section);
  }

  return kept;
}

/**
 * The section containing an absolute beat, or null when the beat falls in a gap.
 *
 * Half-open, `[startBeat, endBeat)`, so a beat exactly on a boundary belongs to the
 * section it opens — the same rule the scheduler reads a block's span with.
 */
export function sectionAtBeat(sections: Section[], beat: number): Section | null {
  if (!Number.isFinite(beat)) return null;
  return sections.find(s => beat >= s.startBeat && beat < s.endBeat) ?? null;
}

/**
 * A default name for a new section: "Section 1", "Section 2", …
 *
 * Skips names already taken rather than counting, so two quick drags never produce
 * two identically-named bands — which would make the timeline unreadable at exactly
 * the moment the user is laying it out.
 */
export function nextSectionName(sections: Section[]): string {
  const taken = new Set(sections.map(s => s.name));
  for (let n = 1; ; n++) {
    const name = `Section ${n}`;
    if (!taken.has(name)) return name;
  }
}
