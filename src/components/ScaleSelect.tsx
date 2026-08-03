import type { NoteName, Scale, ScaleType } from '@/types/music';
import { NOTE_NAMES, SCALE_TYPES } from '@/utils/constants';

/** Turns 'naturalMinor' into 'natural Minor' for a dropdown label. */
function scaleTypeLabel(type: ScaleType): string {
  return type.replace(/([A-Z])/g, ' $1').trim();
}

const SELECT_CLASS =
  'px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500';

interface ScaleSelectProps {
  /**
   * The root to show, or undefined for "these blocks disagree" — which reads as a
   * blank field rather than a wrong one.
   */
  root?: NoteName;
  /** Likewise the scale type. */
  type?: ScaleType;
  /**
   * Reports only the half that changed, so a selection whose roots differ can have
   * its scale type set without inventing a root for it.
   */
  onChange: (patch: Partial<Scale>) => void;
  /** Distinguishes the two instances' input ids, e.g. 'palette' or 'segment'. */
  idPrefix: string;
  /** `inline` for the palette strip, `stacked` with labels for the properties panel. */
  layout?: 'inline' | 'stacked';
}

/**
 * The root-note and scale-type pair, used by the palette strip and the segment
 * inspector.
 *
 * Shared because the two would otherwise drift: they offer the same twelve roots
 * and twelve scale types, and a key chosen in one has to name the same thing as a
 * key chosen in the other.
 */
export function ScaleSelect({
  root,
  type,
  onChange,
  idPrefix,
  layout = 'inline',
}: ScaleSelectProps) {
  const stacked = layout === 'stacked';
  const rootId = `${idPrefix}-scale-root`;
  const typeId = `${idPrefix}-scale-type`;

  const rootSelect = (
    <select
      id={rootId}
      aria-label="Root Note"
      data-testid={`${idPrefix}-scale-root`}
      value={root ?? ''}
      onChange={e => onChange({ root: e.target.value as NoteName })}
      className={`${SELECT_CLASS} ${stacked ? 'w-full' : ''}`}
    >
      {/* Only reachable while the fields disagree; picking a real root replaces it. */}
      {root === undefined && <option value="">—</option>}
      {NOTE_NAMES.map(note => (
        <option key={note} value={note}>
          {note}
        </option>
      ))}
    </select>
  );

  const typeSelect = (
    <select
      id={typeId}
      aria-label="Scale Type"
      data-testid={`${idPrefix}-scale-type`}
      value={type ?? ''}
      onChange={e => onChange({ type: e.target.value as ScaleType })}
      className={`${SELECT_CLASS} ${stacked ? 'w-full' : ''}`}
    >
      {type === undefined && <option value="">—</option>}
      {SCALE_TYPES.map(t => (
        <option key={t} value={t}>
          {scaleTypeLabel(t)}
        </option>
      ))}
    </select>
  );

  if (!stacked) {
    return (
      <>
        {rootSelect}
        {typeSelect}
      </>
    );
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs text-gray-400 mb-1" htmlFor={rootId}>
          Root Note
        </label>
        {rootSelect}
      </div>
      <div>
        <label className="block text-xs text-gray-400 mb-1" htmlFor={typeId}>
          Scale Type
        </label>
        {typeSelect}
      </div>
    </div>
  );
}
