import type { Bar, Note, Project, TimeSignature, Track } from '@/types/music';
import { generateId } from '@/utils/id';
import { getBarStartBeat, getBarTimeSignature } from '@/engine/timeline';

// ---------------------------------------------------------------------------
// MIDI constants
// ---------------------------------------------------------------------------

/** "MThd" */
const MTHD = [0x4d, 0x54, 0x68, 0x64];
/** "MTrk" */
const MTRK = [0x4d, 0x54, 0x72, 0x6b];

const META = 0xff;
const META_TRACK_NAME = 0x03;
const META_TEMPO = 0x51;
const META_TIME_SIGNATURE = 0x58;
const META_END_OF_TRACK = 0x2f;

const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;

/** Default ticks per quarter note (PPQ). */
const DEFAULT_PPQ = 96;

/** MIDI channel reserved for percussion — skipped when assigning channels. */
const DRUM_CHANNEL = 9;

const MICROSECONDS_PER_MINUTE = 60_000_000;

// ---------------------------------------------------------------------------
// Low-level writer helpers
// ---------------------------------------------------------------------------

/**
 * Encode a number as a MIDI variable-length quantity (7 bits per byte,
 * high bit set on every byte but the last).
 */
function writeVarLen(value: number): number[] {
  if (value < 0 || !Number.isFinite(value)) {
    throw new Error(`Variable-length value must be a non-negative number. Got: ${value}.`);
  }

  let v = Math.floor(value);
  const groups: number[] = [v & 0x7f];
  v >>>= 7;
  while (v > 0) {
    groups.push(0x80 | (v & 0x7f));
    v >>>= 7;
  }

  return groups.reverse();
}

/** Encode a 32-bit unsigned integer, big-endian. */
function writeUint32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** Encode a 16-bit unsigned integer, big-endian. */
function writeUint16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

/** Encode an ASCII string as bytes (non-ASCII characters are dropped). */
function writeAscii(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 0x80) bytes.push(code);
  }
  return bytes;
}

/** An event with an absolute tick position, ready to be delta-encoded. */
interface AbsoluteEvent {
  tick: number;
  /** Lower value sorts first at the same tick (meta before note-off before note-on). */
  order: number;
  data: number[];
}

/**
 * Wrap a list of absolute-time events into an MTrk chunk:
 * "MTrk" + 4-byte length + delta-encoded payload + end-of-track.
 */
function buildTrackChunk(events: AbsoluteEvent[]): number[] {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);

  const payload: number[] = [];
  let lastTick = 0;
  for (const event of sorted) {
    payload.push(...writeVarLen(event.tick - lastTick));
    payload.push(...event.data);
    lastTick = event.tick;
  }

  // End-of-track meta event (required by the spec).
  payload.push(0x00, META, META_END_OF_TRACK, 0x00);

  return [...MTRK, ...writeUint32(payload.length), ...payload];
}

/** Map a track index to a MIDI channel, skipping the percussion channel. */
function channelForTrack(index: number): number {
  const channel = index % 15;
  return channel >= DRUM_CHANNEL ? channel + 1 : channel;
}

// ---------------------------------------------------------------------------
// Export: Project → MIDI bytes
// ---------------------------------------------------------------------------

/**
 * Convert a Project to a Format-1 MIDI file.
 *
 * One MTrk chunk is written per project track; the first chunk also carries the
 * tempo and time-signature meta events. Notes belong to bars rather than tracks
 * in the project model, so all notes are written to the first track.
 */
export function projectToMidi(project: Project): Uint8Array<ArrayBuffer> {
  const ppq = DEFAULT_PPQ;

  // A MIDI file needs at least one track chunk even for a track-less project.
  const trackCount = Math.max(1, project.tracks.length);

  const chunks: number[][] = [];
  for (let t = 0; t < trackCount; t++) {
    const track: Track | undefined = project.tracks[t];
    const events: AbsoluteEvent[] = [];

    events.push({
      tick: 0,
      order: 0,
      data: (() => {
        const name = writeAscii(track?.name ?? `Track ${t + 1}`);
        return [META, META_TRACK_NAME, ...writeVarLen(name.length), ...name];
      })(),
    });

    if (t === 0) {
      const usPerBeat = Math.round(MICROSECONDS_PER_MINUTE / project.bpm);
      events.push({
        tick: 0,
        order: 1,
        data: [
          META, META_TEMPO, 0x03,
          (usPerBeat >>> 16) & 0xff,
          (usPerBeat >>> 8) & 0xff,
          usPerBeat & 0xff,
        ],
      });

      events.push(...timeSignatureEvents(project.bars, project.timeSignature, ppq));
      events.push(...noteEvents(project.bars, project.timeSignature, ppq, channelForTrack(t)));
    }

    chunks.push(buildTrackChunk(events));
  }

  const header = [
    ...MTHD,
    ...writeUint32(6),
    ...writeUint16(1), // Format 1: multiple simultaneous tracks
    ...writeUint16(trackCount),
    ...writeUint16(ppq),
  ];

  const bytes = [header, ...chunks].flat();
  return Uint8Array.from(bytes);
}

/**
 * Build the time-signature meta events for a project.
 *
 * One is always written at tick 0; thereafter a bar contributes an event only
 * when its metre differs from the bar before it, so a uniform project still
 * produces exactly one event.
 */
function timeSignatureEvents(
  bars: Bar[],
  projectTs: TimeSignature,
  ppq: number
): AbsoluteEvent[] {
  const events: AbsoluteEvent[] = [];
  let previous: TimeSignature | null = null;

  const metres = bars.length > 0
    ? bars.map(bar => getBarTimeSignature(bar, projectTs))
    : [projectTs];

  metres.forEach((ts, i) => {
    if (
      previous &&
      previous.beatsPerMeasure === ts.beatsPerMeasure &&
      previous.beatUnit === ts.beatUnit
    ) {
      return;
    }
    previous = ts;

    events.push({
      tick: Math.round(getBarStartBeat(bars, i, projectTs) * ppq),
      order: 2,
      data: [
        META, META_TIME_SIGNATURE, 0x04,
        ts.beatsPerMeasure & 0xff,
        // The denominator is stored as a power of two: 4 → 2, 8 → 3.
        Math.round(Math.log2(ts.beatUnit)) & 0xff,
        24, // MIDI clocks per metronome click
        8,  // 32nd notes per quarter note
      ],
    });
  });

  return events;
}

/** Build note-on/note-off events for every note in every bar. */
function noteEvents(
  bars: Bar[],
  projectTs: TimeSignature,
  ppq: number,
  channel: number
): AbsoluteEvent[] {
  const events: AbsoluteEvent[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    // Bars may each be in their own metre, so accumulate rather than multiply.
    const barStartTick = Math.round(getBarStartBeat(bars, i, projectTs) * ppq);
    for (const note of bar.notes) {
      const startTick = barStartTick + Math.round(note.startBeat * ppq);
      // Zero-length notes would produce a note-off before the note-on is heard.
      const durationTicks = Math.max(1, Math.round(note.duration * ppq));

      events.push({
        tick: startTick,
        order: 4,
        data: [NOTE_ON | channel, note.pitch & 0x7f, clampVelocity(note.velocity)],
      });
      events.push({
        tick: startTick + durationTicks,
        order: 3, // note-off before note-on when they coincide
        data: [NOTE_OFF | channel, note.pitch & 0x7f, 0x00],
      });
    }
  }

  return events;
}

function clampVelocity(velocity: number): number {
  if (!Number.isFinite(velocity)) return 64;
  return Math.min(127, Math.max(1, Math.round(velocity)));
}

// ---------------------------------------------------------------------------
// Import: MIDI bytes → Project
// ---------------------------------------------------------------------------

/** A single parsed MIDI event with an absolute tick position. */
interface ParsedEvent {
  tick: number;
  status: number;
  /** Meta event type, present only when `status` is 0xFF. */
  metaType?: number;
  /** Event payload, excluding the status/meta-type bytes. */
  data: number[];
}

/**
 * Parse a Format-0 or Format-1 MIDI file into a Project.
 * Throws a descriptive error when the bytes are not a readable MIDI file.
 */
export function midiToProject(midiBytes: Uint8Array): Project {
  if (midiBytes.length < 14 || readAscii(midiBytes, 0, 4) !== 'MThd') {
    throw new Error('Invalid MIDI file: missing MThd header.');
  }

  const headerLength = readUint32(midiBytes, 4);
  const format = readUint16(midiBytes, 8);
  const declaredTracks = readUint16(midiBytes, 10);
  const division = readUint16(midiBytes, 12);

  if (format !== 0 && format !== 1) {
    throw new Error(`Unsupported MIDI format: ${format}. Only Format 0 and 1 are supported.`);
  }
  if (division & 0x8000) {
    throw new Error('Unsupported MIDI file: SMPTE time division is not supported.');
  }
  if (division === 0) {
    throw new Error('Invalid MIDI file: ticks per quarter note is zero.');
  }

  // Read every MTrk chunk. Trailing/unknown chunks are skipped per the spec.
  const trackEvents: ParsedEvent[][] = [];
  let offset = 8 + headerLength;
  while (offset + 8 <= midiBytes.length) {
    const chunkType = readAscii(midiBytes, offset, 4);
    const chunkLength = readUint32(midiBytes, offset + 4);
    const body = midiBytes.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 'MTrk') {
      trackEvents.push(parseTrackEvents(body));
    }
    offset += 8 + chunkLength;
  }

  if (trackEvents.length === 0) {
    throw new Error('Invalid MIDI file: no MTrk track chunks found.');
  }
  if (trackEvents.length < declaredTracks) {
    // Truncated files are readable; the header count is only advisory here.
    console.warn(`MIDI header declares ${declaredTracks} tracks but ${trackEvents.length} were found.`);
  }

  const allEvents = trackEvents.flat();

  const bpm = readTempo(allEvents);
  const timeSignature = readTimeSignature(allEvents);
  const notes = readNotes(trackEvents, division);

  return {
    id: generateId(),
    name: readTrackName(trackEvents[0]) ?? 'Imported MIDI',
    bpm,
    timeSignature,
    key: 'C',
    keyMode: 'major',
    tracks: trackEvents.map((events, i) => ({
      id: generateId(),
      name: readTrackName(events) ?? `Track ${i + 1}`,
      instrument: 'acoustic_grand_piano',
      volume: 0.8,
      pan: 0,
      muted: false,
      solo: false,
    })),
    bars: notesToBars(notes, timeSignature.beatsPerMeasure),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Read the tempo meta event, defaulting to 120 BPM when absent. */
function readTempo(events: ParsedEvent[]): number {
  for (const event of events) {
    if (event.status === META && event.metaType === META_TEMPO && event.data.length >= 3) {
      const usPerBeat = (event.data[0] << 16) | (event.data[1] << 8) | event.data[2];
      if (usPerBeat > 0) return Math.round(MICROSECONDS_PER_MINUTE / usPerBeat);
    }
  }
  return 120;
}

/** Read the time-signature meta event, defaulting to 4/4 when absent. */
function readTimeSignature(events: ParsedEvent[]): { beatsPerMeasure: number; beatUnit: number } {
  for (const event of events) {
    if (event.status === META && event.metaType === META_TIME_SIGNATURE && event.data.length >= 2) {
      return {
        beatsPerMeasure: event.data[0],
        beatUnit: Math.pow(2, event.data[1]),
      };
    }
  }
  return { beatsPerMeasure: 4, beatUnit: 4 };
}

/** Read the first track-name meta event of a track, if any. */
function readTrackName(events: ParsedEvent[]): string | null {
  for (const event of events) {
    if (event.status === META && event.metaType === META_TRACK_NAME && event.data.length > 0) {
      return String.fromCharCode(...event.data);
    }
  }
  return null;
}

/** Pair note-on/note-off events into notes with beat-based timing. */
function readNotes(trackEvents: ParsedEvent[][], ppq: number): Note[] {
  const notes: Note[] = [];

  for (const events of trackEvents) {
    // Notes are matched per channel+pitch so overlapping tracks don't collide.
    const pending = new Map<number, { velocity: number; startTick: number }[]>();

    for (const event of events) {
      const type = event.status & 0xf0;
      if (type !== NOTE_ON && type !== NOTE_OFF) continue;

      const [pitch, velocity] = event.data;
      const key = ((event.status & 0x0f) << 8) | pitch;

      if (type === NOTE_ON && velocity > 0) {
        const queue = pending.get(key) ?? [];
        queue.push({ velocity, startTick: event.tick });
        pending.set(key, queue);
        continue;
      }

      // Note-off, or note-on with velocity 0 (the common running-status idiom).
      const started = pending.get(key)?.shift();
      if (!started) continue;
      notes.push({
        id: generateId(),
        pitch,
        startBeat: started.startTick / ppq,
        duration: Math.max(0, event.tick - started.startTick) / ppq,
        velocity: started.velocity,
      });
    }
  }

  return notes.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
}

/** Distribute notes into bars, converting absolute beats to bar-relative beats. */
function notesToBars(notes: Note[], beatsPerMeasure: number): Bar[] {
  const lastBeat = notes.reduce((max, n) => Math.max(max, n.startBeat), 0);
  const barCount = Math.max(1, Math.floor(lastBeat / beatsPerMeasure) + 1);

  const bars: Bar[] = Array.from({ length: barCount }, (_, barIndex) => ({
    id: generateId(),
    barIndex,
    scale: { root: 'C', type: 'major' },
    chords: [],
    notes: [],
  }));

  for (const note of notes) {
    const barIndex = Math.min(barCount - 1, Math.floor(note.startBeat / beatsPerMeasure));
    bars[barIndex].notes.push({
      ...note,
      startBeat: note.startBeat - barIndex * beatsPerMeasure,
    });
  }

  return bars;
}

// ---------------------------------------------------------------------------
// Low-level reader helpers
// ---------------------------------------------------------------------------

function readUint32(data: Uint8Array, offset: number): number {
  return (
    data[offset] * 0x1000000 +
    (data[offset + 1] << 16) +
    (data[offset + 2] << 8) +
    data[offset + 3]
  );
}

function readUint16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readAscii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

interface VarLenResult {
  value: number;
  bytesRead: number;
}

function readVarLenAt(data: Uint8Array, offset: number): VarLenResult {
  let value = 0;
  let bytesRead = 0;

  while (offset + bytesRead < data.length) {
    const byte = data[offset + bytesRead];
    bytesRead++;
    value = value * 128 + (byte & 0x7f);
    if (byte < 0x80) break;
  }

  return { value, bytesRead };
}

/**
 * Parse the body of an MTrk chunk into absolute-time events.
 * Handles running status, meta events and SysEx.
 */
function parseTrackEvents(trackData: Uint8Array): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let offset = 0;
  let tick = 0;
  let runningStatus = 0;

  while (offset < trackData.length) {
    const delta = readVarLenAt(trackData, offset);
    offset += delta.bytesRead;
    tick += delta.value;

    if (offset >= trackData.length) break;

    let status = trackData[offset];
    if (status < 0x80) {
      // Running status: reuse the previous status byte, this byte is data.
      if (runningStatus === 0) break;
      status = runningStatus;
    } else {
      offset++;
      if (status < 0xf0) runningStatus = status;
    }

    if (status === META) {
      if (offset >= trackData.length) break;
      const metaType = trackData[offset];
      offset++;
      const length = readVarLenAt(trackData, offset);
      offset += length.bytesRead;
      if (offset + length.value > trackData.length) break;
      events.push({
        tick,
        status,
        metaType,
        data: Array.from(trackData.subarray(offset, offset + length.value)),
      });
      offset += length.value;
      if (metaType === META_END_OF_TRACK) break;
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const length = readVarLenAt(trackData, offset);
      offset += length.bytesRead;
      if (offset + length.value > trackData.length) break;
      events.push({
        tick,
        status,
        data: Array.from(trackData.subarray(offset, offset + length.value)),
      });
      offset += length.value;
      continue;
    }

    const dataLength = channelEventDataLength(status);
    if (dataLength === 0 || offset + dataLength > trackData.length) break;
    events.push({
      tick,
      status,
      data: Array.from(trackData.subarray(offset, offset + dataLength)),
    });
    offset += dataLength;
  }

  return events;
}

/** Number of data bytes following a channel-voice status byte. */
function channelEventDataLength(status: number): number {
  switch (status & 0xf0) {
    case 0x80: // note off
    case 0x90: // note on
    case 0xa0: // polyphonic aftertouch
    case 0xb0: // control change
    case 0xe0: // pitch bend
      return 2;
    case 0xc0: // program change
    case 0xd0: // channel aftertouch
      return 1;
    default:
      return 0;
  }
}
