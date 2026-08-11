import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { findSegment } from '@/engine/timeline';
import { currentKind, resolveSegmentChord } from '@/engine/chordOperations';
import type { SegmentKindTarget } from '@/engine/chordOperations';
import { projectScale, segmentScale } from '@/engine/scales';
import { ScaleSelect } from '@/components/ScaleSelect';
import { DEFAULT_VELOCITY, voicedPitches } from '@/engine/voicing';
import { CHORD_INTERVALS, midiToNoteLabel } from '@/engine/chords';
import { describePosition, formatNoteValue } from '@/engine/meterDisplay';
import { DEFAULT_TIME_SIGNATURE, PIANO_ROLL_MAX_MIDI, PIANO_ROLL_MIN_MIDI } from '@/utils/constants';
import type { ReactNode } from 'react';
import type {
  ArpeggioPattern,
  ChordSegment,
  Scale,
  SegmentBreak,
  SpacingPreset,
  TimeSignature,
} from '@/types/music';

/** Inversion names by index; root position is named so a button can carry it. */
const INVERSION_NAMES = ['Root', '1st', '2nd', '3rd'];

/** Chord tone names by index, matching how `CHORD_INTERVALS` stacks them. */
const TONE_NAMES = ['Root', '3rd', '5th', '7th'];

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
  const selectedSegmentIds = selectionStore(s => s.selectedSegmentIds);

  const setSegmentsInversion = projectStore(s => s.setSegmentsInversion);
  const setSegmentsSpacing = projectStore(s => s.setSegmentsSpacing);
  const setSegmentsToneOffset = projectStore(s => s.setSegmentsToneOffset);
  const toggleSegmentsDoubling = projectStore(s => s.toggleSegmentsDoubling);
  const setSegmentsBreak = projectStore(s => s.setSegmentsBreak);
  const clearSegmentsVoicing = projectStore(s => s.clearSegmentsVoicing);
  const convertSegmentsKind = projectStore(s => s.convertSegmentsKind);
  const setSegmentsScale = projectStore(s => s.setSegmentsScale);

  const located = project
    ? selectedSegmentIds
        .map(id => findSegment(project.bars, id))
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
  // Custom blocks are excluded alongside notes: a recorded take has no named
  // harmony, so there is nothing to invert, space, double or break.
  const chords = located.filter(
    l => l.segment.kind !== 'note' && l.segment.kind !== 'custom'
  );
  const first = located[0];

  // A recorded block names no degree and is written in no key, so neither
  // conversion nor retuning means anything for it. Withheld for the whole
  // selection when any of it is custom rather than quietly applied to the rest:
  // the controls act on everything selected, and a half-applied edit is worse
  // than an absent one.
  const anyCustom = segments.some(s => s.kind === 'custom');

  const fallbackScale = projectScale(project.key, project.keyMode);
  const scaleOf = (segment: ChordSegment) => segmentScale(segment, fallbackScale);

  // Each chord is resolved against the key it was actually written in, so a
  // selection spanning keys still counts its tones correctly.
  const toneCounts = chords.map(
    l => CHORD_INTERVALS[resolveSegmentChord(l.segment, scaleOf(l.segment)).quality].length
  );
  const toneCount = sharedValue(toneCounts);
  const perToneControls = toneCount !== undefined && chords.length > 0;

  // Root and type are shared separately: a selection agreeing on one but not the
  // other should still show the half it agrees on.
  const sharedRoot = sharedValue(segments.map(s => scaleOf(s).root));
  const sharedType = sharedValue(segments.map(s => scaleOf(s).type));

  // Derive the current kind of each segment so the dropdown can show the
  // shared value or go blank when kinds disagree.
  const segmentKinds = segments.map(s => currentKind(s));
  const sharedKind = sharedValue(segmentKinds) as SegmentKindTarget | undefined;

  return (
    <div className="pt-2 border-t border-gray-700 space-y-3" data-testid="segment-inspector">
      <Identity
        segments={segments}
        segment={first.segment}
        timeSignature={
          first.bar.timeSignature ?? project.timeSignature ?? DEFAULT_TIME_SIGNATURE
        }
      />

      {!anyCustom && (
        <Section label="Kind">
          <select
            data-testid="segment-kind-select"
            value={sharedKind ?? ''}
            disabled={located.length === 0}
            onChange={e => convertSegmentsKind(ids, e.target.value as SegmentKindTarget)}
            className={FIELD_CLASS}
          >
            <option value="note">Note</option>
            <option value="triad">Triad</option>
            <option value="seventh">Seventh</option>
          </select>
        </Section>
      )}

      {/* Outside the chords-only branch below: a note is written in a key too, and
          retuning one moves it to the same degree of the new scale. */}
      {!anyCustom && (
        <Section label="Key">
          <ScaleSelect
            idPrefix="segment"
            layout="stacked"
            root={sharedRoot}
            type={sharedType}
            onChange={patch => setSegmentsScale(ids, patch)}
          />
        </Section>
      )}

      {/* The one place a block's actual notes are shown, because a recorded block
          is the one kind whose notes cannot be read off its name. */}
      {segments.length === 1 && first.segment.kind === 'custom' && (
        <CustomNotes segment={first.segment} />
      )}

      {chords.length === 0 ? (
        anyCustom ? (
          <p className="text-xs text-gray-500">
            A recorded block holds the notes it was played with.
          </p>
        ) : (
          <p className="text-xs text-gray-500">A single note has no chord tones to voice.</p>
        )
      ) : (
        <>
          {perToneControls && (
            <Section label="Inversion">
              <div className="flex gap-1" role="group" aria-label="Inversion">
                {INVERSION_NAMES.slice(0, toneCount).map((name, index) => (
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
                // Drop 3 needs a third voice from the top to drop.
                const unavailable = preset.value === 'drop3' && (toneCount ?? 3) < 3;
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
                          ? 'On a triad, open position is the same as drop 2'
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
                {Array.from({ length: toneCount }, (_, tone) => (
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
                {Array.from({ length: toneCount }, (_, tone) => (
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

  const isCustom = segment.kind === 'custom';
  const played = segment.customNotes ?? [];

  return (
    <div className="text-sm text-gray-300 space-y-0.5">
      <div>
        {isCustom
          ? `${played.length} ${played.length === 1 ? 'note' : 'notes'}`
          : (segment.chordSymbol ?? segment.root)}
      </div>
      <div className="text-xs text-gray-500">
        {isCustom ? 'Recorded' : segment.kind === 'note' ? 'Note' : 'Chord'}
        {segment.romanNumeral ? ` · ${segment.romanNumeral}` : ''}
      </div>
      {/* A recorded block has no one register to state — every pitch in it is
          absolute, and the list below names them all. */}
      {!isCustom && (
        <div className="text-xs text-gray-500">
          {segment.kind === 'note' && segment.pitch !== undefined
            ? midiToNoteLabel(segment.pitch)
            : `Octave ${segment.octave ?? 4}`}
        </div>
      )}
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
 * What a recorded block actually holds, note by note.
 *
 * Read-only: a take is edited by playing it again, not by retyping it. It is here
 * at all because a custom block is the one kind whose contents cannot be read off
 * its name — "Recorded" says nothing about what was played, and the block on the
 * timeline has room for three pitches at most.
 *
 * Ordered by onset, then by pitch, so a chord reads bottom-up and a run reads
 * left-to-right — which is the order they were played in either way.
 */
function CustomNotes({ segment }: { segment: ChordSegment }) {
  const notes = [...(segment.customNotes ?? [])].sort(
    (a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch
  );

  if (notes.length === 0) {
    return <p className="text-xs text-gray-500">This block holds no notes.</p>;
  }

  return (
    <Section label="Notes">
      <ul className="space-y-0.5 max-h-40 overflow-y-auto">
        {notes.map((note, index) => (
          <li
            key={`${note.pitch}-${note.startBeat}-${index}`}
            data-testid={`custom-note-${index}`}
            className="flex justify-between gap-2 text-xs text-gray-400 tabular-nums"
          >
            <span className="text-gray-300">{midiToNoteLabel(note.pitch)}</span>
            <span>
              +{formatBeats(note.startBeat)} · {formatBeats(note.duration)}
            </span>
            <span title="Velocity">{note.velocity ?? DEFAULT_VELOCITY}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Beats, to at most two decimals, without a trailing `.00` on the whole ones. */
function formatBeats(beats: number): string {
  return `${Math.round(beats * 100) / 100}`;
}

/**
 * One chord tone, with the pitch it currently sounds and steppers to move it.
 *
 * The pitch is computed with the same `voicedPitches` the note generator uses, so
 * the label and the piano roll cannot drift apart.
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
  const { quality, rootSemitone } = resolveSegmentChord(segment, scale);
  const baseMidi = ((segment.octave ?? 4) + 1) * 12 + rootSemitone;
  const offset = segment.voicing?.offsets?.[tone] ?? 0;

  // Tone order, undoubled voices first, so index `tone` is this tone's pitch.
  const pitches = voicedPitches(
    CHORD_INTERVALS[quality],
    segment.inversion ?? 0,
    baseMidi,
    segment.voicing
  );
  const sounding = pitches[tone];

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
            value={spread}
            onChange={e =>
              onChange({
                mode: 'strum',
                spreadBeats: Number(e.target.value),
                direction,
              })
            }
            className={FIELD_CLASS}
          >
            {STRUM_SPREADS.map(value => (
              <option key={value} value={value}>
                {/* Stored in beats so it scales with the tempo, but a strum is
                    easier to judge as a physical gesture, so name both. */}
                {`1/${Math.round(1 / value)} beat · ${Math.round((value * 60000) / bpm)}ms`}
              </option>
            ))}
          </select>
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
