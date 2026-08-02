import type { ChordSegment, Note, TrackContent } from '@/types/music';

/**
 * The instrument test fixtures put their material on.
 *
 * Tests that predate instruments are all about one part, so they use this single
 * id and read the same way they did when a bar held one flat list. Tests that are
 * *about* multiple instruments pass their own ids instead.
 */
export const TEST_TRACK_ID = 'track-test';

/** A second instrument, for tests that need two parts to stay apart. */
export const OTHER_TRACK_ID = 'track-other';

/** Bar content for one instrument. */
export function content(chords: ChordSegment[] = [], notes: Note[] = []): TrackContent {
  return { chords, notes };
}

/** A bar's `content` map holding a single instrument's material. */
export function soloContent(
  chords: ChordSegment[] = [],
  notes: Note[] = [],
  trackId: string = TEST_TRACK_ID
): Record<string, TrackContent> {
  return { [trackId]: content(chords, notes) };
}
