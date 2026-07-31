import { describe, it, expect } from 'vitest';
import { projectToMusicXML } from '@/engine/musicxmlExporter';
import { Project, Bar } from '@/types/music';
import { generateId } from '@/utils/id';

function createTestProject(overrides?: Partial<Project>): Project {
  const now = new Date('2024-01-01T00:00:00.000Z');
  return {
    id: generateId(),
    name: 'Test Project',
    bpm: 120,
    timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
    key: 'C',
    keyMode: 'major',
    tracks: [
      {
        id: generateId(),
        name: 'Piano',
        instrument: 'acoustic_grand_piano',
        volume: 0.8,
        pan: 0,
        muted: false,
        solo: false,
      },
    ],
    bars: [
      {
        id: generateId(),
        barIndex: 0,
        scale: { root: 'C', type: 'major' },
        chords: [
          { id: generateId(), romanNumeral: 'I', chordSymbol: 'C', duration: 2, root: 'C', quality: 'major' },
          { id: generateId(), romanNumeral: 'V', chordSymbol: 'G', duration: 2, root: 'G', quality: 'major' },
        ],
        notes: [
          { id: generateId(), pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
          { id: generateId(), pitch: 64, startBeat: 1, duration: 1, velocity: 90 },
          { id: generateId(), pitch: 67, startBeat: 2, duration: 2, velocity: 85 },
        ],
      },
    ],
    createdAt: now,
    updatedAt: new Date('2024-01-01T00:01:00.000Z'),
    ...overrides,
  };
}

describe('musicxmlExporter', () => {
  describe('projectToMusicXML', () => {
    it('exports a project to MusicXML string', () => {
      const project = createTestProject();
      const xml = projectToMusicXML(project);

      expect(xml).toBeString();
      expect(xml).toContain('<?xml version');
      expect(xml).toContain('<score-partwise');
    });

    it('creates one part per track', () => {
      const project = createTestProject({
        tracks: [
          { id: generateId(), name: 'Piano', instrument: 'piano', volume: 0.8, pan: 0, muted: false, solo: false },
          { id: generateId(), name: 'Bass', instrument: 'bass', volume: 0.7, pan: 0, muted: false, solo: false },
        ],
      });
      const xml = projectToMusicXML(project);

      // Count part elements (the part-list holds score-part entries, not parts)
      const partCount = (xml.match(/<part id=/g) || []).length;
      expect(partCount).toBe(2);
      expect((xml.match(/<score-part id=/g) || []).length).toBe(2);
    });

    it('writes chord symbols as harmony tags', () => {
      const project = createTestProject();
      const xml = projectToMusicXML(project);

      expect(xml).toContain('<harmony');
      expect(xml).toContain('<root>');
      expect(xml).toContain('<root-step>C</root-step>');
      expect(xml).toContain('<kind text="major">major</kind>');
    });

    it('writes notes as standard notation', () => {
      const project = createTestProject();
      const xml = projectToMusicXML(project);

      expect(xml).toContain('<note>');
      expect(xml).toContain('<pitch>');
      expect(xml).toContain('<step>C</step>');
      expect(xml).toContain('<duration>');
      expect(xml).toContain('<type>');
    });

    it('includes time signature', () => {
      const project = createTestProject();
      const xml = projectToMusicXML(project);

      expect(xml).toContain('<time>');
      expect(xml).toContain('<beats>4</beats>');
      expect(xml).toContain('<beat-type>4</beat-type>');
    });

    it('includes key signature', () => {
      const project = createTestProject();
      const xml = projectToMusicXML(project);

      expect(xml).toContain('<key>');
      expect(xml).toContain('<fifths>0</fifths>'); // C major = 0 sharps/flats
      expect(xml).toContain('<mode>major</mode>');
    });

    it('handles project with multiple bars', () => {
      const project = createTestProject({
        bars: [
          {
            id: generateId(),
            barIndex: 0,
            scale: { root: 'C', type: 'major' },
            chords: [{ id: generateId(), romanNumeral: 'I', chordSymbol: 'C', duration: 4, root: 'C', quality: 'major' }],
            notes: [
              { id: generateId(), pitch: 60, startBeat: 0, duration: 2, velocity: 100 },
              { id: generateId(), pitch: 64, startBeat: 2, duration: 2, velocity: 90 },
            ],
          },
          {
            id: generateId(),
            barIndex: 1,
            scale: { root: 'C', type: 'major' },
            chords: [{ id: generateId(), romanNumeral: 'V', chordSymbol: 'G', duration: 4, root: 'G', quality: 'major' }],
            notes: [
              { id: generateId(), pitch: 67, startBeat: 0, duration: 2, velocity: 100 },
              { id: generateId(), pitch: 71, startBeat: 2, duration: 2, velocity: 85 },
            ],
          },
        ],
      });
      const xml = projectToMusicXML(project);

      // Should have measure elements for each bar
      const measureCount = (xml.match(/<measure/g) || []).length;
      expect(measureCount).toBe(2);
    });

    it('handles project with no notes', () => {
      const project = createTestProject({
        bars: [{
          id: generateId(),
          barIndex: 0,
          scale: { root: 'C', type: 'major' },
          chords: [{ id: generateId(), romanNumeral: 'I', chordSymbol: 'C', duration: 4, root: 'C', quality: 'major' }],
          notes: [],
        }],
      });
      const xml = projectToMusicXML(project);

      expect(xml).toContain('<note>');
      // Chord should still appear as harmony
      expect(xml).toContain('<harmony>');
    });

    it('handles project with no tracks', () => {
      const project = createTestProject({ tracks: [] });
      const xml = projectToMusicXML(project);

      expect(xml).toBeString();
      expect(xml).toContain('<?xml version');
    });

    it('handles minor key signature', () => {
      const project = createTestProject({ keyMode: 'minor', key: 'A' });
      const xml = projectToMusicXML(project);

      expect(xml).toContain('<mode>minor</mode>');
      // A minor has 0 sharps/flats (same as C major)
      expect(xml).toContain('<fifths>0</fifths>');
    });

    it('handles sharp key signatures correctly', () => {
      const project = createTestProject({ keyMode: 'major', key: 'G' });
      const xml = projectToMusicXML(project);

      expect(xml).toContain('<fifths>1</fifths>'); // G major = 1 sharp
    });

    it('handles flat key signatures correctly', () => {
      const project = createTestProject({ keyMode: 'major', key: 'F' });
      const xml = projectToMusicXML(project);

      expect(xml).toContain('<fifths>-1</fifths>'); // F major = 1 flat
    });

    it('produces valid XML structure', () => {
      const project = createTestProject();
      const xml = projectToMusicXML(project);

      // Check basic XML well-formedness
      expect(xml.startsWith('<?xml')).toBe(true);
      expect(xml.includes('</score-partwise>')).toBe(true);
      expect(xml.includes('</part>')).toBe(true);
      expect(xml.includes('</measure>')).toBe(true);
    });

    it('includes work title from project name', () => {
      const project = createTestProject({ name: 'My Beautiful Song' });
      const xml = projectToMusicXML(project);

      expect(xml).toContain('My Beautiful Song');
    });

    it('encodes notes with correct pitch names', () => {
      const project = createTestProject({
        bars: [{
          id: generateId(),
          barIndex: 0,
          scale: { root: 'C', type: 'major' },
          chords: [],
          notes: [
            { id: generateId(), pitch: 60, startBeat: 0, duration: 1, velocity: 100 }, // C4
            { id: generateId(), pitch: 63, startBeat: 1, duration: 1, velocity: 90 },  // Db4
          ],
        }],
      });
      const xml = projectToMusicXML(project);

      expect(xml).toContain('<step>C</step>');
      expect(xml).toContain('<alter>-1</alter>'); // Db = C with -1 alteration
    });
  });
});
