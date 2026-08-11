/**
 * The seam between a MIDI keyboard and the rest of the app.
 *
 * Deliberately narrow: this module turns a stream of bytes from the Web MIDI API
 * into note-ons and note-offs and says nothing about what should happen to them.
 * No React, no stores, no project types — which is what lets the parsing half be
 * tested exhaustively without a keyboard, and what would let a native MIDI backend
 * replace `openMidiInputs` without anything downstream noticing.
 */

/** A key going down or coming up on a MIDI keyboard. */
export interface MidiNoteEvent {
  type: 'noteOn' | 'noteOff';
  /** MIDI pitch, 0-127. */
  note: number;
  /** MIDI velocity, 0-127. On a note-off this is the release velocity. */
  velocity: number;
}

/** Whether MIDI input is available at all, and what is plugged in. */
export interface MidiInputStatus {
  /**
   * `unsupported` means the browser has no Web MIDI; `denied` means it has it but
   * the user or the platform refused access. Both are dead ends for this session,
   * and the transport tells them apart because they call for different advice.
   */
  support: 'ok' | 'unsupported' | 'denied';
  /** Names of the inputs currently attached, in the order the browser lists them. */
  inputs: string[];
}

/** Channel voice message types, from the MIDI spec. The low nibble is the channel. */
const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;

/**
 * The note event a MIDI message describes, or null if it describes something else.
 *
 * Channel is deliberately ignored: a keyboard split across channels, or one whose
 * channel the player has changed, should still play. Everything that is not a note
 * — clock, control changes, aftertouch, pitch bend, system messages — is dropped
 * rather than approximated, because there is nothing here that could act on it.
 *
 * Running status is not handled, and does not need to be: the Web MIDI API is
 * specified to deliver complete messages, with the status byte always present.
 */
export function parseMidiMessage(data: Uint8Array | number[]): MidiNoteEvent | null {
  if (data.length < 3) return null;

  const status = data[0] & 0xf0;
  const note = data[1] & 0x7f;
  const velocity = data[2] & 0x7f;

  // A note-on with zero velocity is a note-off. Many keyboards send only this
  // form — they hold running status open by never emitting 0x80 — so treating it
  // as a note-on would leave every key ringing forever.
  if (status === NOTE_ON) {
    return velocity > 0
      ? { type: 'noteOn', note, velocity }
      : { type: 'noteOff', note, velocity: 0 };
  }

  if (status === NOTE_OFF) {
    return { type: 'noteOff', note, velocity };
  }

  return null;
}

interface OpenMidiInputsOptions {
  onEvent: (event: MidiNoteEvent) => void;
  /** Called once access is settled, and again whenever a device comes or goes. */
  onStatus?: (status: MidiInputStatus) => void;
}

/**
 * Listen to every MIDI input on the machine, including ones plugged in later.
 *
 * Every input rather than a chosen one: a player with one keyboard should not have
 * to pick it out of a menu, and a player with several has no way to say which is
 * "the" keyboard that would not be wrong the moment they reach for the other.
 *
 * Returns a disposer synchronously, before access has been granted, so a caller
 * unmounting mid-request cannot leak a listener onto a port that arrives later.
 * Sysex is not requested: nothing here reads it, and asking would raise the
 * permission prompt from silent to explicit for no gain.
 */
export function openMidiInputs({ onEvent, onStatus }: OpenMidiInputsOptions): () => void {
  let disposed = false;
  let detach: (() => void) | null = null;

  const request = (
    navigator as Navigator & {
      requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MIDIAccess>;
    }
  ).requestMIDIAccess;

  if (typeof request !== 'function') {
    onStatus?.({ support: 'unsupported', inputs: [] });
    return () => {};
  }

  request.call(navigator, { sysex: false }).then(
    access => {
      if (disposed) return;

      const handleMessage = (event: MIDIMessageEvent) => {
        if (!event.data) return;
        const parsed = parseMidiMessage(event.data);
        if (parsed) onEvent(parsed);
      };

      /**
       * Attach to whatever is plugged in now, and report it.
       *
       * Re-run from scratch on every state change rather than diffing: assigning
       * `onmidimessage` replaces rather than adds, so re-attaching to a port that
       * was already listening is harmless, and a port that has gone away is
       * unreachable anyway.
       */
      const sync = () => {
        const inputs = [...access.inputs.values()];
        for (const input of inputs) {
          input.onmidimessage = handleMessage;
        }
        onStatus?.({
          support: 'ok',
          inputs: inputs.map(input => input.name ?? 'MIDI input'),
        });
      };

      access.onstatechange = sync;
      sync();

      detach = () => {
        access.onstatechange = null;
        for (const input of access.inputs.values()) {
          input.onmidimessage = null;
        }
      };
    },
    () => {
      if (disposed) return;
      // A rejection is a refusal, not a crash: the app works without a keyboard,
      // so this is reported and nothing more.
      onStatus?.({ support: 'denied', inputs: [] });
    }
  );

  return () => {
    disposed = true;
    detach?.();
    detach = null;
  };
}
