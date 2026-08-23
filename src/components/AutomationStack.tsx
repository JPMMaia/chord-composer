import React from 'react';
import type { AutomationPoint, Bar, Phrase, TimeSignature, Track } from '@/types/music';
import { projectStore } from '@/store/projectStore';
import { phraseById } from '@/engine/phrases';
import { AutomationLane, AUTOMATION_LANE_HEIGHT } from '@/components/AutomationLane';
import { LaneLabel } from '@/components/LaneLabel';
import { LearnCcPanel } from '@/components/LearnCcPanel';
import { TouchpadPanel } from '@/components/TouchpadPanel';
import { laneFor, laneKey, MAX_CC, VOLUME_LANE_KEY } from '@/engine/parameterAutomation';
import { freeController, nextFreeCc } from '@/engine/vst3Cc';
import { useVst3Cc } from '@/hooks/useVst3Cc';

/**
 * The curves the open phrase is shaped by: its volume, then one lane per automated
 * plugin parameter.
 *
 * Lives under the phrase editor because a curve belongs to the phrase, on the phrase's
 * own local beat axis — so a swell written here is heard at every placement of it, and
 * moves with the block when it is dragged. `compileAutomation` is what spreads it back
 * over the song; nothing in this file knows where in the arrangement it will land.
 *
 * The instrument still matters, for two things it owns rather than the phrase: the
 * fader every volume point is relative to, and — where it is a plugin that publishes
 * one — the MIDI mapping the strip at the bottom can teach a controller to.
 *
 * Split into a label column and a lane column because the two sit in different scroll
 * containers — the labels must not slide away when the beats do. The only thing
 * keeping their rows in step is that both are driven from the one list
 * `useAutomationLanes` returns, which is why it is a hook rather than two builders.
 */

/**
 * One row of the stack: what to draw, and what a gesture on it means.
 *
 * The volume curve and a plugin parameter differ only in which store actions they
 * reach, so they are described in one shape and rendered by one component.
 */
export interface AutomationLaneDef {
  key: string;
  label: string;
  points: AutomationPoint[];
  /** The dashed level shown when there are no points; null for a parameter. */
  flatLevel: number | null;
  readPoints: () => AutomationPoint[];
  onAdd: (beat: number, value: number) => void;
  onMove: (index: number, beat: number, value: number) => void;
  onRemove: (index: number) => void;
  /**
   * Whether the lane can be taken away and renamed.
   *
   * True for a plugin target, false for volume — which has a fader behind it, so it
   * is cleared rather than removed, and is not the user's to rename.
   */
  removable?: boolean;
}

/** The live copy of a phrase, for reading a curve back after a commit re-sorted it. */
function phraseInStore(phraseId: string): Phrase | undefined {
  const project = projectStore.getState().project;
  return project ? (phraseById(project.phrases, phraseId) ?? undefined) : undefined;
}

/**
 * The rows the stack shows, top to bottom.
 *
 * Empty until there is both a phrase to write a curve into and an instrument to be
 * loud relative to.
 */
export function useAutomationLanes(
  phrase: Phrase | undefined,
  track: Track | undefined
): AutomationLaneDef[] {
  const addVolumePoint = projectStore(s => s.addVolumePoint);
  const moveVolumePoint = projectStore(s => s.moveVolumePoint);
  const removeVolumePoint = projectStore(s => s.removeVolumePoint);
  const addLanePoint = projectStore(s => s.addLanePoint);
  const moveLanePoint = projectStore(s => s.moveLanePoint);
  const removeLanePoint = projectStore(s => s.removeLanePoint);

  if (!phrase || !track) return [];

  return [
    {
      key: VOLUME_LANE_KEY,
      label: 'Volume',
      points: phrase.volumeAutomation ?? [],
      // The fader's value: what the placement plays at with no curve drawn, and what
      // every point drawn here is a fraction of.
      flatLevel: track.volume,
      readPoints: () => phraseInStore(phrase.id)?.volumeAutomation ?? [],
      onAdd: (beat, value) => addVolumePoint(phrase.id, beat, value),
      onMove: (i, beat, value) => moveVolumePoint(phrase.id, i, beat, value),
      onRemove: i => removeVolumePoint(phrase.id, i),
    },
    ...(phrase.parameterAutomation ?? []).map(lane => {
      const key = laneKey(lane.target);
      return {
        key,
        // What the lane was named when it was made, or renamed to since — so a lane
        // still names itself with the plugin missing.
        label: lane.name || key,
        points: lane.points,
        // Nothing drives a target with no points, so there is no level to draw.
        // See `AutomationLane`'s `flatLevel`.
        flatLevel: null,
        readPoints: () =>
          laneFor(phraseInStore(phrase.id)?.parameterAutomation ?? [], key)?.points ?? [],
        onAdd: (beat: number, value: number) => addLanePoint(phrase.id, key, beat, value),
        onMove: (i: number, beat: number, value: number) =>
          moveLanePoint(phrase.id, key, i, beat, value),
        onRemove: (i: number) => removeLanePoint(phrase.id, key, i),
        removable: true,
      };
    }),
  ];
}

export interface AutomationGutterProps {
  phrase: Phrase;
  lanes: AutomationLaneDef[];
}

/** The label column: one row per lane, and the way to be rid of each. */
export const AutomationGutter: React.FC<AutomationGutterProps> = ({ phrase, lanes }) => {
  const clearVolumeAutomation = projectStore(s => s.clearVolumeAutomation);
  const removeLane = projectStore(s => s.removeLane);
  const renameLane = projectStore(s => s.renameLane);

  /** Whether the phrase has a volume curve, and so something to clear. */
  const hasAutomation = (phrase.volumeAutomation?.length ?? 0) > 0;

  return (
    <>
      {lanes.map(lane => (
        <div
          key={lane.key}
          style={{ height: `${AUTOMATION_LANE_HEIGHT}px` }}
          className="flex items-center justify-between gap-1 px-2 text-xs text-gray-400 border-t border-gray-700"
        >
          <LaneLabel
            label={lane.label}
            onRename={lane.removable ? name => renameLane(phrase.id, lane.key, name) : undefined}
          />

          {!lane.removable ? (
            // Volume. Only once there is a curve to clear: an always-present button
            // that does nothing most of the time reads as broken, and dropping the
            // last point by hand is the only other way back to the fader.
            hasAutomation && (
              <button
                type="button"
                aria-label={`Clear volume curve for ${phrase.name}`}
                title="Remove every point and play this phrase at the instrument's fader"
                onClick={() => clearVolumeAutomation(phrase.id)}
                className="px-1 rounded text-[11px] text-gray-500 hover:text-red-400 hover:bg-gray-700 transition-colors"
              >
                Clear
              </button>
            )
          ) : (
            // A plugin lane goes away entirely rather than being cleared: there is no
            // fader behind it to hand control back to, so an empty lane would only be
            // a row that does nothing.
            <button
              type="button"
              aria-label={`Remove ${lane.label} automation`}
              title="Stop automating this and remove its lane"
              onClick={() => removeLane(phrase.id, lane.key)}
              className="shrink-0 px-1 rounded text-[11px] text-gray-500 hover:text-red-400 hover:bg-gray-700 transition-colors"
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </>
  );
};

export interface AutomationLanesProps {
  lanes: AutomationLaneDef[];
  bars: Bar[];
  projectTs: TimeSignature;
  totalBeats: number;
}

/** The curves themselves, each continuous so a ramp crosses a bar line in one piece. */
export const AutomationLanes: React.FC<AutomationLanesProps> = ({
  lanes,
  bars,
  projectTs,
  totalBeats,
}) => (
  <>
    {lanes.map(lane => (
      <AutomationLane
        key={lane.key}
        laneKey={lane.key}
        label={lane.label}
        points={lane.points}
        flatLevel={lane.flatLevel}
        readPoints={lane.readPoints}
        onAdd={lane.onAdd}
        onMove={lane.onMove}
        onRemove={lane.onRemove}
        bars={bars}
        projectTs={projectTs}
        totalBeats={totalBeats}
      />
    ))}
  </>
);

export interface CcLaneStripProps {
  /** The phrase a new lane is added to. */
  phrase: Phrase;
  /** The instrument whose plugin says which controllers there are to learn. */
  track: Track;
}

/**
 * What adds a plugin lane, in a strip of its own under the whole stack.
 *
 * Two ways in, because the two instruments this app plays answer very differently.
 * A plugin that publishes an `IMidiMapping` can be *taught* a controller — arm a
 * control, send the number, and it binds the two — which is what `LearnCcPanel` is
 * for. Everything else, from a General MIDI piano to a plugin that publishes no
 * mapping at all, still takes a lane by number: the lane belongs to the phrase, and
 * `midiExporter` writes it into the exported file whatever ends up playing it. So the
 * number field is always here, and learn joins it only where it can do something.
 *
 * Not in the gutter: that column is only as wide as the piano roll's key column, and
 * anything but a row of the same height as a lane there both cramps itself and pushes
 * the labels out of step with the curves they name. Full width, so the learn steps
 * read across.
 */
export const CcLaneStrip: React.FC<CcLaneStripProps> = ({ phrase, track }) => {
  const addLane = projectStore(s => s.addLane);
  const supported = useVst3Cc(track);

  /** The controllers this phrase already drives, so neither way in offers one twice. */
  const taken = (phrase.parameterAutomation ?? [])
    .map(lane => (lane.target.kind === 'cc' ? lane.target.controller : -1))
    .filter(cc => cc >= 0);

  /**
   * The controller the strip offers, or null when there is none left to offer.
   *
   * Recomputed from the lanes rather than held in state, so adding a lane moves the
   * suggestion on by itself. Both the number field and `LearnCcPanel` override it
   * while the user is typing.
   */
  const suggested =
    supported.length > 0 ? nextFreeCc(supported, taken) : freeController(taken);

  return (
    <div className="flex flex-wrap items-center gap-3 px-2 py-1 border-t border-gray-800">
      <AddCcLane
        phrase={phrase}
        suggested={suggested}
        taken={taken}
        onAdd={controller => addLane(phrase.id, { kind: 'cc', controller }, `CC ${controller}`)}
      />

      {/* Only where the plugin can be taught. Learn is a shortcut past having to
          know which control a number reaches — with no `IMidiMapping` behind it,
          sending the controller would bind nothing. */}
      {supported.length > 0 && (
        <LearnCcPanel
          trackId={track.id}
          supported={supported}
          suggested={suggested}
          onLearned={controller =>
            addLane(phrase.id, { kind: 'cc', controller }, `CC ${controller}`)
          }
        />
      )}

      {/* Beside the two ways of *drawing* a curve, because it is the third way of
          getting one: played rather than drawn. It sits here rather than in the
          transport because what it needs saying about it — which controller — is
          the same question the rest of this strip is asking. */}
      <TouchpadPanel track={track} supported={supported} suggested={suggested} />
    </div>
  );
};

interface AddCcLaneProps {
  phrase: Phrase;
  /** The number to start on, followed until the user types one of their own. */
  suggested: number | null;
  /** Controllers already automated on this phrase, which cannot be added twice. */
  taken: number[];
  onAdd: (controller: number) => void;
}

/**
 * A controller number and the button that gives it a lane.
 *
 * Adding an *empty* lane is the point: a lane with no points drives nothing, so this
 * only makes a row to draw into — the drawing is the automation. That is also why
 * there is no confirmation and no undo prompt here; removing the row again is the ✕
 * beside its label.
 */
const AddCcLane: React.FC<AddCcLaneProps> = ({ phrase, suggested, taken, onAdd }) => {
  const [controller, setController] = React.useState<number | null>(suggested);

  // Follows the suggestion as lanes are added, but only while the user has not typed
  // a number of their own — a field that rewrote itself under the cursor would be
  // unusable. The same rule `LearnCcPanel` follows, for the same reason.
  const [touched, setTouched] = React.useState(false);
  React.useEffect(() => {
    if (!touched) setController(suggested);
  }, [suggested, touched]);

  const valid = controller !== null && controller >= 0 && controller <= MAX_CC;
  const already = controller !== null && taken.includes(controller);

  return (
    <div className="flex items-center gap-2 min-w-0 text-[11px]">
      <label className="text-gray-400 shrink-0" htmlFor={`add-cc-${phrase.id}`}>
        CC
      </label>
      <input
        id={`add-cc-${phrase.id}`}
        type="number"
        min={0}
        max={MAX_CC}
        aria-label="Controller number to automate"
        value={controller ?? ''}
        onChange={e => {
          setTouched(true);
          const next = Number(e.target.value);
          setController(e.target.value === '' || !Number.isFinite(next) ? null : next);
        }}
        // Or the timeline's shortcuts would read the digits as commands.
        onKeyDown={e => e.stopPropagation()}
        className="w-14 shrink-0 bg-gray-700 border border-gray-600 rounded text-gray-300 px-1 py-0.5 focus:outline-none focus:border-indigo-500"
      />
      <button
        type="button"
        disabled={!valid || already}
        title={
          already
            ? 'This phrase already has a lane for that controller'
            : 'Add an empty lane for this controller, to draw a curve into'
        }
        onClick={() => {
          if (valid && !already) onAdd(controller);
        }}
        className="shrink-0 px-2 py-0.5 rounded bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 transition-colors"
      >
        {/* Not just "Add lane": the gutter's own button by that name adds a sub-lane
            for blocks, which is a different thing entirely. */}
        Add CC lane
      </button>
    </div>
  );
};
