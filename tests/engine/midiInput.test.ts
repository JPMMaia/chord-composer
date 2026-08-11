import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseMidiMessage, openMidiInputs } from '@/engine/midiInput';
import type { MidiInputStatus, MidiNoteEvent } from '@/engine/midiInput';

/** A channel-voice message: status nibble, channel, and two data bytes. */
const message = (status: number, channel: number, a: number, b: number) =>
  new Uint8Array([status | channel, a, b]);

/** A stand-in for one MIDI port, with a handle to push messages through it. */
function fakeInput(name: string) {
  const input = {
    name,
    onmidimessage: null as ((e: { data: Uint8Array }) => void) | null,
  };
  return {
    input,
    /** Deliver a message as the browser would. */
    send: (data: Uint8Array) => input.onmidimessage?.({ data }),
  };
}

/**
 * Install a fake `navigator.requestMIDIAccess`, and return the access object so a
 * test can add ports and fire state changes.
 */
function fakeMidiAccess(names: string[] = ['Test Keyboard']) {
  const ports = names.map(fakeInput);
  const access = {
    inputs: new Map(ports.map((p, i) => [`port-${i}`, p.input])),
    onstatechange: null as (() => void) | null,
  };

  Object.defineProperty(navigator, 'requestMIDIAccess', {
    value: vi.fn().mockResolvedValue(access),
    configurable: true,
    writable: true,
  });

  return { access, ports };
}

afterEach(() => {
  // Leaving a stub on the shared navigator would follow the next test file in.
  Reflect.deleteProperty(navigator, 'requestMIDIAccess');
  vi.restoreAllMocks();
});

describe('parseMidiMessage', () => {
  it('reads a note-on', () => {
    expect(parseMidiMessage(message(0x90, 0, 60, 100))).toEqual({
      type: 'noteOn',
      note: 60,
      velocity: 100,
    });
  });

  it('reads a note-off', () => {
    expect(parseMidiMessage(message(0x80, 0, 60, 64))).toEqual({
      type: 'noteOff',
      note: 60,
      velocity: 64,
    });
  });

  it('reads a note-on with zero velocity as a note-off', () => {
    // The form most keyboards actually send. Read as a note-on it would leave
    // every key ringing for as long as the app is open.
    expect(parseMidiMessage(message(0x90, 0, 60, 0))).toEqual({
      type: 'noteOff',
      note: 60,
      velocity: 0,
    });
  });

  it('ignores the channel', () => {
    for (const channel of [0, 3, 9, 15]) {
      expect(parseMidiMessage(message(0x90, channel, 60, 100))?.type).toBe('noteOn');
    }
  });

  it('drops everything that is not a note', () => {
    // Control change, program change, pitch bend, aftertouch, clock, active sensing.
    expect(parseMidiMessage(message(0xb0, 0, 64, 127))).toBeNull();
    expect(parseMidiMessage(message(0xc0, 0, 5, 0))).toBeNull();
    expect(parseMidiMessage(message(0xe0, 0, 0, 64))).toBeNull();
    expect(parseMidiMessage(message(0xa0, 0, 60, 80))).toBeNull();
    expect(parseMidiMessage(new Uint8Array([0xf8]))).toBeNull();
    expect(parseMidiMessage(new Uint8Array([0xfe]))).toBeNull();
  });

  it('drops a message too short to be a note', () => {
    expect(parseMidiMessage(new Uint8Array([0x90, 60]))).toBeNull();
    expect(parseMidiMessage(new Uint8Array([]))).toBeNull();
  });
});

describe('openMidiInputs', () => {
  /** Let the access promise settle. */
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('delivers note events from every attached input', async () => {
    const { ports } = fakeMidiAccess(['Keyboard A', 'Keyboard B']);
    const events: MidiNoteEvent[] = [];

    openMidiInputs({ onEvent: e => events.push(e) });
    await settle();

    ports[0].send(message(0x90, 0, 60, 100));
    ports[1].send(message(0x90, 0, 67, 80));

    expect(events).toEqual([
      { type: 'noteOn', note: 60, velocity: 100 },
      { type: 'noteOn', note: 67, velocity: 80 },
    ]);
  });

  it('reports the inputs it found', async () => {
    fakeMidiAccess(['Keyboard A', 'Keyboard B']);
    const statuses: MidiInputStatus[] = [];

    openMidiInputs({ onEvent: () => {}, onStatus: s => statuses.push(s) });
    await settle();

    expect(statuses.at(-1)).toEqual({
      support: 'ok',
      inputs: ['Keyboard A', 'Keyboard B'],
    });
  });

  it('picks up a keyboard plugged in later', async () => {
    const { access } = fakeMidiAccess([]);
    const events: MidiNoteEvent[] = [];
    const statuses: MidiInputStatus[] = [];

    openMidiInputs({ onEvent: e => events.push(e), onStatus: s => statuses.push(s) });
    await settle();
    expect(statuses.at(-1)?.inputs).toEqual([]);

    const late = fakeInput('Latecomer');
    access.inputs.set('port-late', late.input);
    access.onstatechange?.();

    expect(statuses.at(-1)?.inputs).toEqual(['Latecomer']);
    late.send(message(0x90, 0, 62, 90));
    expect(events).toEqual([{ type: 'noteOn', note: 62, velocity: 90 }]);
  });

  it('stops listening when disposed', async () => {
    const { ports } = fakeMidiAccess();
    const events: MidiNoteEvent[] = [];

    const close = openMidiInputs({ onEvent: e => events.push(e) });
    await settle();
    close();

    ports[0].send(message(0x90, 0, 60, 100));
    expect(events).toEqual([]);
  });

  it('attaches nothing when disposed before access is granted', async () => {
    const { ports } = fakeMidiAccess();
    const events: MidiNoteEvent[] = [];

    // Disposed while the permission prompt is still up — the case a component
    // unmounting mid-request produces, and the one that leaks a live port.
    const close = openMidiInputs({ onEvent: e => events.push(e) });
    close();
    await settle();

    ports[0].send(message(0x90, 0, 60, 100));
    expect(events).toEqual([]);
  });

  it('reports a browser with no Web MIDI at all', () => {
    Reflect.deleteProperty(navigator, 'requestMIDIAccess');
    const statuses: MidiInputStatus[] = [];

    openMidiInputs({ onEvent: () => {}, onStatus: s => statuses.push(s) });

    expect(statuses).toEqual([{ support: 'unsupported', inputs: [] }]);
  });

  it('reports a refused permission rather than throwing', async () => {
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      value: vi.fn().mockRejectedValue(new Error('NotAllowedError')),
      configurable: true,
      writable: true,
    });
    const statuses: MidiInputStatus[] = [];

    openMidiInputs({ onEvent: () => {}, onStatus: s => statuses.push(s) });
    await settle();

    expect(statuses).toEqual([{ support: 'denied', inputs: [] }]);
  });
});
