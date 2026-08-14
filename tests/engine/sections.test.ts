import { describe, it, expect } from 'vitest';
import {
  SECTION_COLORS,
  nextSectionName,
  normalizeSections,
  sectionAtBeat,
  sectionColorAt,
} from '@/engine/sections';
import type { Section } from '@/types/music';

const section = (
  id: string,
  startBeat: number,
  endBeat: number,
  name = id
): Section => ({ id, name, startBeat, endBeat });

describe('sectionColorAt', () => {
  it('cycles through the palette', () => {
    expect(sectionColorAt(0)).toBe(SECTION_COLORS[0]);
    expect(sectionColorAt(SECTION_COLORS.length)).toBe(SECTION_COLORS[0]);
    expect(sectionColorAt(1)).toBe(SECTION_COLORS[1]);
  });
});

describe('normalizeSections', () => {
  it('sorts an out-of-order list by start', () => {
    const result = normalizeSections([section('b', 8, 12), section('a', 0, 4)], 16);
    expect(result.map(s => s.id)).toEqual(['a', 'b']);
  });

  it('clamps a range reaching past the end of the song', () => {
    const result = normalizeSections([section('a', 0, 40)], 16);
    expect(result[0].endBeat).toBe(16);
  });

  it('trims the earlier section back when a later one overlaps it', () => {
    const result = normalizeSections([section('a', 0, 8), section('b', 4, 12)], 16);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'a', startBeat: 0, endBeat: 4 });
    expect(result[1]).toMatchObject({ id: 'b', startBeat: 4, endBeat: 12 });
  });

  it('drops a section trimmed below the minimum length', () => {
    const result = normalizeSections([section('a', 0, 8), section('b', 0.05, 12)], 16);
    expect(result.map(s => s.id)).toEqual(['b']);
  });

  it('preserves a gap between two sections', () => {
    const result = normalizeSections([section('a', 0, 4), section('b', 8, 12)], 16);
    expect(result.map(s => [s.startBeat, s.endBeat])).toEqual([
      [0, 4],
      [8, 12],
    ]);
  });

  it('drops malformed entries rather than failing', () => {
    const raw = [section('a', 0, 4), { id: 'b' }, null, { id: 'c', name: 'c', startBeat: NaN, endBeat: 4 }];
    expect(normalizeSections(raw as Section[], 16).map(s => s.id)).toEqual(['a']);
  });

  it('reads a backwards range as the span between its bounds', () => {
    const result = normalizeSections([section('a', 8, 2)], 16);
    expect(result[0]).toMatchObject({ startBeat: 2, endBeat: 8 });
  });
});

describe('sectionAtBeat', () => {
  const sections = [section('a', 0, 4), section('b', 8, 12)];

  it('is half-open: a boundary beat belongs to the section it opens', () => {
    expect(sectionAtBeat(sections, 0)?.id).toBe('a');
    expect(sectionAtBeat(sections, 3.9)?.id).toBe('a');
    expect(sectionAtBeat(sections, 4)).toBeNull();
    expect(sectionAtBeat(sections, 8)?.id).toBe('b');
  });

  it('returns null in a gap', () => {
    expect(sectionAtBeat(sections, 6)).toBeNull();
  });
});

describe('nextSectionName', () => {
  it('counts up from one', () => {
    expect(nextSectionName([])).toBe('Section 1');
  });

  it('skips names already taken', () => {
    const taken = [section('a', 0, 4, 'Section 1'), section('b', 8, 12, 'Section 2')];
    expect(nextSectionName(taken)).toBe('Section 3');
  });

  it('fills a hole left by a renamed section', () => {
    const taken = [section('a', 0, 4, 'Intro'), section('b', 8, 12, 'Section 1')];
    expect(nextSectionName(taken)).toBe('Section 2');
  });
});
