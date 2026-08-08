import { describe, it, expect } from 'vitest';
import { projectToMusicXML } from '@/engine/musicxmlExporter';
import { Project, Bar } from '@/types/music';
import { generateId } from '@/utils/id';
import { soloContent, TEST_TRACK_ID } from '../helpers/tracks';

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
        // Matches the key `soloContent` writes, so the exporter's per-instrument
        // lookup finds this fixture's music.
        id: TEST_TRACK_ID,
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
        content: soloContent([
          { id: generateId(), romanNumeral: 'I', chordSymbol: 'C', duration: 2, root: 'C', quality: 'major' },
          { id: generateId(), romanNumeral: 'V', chordSymbol: 'G', duration: 2, root: 'G', quality: 'major' },
        ], [
          { id: generateId(), pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
          { id: generateId(), pitch: 64, startBeat: 1, duration: 1, velocity: 90 },
          { id: generateId(), pitch: 67, startBeat: 2, duration: 2, velocity: 85 },
        ]),
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
            content: soloContent([{ id: generateId(), romanNumeral: 'I', chordSymbol: 'C', duration: 4, root: 'C', quality: 'major' }], [
              { id: generateId(), pitch: 60, startBeat: 0, duration: 2, velocity: 100 },
              { id: generateId(), pitch: 64, startBeat: 2, duration: 2, velocity: 90 },
            ]),
          },
          {
            id: generateId(),
            barIndex: 1,
            content: soloContent([{ id: generateId(), romanNumeral: 'V', chordSymbol: 'G', duration: 4, root: 'G', quality: 'major' }], [
              { id: generateId(), pitch: 67, startBeat: 0, duration: 2, velocity: 100 },
              { id: generateId(), pitch: 71, startBeat: 2, duration: 2, velocity: 85 },
            ]),
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
          content: soloContent([{ id: generateId(), romanNumeral: 'I', chordSymbol: 'C', duration: 4, root: 'C', quality: 'major' }], []),
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
          content: soloContent([], [
            { id: generateId(), pitch: 60, startBeat: 0, duration: 1, velocity: 100 }, // C4
            { id: generateId(), pitch: 63, startBeat: 1, duration: 1, velocity: 90 },  // Db4
          ]),
        }],
      });
      const xml = projectToMusicXML(project);

      expect(xml).toContain('<step>C</step>');
      expect(xml).toContain('<alter>-1</alter>'); // Db = C with -1 alteration
    });
  });

  describe('per-bar time signatures', () => {
    const emptyBar = (
      barIndex: number,
      timeSignature?: { beatsPerMeasure: number; beatUnit: number }
    ): Bar => ({
      id: generateId(),
      barIndex,
      timeSignature,
      content: soloContent([], []),
    });

    /** The `<beats>` values in document order, one per emitted `<time>`. */
    function timeElements(xml: string): string[] {
      return Array.from(xml.matchAll(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)<\/beat-type>/g)).map(
        m => `${m[1]}/${m[2]}`
      );
    }

    it('writes the meter once when no bar changes it', () => {
      const project = createTestProject({ bars: [emptyBar(0), emptyBar(1), emptyBar(2)] });
      expect(timeElements(projectToMusicXML(project))).toEqual(['4/4']);
    });

    it('writes a new <time> at each measure whose meter changes', () => {
      const project = createTestProject({
        bars: [
          emptyBar(0, { beatsPerMeasure: 4, beatUnit: 4 }),
          emptyBar(1, { beatsPerMeasure: 3, beatUnit: 4 }),
          emptyBar(2, { beatsPerMeasure: 3, beatUnit: 4 }),
          emptyBar(3, { beatsPerMeasure: 6, beatUnit: 8 }),
        ],
      });
      // Measure 3 repeats measure 2's meter and so restates nothing.
      expect(timeElements(projectToMusicXML(project))).toEqual(['4/4', '3/4', '6/8']);
    });

    it('takes the first measure meter from the bar, not just the project', () => {
      const project = createTestProject({
        bars: [emptyBar(0, { beatsPerMeasure: 5, beatUnit: 4 })],
      });
      expect(timeElements(projectToMusicXML(project))).toEqual(['5/4']);
    });

    it('sizes a measure rest to that bar own length', () => {
      const project = createTestProject({
        bars: [emptyBar(0, { beatsPerMeasure: 3, beatUnit: 4 })],
      });
      const xml = projectToMusicXML(project);

      // 3 beats × 8 divisions per beat.
      expect(xml).toContain('<rest measure="yes"/>\n        <duration>24</duration>');
    });
  });

  describe('silence between blocks', () => {
    it('writes a rest for the empty beats before a note', () => {
      const project = createTestProject({
        bars: [
          {
            id: generateId(),
            barIndex: 0,
            content: soloContent([], [
              { id: generateId(), pitch: 60, startBeat: 2, duration: 1, velocity: 100 },
            ]),
          },
        ],
      });
      const xml = projectToMusicXML(project);

      // Two beats of rest, the note, then a beat of rest to close the measure.
      expect(xml).toContain('<rest/>\n        <duration>16</duration>');
      expect(xml).toContain('<rest/>\n        <duration>8</duration>');
    });

    it('writes a rest for a hole between two notes', () => {
      const project = createTestProject({
        bars: [
          {
            id: generateId(),
            barIndex: 0,
            content: soloContent([], [
              { id: generateId(), pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
              { id: generateId(), pitch: 67, startBeat: 3, duration: 1, velocity: 100 },
            ]),
          },
        ],
      });

      // The two beats between them are silence, not a held chord.
      expect(projectToMusicXML(project)).toContain('<rest/>\n        <duration>16</duration>');
    });
  });

  // A segment on the timeline may run past its bar line. Notation cannot write a
  // note through one, so it is cut at the line and tied to a continuation — which
  // is what a reader plays as one held chord.
  describe('notes held across a bar line', () => {
    /** Bar `index`, holding one note of `duration` beats starting at `startBeat`. */
    const barWithNote = (index: number, startBeat: number, duration: number): Bar => ({
      id: generateId(),
      barIndex: index,
      content: soloContent([], [
        { id: generateId(), pitch: 60, startBeat, duration, velocity: 100 },
      ]),
    });

    /** A bar the held note rings into, carrying nothing of its own. */
    const restBar = (index: number): Bar => ({
      id: generateId(),
      barIndex: index,
      content: soloContent([], []),
    });

    /** Every `<measure>` element of the first part, in order. */
    const measures = (xml: string): string[] => xml.split('<measure ').slice(1);

    it('cuts the note at the bar line and ties it into the next measure', () => {
      // Starts on beat 3 of a 4/4 bar and rings for three beats: one beat here,
      // two in the measure after.
      const project = createTestProject({
        bars: [barWithNote(0, 3, 3), restBar(1)],
      });
      const [first, second] = measures(projectToMusicXML(project));

      expect(first).toContain('<duration>8</duration>\n        <tie type="start"/>');
      expect(first).toContain('<tied type="start"/>');
      expect(second).toContain('<duration>16</duration>');
      expect(second).toContain('<tie type="stop"/>');
      expect(second).toContain('<tied type="stop"/>');
    });

    it('keeps every measure adding up to its own length', () => {
      const project = createTestProject({
        bars: [barWithNote(0, 3, 3), restBar(1)],
      });
      const total = (measure: string) =>
        [...measure.matchAll(/<duration>(\d+)<\/duration>/g)]
          .reduce((sum, m) => sum + Number(m[1]), 0);

      // 4 beats × 8 divisions, in both — the first as 3 beats of rest plus the cut
      // note, the second as the 2-beat tail plus 2 beats of rest.
      for (const measure of measures(projectToMusicXML(project))) {
        expect(total(measure)).toBe(32);
      }
    });

    it('ties on through a measure the note spans entirely', () => {
      // Eight beats from beat 2 of bar 1: two here, four filling bar 2, two in bar 3.
      const project = createTestProject({
        bars: [barWithNote(0, 2, 8), restBar(1), restBar(2)],
      });
      const [, second, third] = measures(projectToMusicXML(project));

      // The middle measure is nothing but the held note: tied at both ends, no rest.
      expect(second).toContain('<tie type="stop"/>\n        <tie type="start"/>');
      expect(second).not.toContain('<rest');
      expect(third).toContain('<tie type="stop"/>');
      expect(third).not.toContain('<tie type="start"/>');
    });

    it('leaves a note that ends on the bar line untied', () => {
      const project = createTestProject({
        bars: [barWithNote(0, 2, 2), restBar(1)],
      });
      expect(projectToMusicXML(project)).not.toContain('<tie ');
    });
  });

  describe('broken chords', () => {
    /** A bar holding exactly these notes, for the one fixture instrument. */
    const barOfNotes = (notes: { pitch: number; startBeat: number; duration: number }[]): Bar => ({
      id: generateId(),
      barIndex: 0,
      content: soloContent(
        [],
        notes.map(n => ({ id: generateId(), velocity: 100, ...n }))
      ),
    });

    // Notation has no way to write "strummed", and the thing on the page is
    // still a chord — not three hair-thin notes preceded by a rest.
    it('writes a strummed chord as one chord', () => {
      const xml = projectToMusicXML(
        createTestProject({
          bars: [
            barOfNotes([
              { pitch: 60, startBeat: 0, duration: 4 },
              { pitch: 64, startBeat: 0.0625, duration: 3.9375 },
              { pitch: 67, startBeat: 0.125, duration: 3.875 },
            ]),
          ],
        })
      );

      // Two of the three are chord members, and the group spans the whole bar.
      expect(xml.match(/<chord\/>/g)).toHaveLength(2);
      expect(xml).toContain('<duration>32</duration>');
      expect(xml).not.toContain('<rest/>');
    });

    it('writes an arpeggio as separate notes, not a chord', () => {
      const xml = projectToMusicXML(
        createTestProject({
          bars: [
            barOfNotes([
              { pitch: 60, startBeat: 0, duration: 1 },
              { pitch: 64, startBeat: 1, duration: 1 },
              { pitch: 67, startBeat: 2, duration: 1 },
              { pitch: 72, startBeat: 3, duration: 1 },
            ]),
          ],
        })
      );

      expect(xml).not.toContain('<chord/>');
      expect(xml.match(/<duration>8<\/duration>/g)).toHaveLength(4);
    });

    // The tolerance has to be narrow enough that genuinely fast writing still
    // reads as separate notes rather than being swallowed into one chord.
    it('gathers the widest strum a four-note chord can carry', () => {
      // 1/16 beat is the widest spread the inspector offers; four voices put
      // the last onset 3/16 of a beat late, which must still read as one chord.
      const xml = projectToMusicXML(
        createTestProject({
          bars: [
            barOfNotes([
              { pitch: 60, startBeat: 0, duration: 4 },
              { pitch: 64, startBeat: 0.0625, duration: 3.9375 },
              { pitch: 67, startBeat: 0.125, duration: 3.875 },
              { pitch: 70, startBeat: 0.1875, duration: 3.8125 },
            ]),
          ],
        })
      );

      expect(xml.match(/<chord\/>/g)).toHaveLength(3);
      expect(xml).not.toContain('<rest/>');
    });

    it('keeps sixteenth notes apart', () => {
      const xml = projectToMusicXML(
        createTestProject({
          bars: [
            barOfNotes([
              { pitch: 60, startBeat: 0, duration: 0.25 },
              { pitch: 64, startBeat: 0.25, duration: 0.25 },
            ]),
          ],
        })
      );

      expect(xml).not.toContain('<chord/>');
    });
  });

  describe('thirty-second notes', () => {
    const barOfNotes = (notes: { pitch: number; startBeat: number; duration: number }[]): Bar => ({
      id: generateId(),
      barIndex: 0,
      content: soloContent(
        [],
        notes.map(n => ({ id: generateId(), velocity: 100, ...n }))
      ),
    });

    it('writes a thirty-second as one division without rounding it up', () => {
      const xml = projectToMusicXML(
        createTestProject({
          bars: [
            barOfNotes([
              { pitch: 60, startBeat: 0, duration: 0.125 },
              { pitch: 62, startBeat: 0.125, duration: 0.125 },
            ]),
          ],
        })
      );

      expect(xml).toContain('<divisions>8</divisions>');
      expect(xml.match(/<duration>1<\/duration>/g)).toHaveLength(2);
      expect(xml).toContain('<type>32nd</type>');
    });

    it('keeps a bar of thirty-seconds adding up to its own length', () => {
      const notes = Array.from({ length: 32 }, (_, i) => ({
        pitch: 60,
        startBeat: i * 0.125,
        duration: 0.125,
      }));
      const xml = projectToMusicXML(createTestProject({ bars: [barOfNotes(notes)] }));

      const total = [...xml.matchAll(/<duration>(\d+)<\/duration>/g)].reduce(
        (sum, m) => sum + Number(m[1]),
        0
      );
      // 4 beats × 8 divisions, with no rests needed to pad the measure out.
      expect(total).toBe(32);
      expect(xml).not.toContain('<rest/>');
    });
  });
});
