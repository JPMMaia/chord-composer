import { editSurface, projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { findSegment } from '@/engine/timeline';
import { resolveSegmentChord, segmentVelocity } from '@/engine/chordOperations';
import { projectScale, segmentScale } from '@/engine/scales';
import { ScaleSelect } from '@/components/ScaleSelect';
import { DEFAULT_VELOCITY, voicedVoices } from '@/engine/voicing';
import type { ChordTones } from '@/engine/voicing';
import {
  midiToNoteLabel,
  segmentChordTones,
  segmentQuality,
  segmentTones,
  triadColourOf,
} from '@/engine/chords';
import type { SeventhColour, TriadColour } from '@/engine/chords';
import { PALETTE_SIZES, SIZE_LABELS } from '@/engine/palette';
import { seventhColourOf } from '@/engine/chords';
import { describePosition, formatNoteValue } from '@/engine/meterDisplay';
import { DEFAULT_TIME_SIGNATURE, PIANO_ROLL_MAX_MIDI, PIANO_ROLL_MIN_MIDI } from '@/utils/constants';
import { useRef, useState, type ReactNode } from 'react';
import type {
  ArpeggioPattern,
  ChordSegment,
  Scale,
  SegmentBreak,
  SpacingPreset,
  TimeSignature,
} from '@/types/music';

/** Inversion names by index; root position is named so a button can carry it. */
const INVERSION_NAMES = ['Root', '1st', '2nd', '3rd', '4th'];

/** Chord tone names by index, matching the order a stack builds them in. */
const TONE_NAMES = ['Root', '3rd', '5th', '7th', '9th'];

/** The triad a chord is coloured by — offered at every size above a single tone. */
const TRIAD_COLOURS: { value: TriadColour; label: string }[] = [
  { value: 'major', label: 'Maj' },
  { value: 'minor', label: 'Min' },
  { value: 'diminished', label: 'Dim' },
  { value: 'augmented', label: 'Aug' },
  { value: 'sus2', label: 'Sus2' },
  { value: 'sus4', label: 'Sus4' },
];

/**
 * The seventh's colour. `undefined` is the key's own, which is what every block that
 * has never been touched here has.
 */
const SEVENTH_COLOURS: { value: SeventhColour | undefined; label: string }[] = [
  { value: undefined, label: 'Key' },
  { value: 'major', label: 'Maj' },
  { value: 'minor', label: 'Min' },
  { value: 'diminished', label: 'Dim' },
];

/**
 * Alterations a note may be given, by semitones off its degree.
 *
 * A semitone either way, where a formula file may also name a double accidental: an
 * accidental typed by hand is a leading tone or a borrowed flat, and a control wide
 * enough for 𝄪 mostly offers ways to mistype one.
 */
const ALTERATIONS = [
  { value: -1, label: '♭', name: 'Flatten' },
  { value: 0, label: '♮', name: 'Natural' },
  { value: 1, label: '♯', name: 'Raise' },
];

const SPACING_PRESETS: { value: SpacingPreset; label: string }[] = [
  { value: 'close', label: 'Close' },
  { value: 'open', label: 'Open' },
  { value: 'drop2', label: 'Drop 2' },
  { value: 'drop3', label: 'Drop 3' },
];

const ARPEGGIO_PATTERNS: { value: ArpeggioPattern; label: string }[] = [
  { value: 'up', label: 'Up' },
  { value: 'down', label: 'Down' },
  { value: 'upDown', label: 'Up-down' },
  { value: 'asPlayed', label: 'As voiced' },
];

/**
 * Spreads offered for a strum, as fractions of a beat.
 *
 * Stops well short of the shortest writable note. A wider stagger than this is
 * not a strummed chord any more but an arpeggio — which the Arpeggio mode says
 * better, and which notation software would rightly write as separate notes.
 * At 120bpm these run about 8ms to 31ms, the range of an actual strumming hand.
 */
const STRUM_SPREADS = [1 / 64, 1 / 32, 1 / 16];

/** Marks the spread dropdown's escape hatch; never a spread itself. */
const CUSTOM_SPREAD = 'custom';

/** The denominator a spread is named by: 1/32 of a beat reads as "32". */
function spreadDenominator(spreadBeats: number): string {
  return String(Math.round(1 / spreadBeats));
}

/**
 * A spread named both ways.
 *
 * Stored in beats so it scales with the tempo, but a strum is easier to judge as
 * a physical gesture, so name both.
 */
function describeSpread(spreadBeats: number, bpm: number): string {
  return `1/${Math.round(1 / spreadBeats)} beat · ${Math.round((spreadBeats * 60000) / bpm)}ms`;
}

const FIELD_CLASS =
  'w-full px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500';

/**
 * The value every item shares, or undefined when they disagree.
 *
 * What lets the panel speak for a multi-selection: a control showing nothing is
 * saying "these chords differ here", not "this is unset".
 */
function sharedValue<T>(values: T[]): T | undefined {
  if (values.length === 0) return undefined;
  const [first] = values;
  return values.every(v => v === first) ? first : undefined;
}

/**
 * The preset button to light, if any.
 *
 * A chord that has been hand-tweaked lights none of them: its offsets no longer
 * describe a preset, and claiming "Close" for a voicing that is plainly spread
 * would be a lie. Only a chord with no offsets at all is genuinely close position.
 */
function activeSpacing(segment: ChordSegment): SpacingPreset | undefined {
  if (segment.voicing?.spacing) return segment.voicing.spacing;
  return segment.voicing?.offsets?.some(o => o !== 0) ? undefined : 'close';
}

/** A pill in a segmented control. Reuses the panel's `aria-pressed` toggle idiom. */
function ToggleButton({
  active,
  disabled,
  onClick,
  label,
  testId,
  title,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  testId: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex-1 px-1.5 py-1 text-xs rounded transition-colors ${
        active ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
      } ${disabled ? 'opacity-40 cursor-not-allowed hover:bg-gray-700' : ''}`}
    >
      {label}
    </button>
  );
}

/**
 * Voicing controls for the selected chords.
 *
 * Reads the selection rather than the bar cursor, and resolves it across every
 * bar: a block stays selected when the cursor moves elsewhere, so looking only in
 * the "current" bar would blank the panel on a chord that is plainly selected.
 *
 * Edits apply to the whole selection. The sections that address a specific chord
 * tone — inversion, voices, doubling — only appear when every selected chord has
 * the same number of tones, since "the 7th" means nothing across a triad and a
 * seventh chord at once.
 */
export function SegmentInspector() {
  const project = projectStore(s => s.project);
  const editingPhraseId = projectStore(s => s.editingPhraseId);
  const selectedSegmentIds = selectionStore(s => s.selectedSegmentIds);

  const setSegmentsInversion = projectStore(s => s.setSegmentsInversion);
  const setSegmentsSpacing = projectStore(s => s.setSegmentsSpacing);
  const setSegmentsToneOffset = projectStore(s => s.setSegmentsToneOffset);
  const toggleSegmentsDoubling = projectStore(s => s.toggleSegmentsDoubling);
  const setSegmentsBreak = projectStore(s => s.setSegmentsBreak);
  const clearSegmentsVoicing = projectStore(s => s.clearSegmentsVoicing);
  const setSegmentsVelocity = projectStore(s => s.setSegmentsVelocity);
  const setSegmentsAlter = projectStore(s => s.setSegmentsAlter);
  const withRecording = projectStore(s => s.withRecording);
  const convertSegmentsKind = projectStore(s => s.convertSegmentsKind);
  const setSegmentsStackSize = projectStore(s => s.setSegmentsStackSize);
  const toggleSegmentsTone = projectStore(s => s.toggleSegmentsTone);
  const setSegmentsTriadColour = projectStore(s => s.setSegmentsTriadColour);
  const setSegmentsSeventhColour = projectStore(s => s.setSegmentsSeventhColour);
  const clearSegmentsQualityPin = projectStore(s => s.clearSegmentsQualityPin);
  const setSegmentsScale = projectStore(s => s.setSegmentsScale);

  // Selected ids name blocks in the phrase being edited, not in the compiled song —
  // see `editSurface`. Subscribing to `editingPhraseId` as well as to the project is
  // what makes the panel re-read when the editor is pointed somewhere else.
  const surface = editingPhraseId && project ? editSurface() : null;
  const located = surface
    ? selectedSegmentIds
        .map(id => findSegment(surface.bars, id))
        .filter((l): l is NonNullable<typeof l> => l !== null)
    : [];

  if (!project || located.length === 0) {
    return (
      <div className="pt-2 border-t border-gray-700" data-testid="segment-inspector">
        <h3 className="text-xs font-semibold text-gray-400 mb-1">Segment</h3>
        <p className="text-xs text-gray-500">No segment selected</p>
      </div>
    );
  }

  const segments = located.map(l => l.segment);
  const ids = segments.map(s => s.id);
  // A note has no named harmony, so there is nothing to invert, space, double or break.
  const chords = located.filter(l => l.segment.kind !== 'note');
  const first = located[0];

  const fallbackScale = projectScale(project.key, project.keyMode);
  const scaleOf = (segment: ChordSegment) => segmentScale(segment, fallbackScale);

  // Each chord is resolved against the key it was actually written in, so a
  // selection spanning keys still reads its stack correctly.
  //
  // Compared as whole *sets* rather than as counts: two four-note chords can stack
  // different tones — one a seventh, one a ninth with no fifth — and a row labelled
  // "the 7th" would then address a different note in each.
  const toneSets = chords.map(l => segmentTones(l.segment, scaleOf(l.segment)));
  const sharedToneKey = sharedValue(toneSets.map(t => t.join(',')));
  const tones: number[] | undefined =
    sharedToneKey === undefined ? undefined : sharedToneKey.split(',').map(Number);
  const toneCount = tones?.length;
  const perToneControls = tones !== undefined && chords.length > 0;

  // Root and type are shared separately: a selection agreeing on one but not the
  // other should still show the half it agrees on.
  const sharedRoot = sharedValue(segments.map(s => scaleOf(s).root));
  const sharedType = sharedValue(segments.map(s => scaleOf(s).type));

  // The colour every selected chord shares, or undefined when they disagree — the
  // same "a blank control means they differ" idiom the rest of the panel uses.
  const qualities = chords.map(l => segmentQuality(l.segment, scaleOf(l.segment)));
  const sharedTriad = sharedValue(qualities.map(q => triadColourOf(q)));
  const sharedSeventh = sharedValue(qualities.map(q => seventhColourOf(q)));
  const anyPinned = chords.some(l => l.segment.qualityPinned);

  return (
    <div className="pt-2 border-t border-gray-700 space-y-3" data-testid="segment-inspector">
      <Identity
        segments={segments}
        segment={first.segment}
        timeSignature={
          first.bar.timeSignature ?? project.timeSignature ?? DEFAULT_TIME_SIGNATURE
        }
      />

      {/* A recorded block carries an absolute pitch and names no degree, so it has no
          stack to size until it is given one. */}
      {chords.length === 0 ? (
        <Section label="Kind">
          <button
            type="button"
            data-testid="make-chord"
            onClick={() => convertSegmentsKind(ids, 'triad')}
            className="w-full px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors"
          >
            Make a chord
          </button>
        </Section>
      ) : (
        <>
          <Section label="Size">
            <select
              data-testid="segment-size-select"
              value={toneCount ?? ''}
              onChange={e => setSegmentsStackSize(ids, Number(e.target.value))}
              className={FIELD_CLASS}
            >
              {toneCount === undefined && <option value="">Mixed</option>}
              {PALETTE_SIZES.map(n => (
                <option key={n} value={n}>
                  {SIZE_LABELS[n]}
                </option>
              ))}
            </select>
          </Section>

          {/* The size stepper writes a plain stack; these put the gaps back — a fifth
              dyad, a ninth with no fifth, a seventh with no third. */}
          <Section label="Tones">
            <div className="flex gap-1" role="group" aria-label="Tones">
              {TONE_NAMES.map((name, tone) => (
                <ToggleButton
                  key={tone}
                  testId={`tone-${tone}`}
                  label={name}
                  // Everything is counted from the root: a register, an inversion and
                  // a captured formula all start there.
                  disabled={tone === 0}
                  title={tone === 0 ? 'Every chord sounds its root' : undefined}
                  active={tones?.includes(tone) ?? false}
                  onClick={() => toggleSegmentsTone(ids, tone)}
                />
              ))}
            </div>
          </Section>

          {(toneCount ?? 0) > 1 && (
            <Section label="Triad">
              <div className="flex gap-1 flex-wrap" role="group" aria-label="Triad">
                {TRIAD_COLOURS.map(colour => (
                  <ToggleButton
                    key={colour.value}
                    testId={`triad-${colour.value}`}
                    label={colour.label}
                    active={sharedTriad === colour.value}
                    onClick={() => setSegmentsTriadColour(ids, colour.value)}
                  />
                ))}
              </div>
            </Section>
          )}

          {tones?.includes(3) && (
            <Section label="7th">
              <div className="flex gap-1" role="group" aria-label="Seventh">
                {SEVENTH_COLOURS.map(colour => (
                  <ToggleButton
                    key={colour.label}
                    testId={`seventh-${colour.value ?? 'key'}`}
                    label={colour.label}
                    active={sharedSeventh === colour.value}
                    onClick={() => setSegmentsSeventhColour(ids, colour.value)}
                  />
                ))}
              </div>
            </Section>
          )}

          {/* The way out of a pin, and the reason a pin can be a plain flag rather
              than something guessed by comparing a quality against its degree. */}
          {anyPinned && (
            <button
              type="button"
              data-testid="follow-key"
              onClick={() => clearSegmentsQualityPin(ids)}
              className="w-full px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors"
            >
              Follow the key
            </button>
          )}
        </>
      )}

      {/* Outside the chords-only branch below: a note is written in a key too, and
          retuning one moves it to the same degree of the new scale. */}
      <Section label="Key">
        <ScaleSelect
          idPrefix="segment"
          layout="stacked"
          root={sharedRoot}
          type={sharedType}
          onChange={patch => setSegmentsScale(ids, patch)}
        />
      </Section>

      {/* The only way to write a block the scale does not contain: the piano roll
          refuses off-scale pitches, and the palette offers the key's own degrees, so
          without this a chromatic block could only arrive from a formula or a
          recording. On a note it bends the pitch; on a chord, the root. */}
      <Section label="Alteration">
        <div className="flex gap-1" role="group" aria-label="Alteration">
          {ALTERATIONS.map(({ value, label, name }) => (
            <ToggleButton
              key={value}
              testId={`alter-${value}`}
              label={label}
              title={name}
              active={sharedValue(segments.map(s => s.alter ?? 0)) === value}
              onClick={() => setSegmentsAlter(ids, value)}
            />
          ))}
        </div>
      </Section>

      {/* Offered for every kind, unlike the voicing controls below: a note sounds at
          some velocity too, but only a chord has tones to voice. */}
      <VelocitySection
        shared={sharedValue(segments.map(s => segmentVelocity(s)))}
        onChange={(velocity, live) =>
          live
            ? withRecording(() => setSegmentsVelocity(ids, velocity))
            : setSegmentsVelocity(ids, velocity)
        }
      />

      {chords.length === 0 ? (
        <p className="text-xs text-gray-500">A single note has no chord tones to voice.</p>
      ) : (
        <>
          {perToneControls && (
            <Section label="Inversion">
              <div className="flex gap-1" role="group" aria-label="Inversion">
                {INVERSION_NAMES.slice(0, toneCount ?? 0).map((name, index) => (
                  <ToggleButton
                    key={name}
                    testId={`inversion-${index}`}
                    label={name}
                    active={sharedValue(chords.map(l => l.segment.inversion ?? 0)) === index}
                    onClick={() => setSegmentsInversion(ids, index)}
                  />
                ))}
              </div>
            </Section>
          )}

          <Section label="Spacing">
            <div className="flex gap-1" role="group" aria-label="Spacing">
              {SPACING_PRESETS.map(preset => {
                // Every preset but Close moves a voice relative to the ones around
                // it, so all of them need three sounding voices to mean anything.
                const unavailable = preset.value !== 'close' && (toneCount ?? 3) < 3;
                return (
                  <ToggleButton
                    key={preset.value}
                    testId={`spacing-${preset.value}`}
                    label={preset.label}
                    disabled={unavailable}
                    title={
                      unavailable
                        ? 'Needs at least three voices'
                        : preset.value === 'open' && toneCount === 3
                          ? 'On a three-note chord, open position is the same as drop 2'
                          : undefined
                    }
                    active={
                      sharedValue(chords.map(l => activeSpacing(l.segment))) === preset.value
                    }
                    onClick={() => setSegmentsSpacing(ids, preset.value)}
                  />
                );
              })}
            </div>
          </Section>

          {perToneControls && (
            <Section label="Voices">
              <div className="space-y-1">
                {tones.map(tone => (
                  <VoiceRow
                    key={tone}
                    tone={tone}
                    segment={first.segment}
                    scale={scaleOf(first.segment)}
                    single={chords.length === 1}
                    onStep={offset => setSegmentsToneOffset(ids, tone, offset)}
                  />
                ))}
              </div>
            </Section>
          )}

          {perToneControls && (
            <Section label="Doubling">
              <div className="space-y-1">
                {tones.map(tone => (
                  <div key={tone} className="flex items-center gap-1">
                    <span className="text-xs text-gray-400 w-10">{TONE_NAMES[tone]}</span>
                    {([1, -1] as const).map(octaves => (
                      <ToggleButton
                        key={octaves}
                        testId={`doubling-${tone}-${octaves > 0 ? 'up' : 'down'}`}
                        label={octaves > 0 ? '+8ve' : '−8ve'}
                        active={
                          sharedValue(
                            chords.map(l =>
                              (l.segment.voicing?.doublings ?? []).some(
                                d => d.tone === tone && d.octaves === octaves
                              )
                            )
                          ) === true
                        }
                        onClick={() => toggleSegmentsDoubling(ids, tone, octaves)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </Section>
          )}

          <BreakSection
            key={ids.join(',')}
            chords={chords.map(l => l.segment)}
            bpm={project.bpm}
            onChange={spec => setSegmentsBreak(ids, spec)}
          />

          <button
            type="button"
            data-testid="reset-voicing"
            onClick={() => clearSegmentsVoicing(ids)}
            className="w-full px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors"
          >
            Reset voicing
          </button>
        </>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="block text-xs text-gray-400 mb-1">{label}</span>
      {children}
    </div>
  );
}

/** The read-only summary: what this block is, how long, and where. */
function Identity({
  segments,
  segment,
  timeSignature,
}: {
  segments: ChordSegment[];
  segment: ChordSegment;
  timeSignature: TimeSignature;
}) {
  if (segments.length > 1) {
    return (
      <div className="text-sm text-gray-300">
        {segments.length} segments selected
      </div>
    );
  }

  return (
    <div className="text-sm text-gray-300 space-y-0.5">
      <div>{segment.chordSymbol ?? segment.root}</div>
      <div className="text-xs text-gray-500">
        {segment.kind === 'note' ? 'Note' : 'Chord'}
        {segment.romanNumeral ? ` · ${segment.romanNumeral}` : ''}
      </div>
      <div className="text-xs text-gray-500">
        {segment.kind === 'note' && segment.pitch !== undefined
          ? midiToNoteLabel(segment.pitch)
          : `Octave ${segment.octave ?? 4}`}
      </div>
      {/* Named as a note value and located in the bar's own metre — "1.5 beats"
          says nothing about whether the bar counts in quarters or dotted quarters. */}
      <div className="text-xs text-gray-500">
        {formatNoteValue(segment.duration)}
        {' · '}
        {describePosition(segment.startBeat ?? 0, timeSignature)}
      </div>
    </div>
  );
}

/**
 * How hard the selection sounds.
 *
 * The slider commits on every move so the piano roll, the block shading and the
 * next note played all follow the drag. Those intermediate writes go through the
 * store's recording gate, which silences the undo middleware — otherwise one drag
 * across the track would bury the history under a hundred entries. The release
 * commits once ungated, so the whole gesture is a single undo. A keyboard arrow
 * fires `change` with no drag in progress and commits normally.
 *
 * A blank readout means the selection disagrees, matching the segmented controls
 * below; the slider parks at the default rather than picking one block's value to
 * speak for the rest.
 */
function VelocitySection({
  shared,
  onChange,
}: {
  shared: number | undefined;
  /** `live` marks a mid-drag write, to be gated out of the undo history. */
  onChange: (velocity: number, live: boolean) => void;
}) {
  const dragging = useRef(false);

  return (
    <Section label="Velocity">
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={1}
          max={127}
          value={shared ?? DEFAULT_VELOCITY}
          data-testid="segment-velocity"
          aria-label="Velocity"
          className="flex-1 accent-indigo-500"
          onPointerDown={() => {
            dragging.current = true;
          }}
          onChange={e => onChange(Number(e.target.value), dragging.current)}
          // `lostpointercapture` as well as `pointerup`: a drag released outside
          // the window never reports the up, and the gate has to close either way
          // or the next edit would go unrecorded.
          onPointerUp={e => {
            dragging.current = false;
            onChange(Number(e.currentTarget.value), false);
          }}
          onLostPointerCapture={e => {
            if (!dragging.current) return;
            dragging.current = false;
            onChange(Number(e.currentTarget.value), false);
          }}
        />
        <span
          data-testid="segment-velocity-value"
          className="text-xs text-gray-400 tabular-nums w-7 text-right"
        >
          {shared ?? '—'}
        </span>
      </div>
    </Section>
  );
}

/**
 * One chord tone, with the pitch it currently sounds and steppers to move it.
 *
 * The pitch is computed from the same voicing the note generator uses, so the label
 * and the piano roll cannot drift apart.
 */
function VoiceRow({
  tone,
  segment,
  scale,
  single,
  onStep,
}: {
  tone: number;
  segment: ChordSegment;
  /** The key the segment is written in, for resolving a numeral-only chord. */
  scale: Scale;
  single: boolean;
  onStep: (offsetOctaves: number) => void;
}) {
  const { rootSemitone } = resolveSegmentChord(segment, scale);
  const baseMidi = ((segment.octave ?? 4) + 1) * 12 + rootSemitone;
  const offset = segment.voicing?.offsets?.[tone] ?? 0;

  // Found by tone rather than indexed by it: a voice that left the roll or
  // collided with another is dropped from this list, so its position in it says
  // nothing about which chord tone it is.
  const chord: ChordTones = segmentChordTones(segment, scale);
  const sounding = voicedVoices(
    chord,
    segment.inversion ?? 0,
    baseMidi,
    segment.voicing
  ).find(v => v.tone === tone && !v.doubled)?.pitch;

  const step = (delta: number) => onStep(offset + delta);
  const wouldLeaveRange = (delta: number) =>
    sounding !== undefined &&
    (sounding + delta * 12 < PIANO_ROLL_MIN_MIDI || sounding + delta * 12 > PIANO_ROLL_MAX_MIDI);

  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-gray-400 w-10">{TONE_NAMES[tone]}</span>
      <span className="text-xs text-gray-500 w-10" data-testid={`voice-pitch-${tone}`}>
        {single && sounding !== undefined ? midiToNoteLabel(sounding) : '—'}
      </span>
      <button
        type="button"
        data-testid={`voice-down-${tone}`}
        aria-label={`Lower ${TONE_NAMES[tone]} an octave`}
        disabled={wouldLeaveRange(-1)}
        onClick={() => step(-1)}
        className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-gray-200 rounded transition-colors"
      >
        −
      </button>
      <button
        type="button"
        data-testid={`voice-up-${tone}`}
        aria-label={`Raise ${TONE_NAMES[tone]} an octave`}
        disabled={wouldLeaveRange(1)}
        onClick={() => step(1)}
        className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-gray-200 rounded transition-colors"
      >
        +
      </button>
    </div>
  );
}

/** How the chord is spread in time: a block, an arpeggio, or a strum. */
function BreakSection({
  chords,
  bpm,
  onChange,
}: {
  chords: ChordSegment[];
  bpm: number;
  onChange: (spec: SegmentBreak | null) => void;
}) {
  const mode = sharedValue(chords.map(s => s.voicing?.break?.mode ?? 'none'));
  const spec = chords[0]?.voicing?.break;

  const pattern =
    spec?.mode === 'arpeggio' ? spec.pattern : ('up' as ArpeggioPattern);
  const spread = spec?.mode === 'strum' ? spec.spreadBeats : STRUM_SPREADS[1];
  const direction = spec?.mode === 'strum' ? spec.direction : 'up';

  // null means the presets speak for the spread; a string is the denominator
  // being typed. Kept as text so a half-typed or momentarily empty field is
  // never committed to the store as a spread.
  const [customDraft, setCustomDraft] = useState<string | null>(null);
  // Sticky once opened, so typing a denominator that happens to name a preset
  // does not snatch the field away mid-edit. A stored spread matching none of
  // the presets opens it unasked — otherwise the select would name an option
  // that is not the one playing.
  const isCustom = customDraft !== null || !STRUM_SPREADS.includes(spread);

  const typeCustom = (text: string) => {
    setCustomDraft(text);
    const denominator = Number(text);
    if (Number.isFinite(denominator) && denominator > 0) {
      onChange({ mode: 'strum', spreadBeats: 1 / denominator, direction });
    }
  };

  return (
    <Section label="Break">
      <div className="flex gap-1 mb-1" role="group" aria-label="Break">
        <ToggleButton
          testId="break-none"
          label="Block"
          active={mode === 'none'}
          onClick={() => onChange(null)}
        />
        <ToggleButton
          testId="break-arpeggio"
          label="Arpeggio"
          active={mode === 'arpeggio'}
          onClick={() => onChange({ mode: 'arpeggio', pattern })}
        />
        <ToggleButton
          testId="break-strum"
          label="Strum"
          active={mode === 'strum'}
          onClick={() => onChange({ mode: 'strum', spreadBeats: spread, direction })}
        />
      </div>

      {mode === 'arpeggio' && (
        <select
          data-testid="arpeggio-pattern"
          aria-label="Arpeggio pattern"
          value={pattern}
          onChange={e =>
            onChange({ mode: 'arpeggio', pattern: e.target.value as ArpeggioPattern })
          }
          className={FIELD_CLASS}
        >
          {ARPEGGIO_PATTERNS.map(p => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      )}

      {mode === 'strum' && (
        <div className="space-y-1">
          <select
            data-testid="strum-spread"
            aria-label="Strum spread"
            value={isCustom ? CUSTOM_SPREAD : String(spread)}
            onChange={e => {
              if (e.target.value === CUSTOM_SPREAD) {
                // Opening the field seeds it from the spread already playing;
                // reaching for the control must not change what is heard.
                setCustomDraft(spreadDenominator(spread));
                return;
              }
              setCustomDraft(null);
              onChange({
                mode: 'strum',
                spreadBeats: Number(e.target.value),
                direction,
              });
            }}
            className={FIELD_CLASS}
          >
            {STRUM_SPREADS.map(value => (
              <option key={value} value={value}>
                {describeSpread(value, bpm)}
              </option>
            ))}
            <option value={CUSTOM_SPREAD}>Custom…</option>
          </select>
          {isCustom && (
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                step={1}
                data-testid="strum-spread-custom"
                aria-label="Custom strum spread denominator"
                value={customDraft ?? spreadDenominator(spread)}
                onChange={e => typeCustom(e.target.value)}
                onBlur={() => {
                  const denominator = Number(customDraft);
                  // A field reading something other than what plays is worse
                  // than one that snaps back, so restore the spread in force.
                  if (!Number.isFinite(denominator) || denominator <= 0) {
                    setCustomDraft(spreadDenominator(spread));
                  }
                }}
                className={FIELD_CLASS}
              />
              <span className="text-xs text-gray-400 whitespace-nowrap">
                {describeSpread(spread, bpm)}
              </span>
            </div>
          )}
          <select
            data-testid="strum-direction"
            aria-label="Strum direction"
            value={direction}
            onChange={e =>
              onChange({
                mode: 'strum',
                spreadBeats: spread,
                direction: e.target.value as 'up' | 'down',
              })
            }
            className={FIELD_CLASS}
          >
            <option value="up">Up (lowest first)</option>
            <option value="down">Down (highest first)</option>
          </select>
        </div>
      )}
    </Section>
  );
}
