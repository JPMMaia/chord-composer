import { useEffect, useRef, useState } from 'react';

interface LaneLabelProps {
  label: string;
  /** Absent on a lane the user does not name, which is the volume lane. */
  onRename?: (name: string) => void;
}

/**
 * An automation lane's name in the timeline gutter, renameable in place.
 *
 * Renaming matters more here than it looks. A lane is seeded with whatever the
 * plugin called its target, and for the two cases this app exists to handle that
 * is close to useless: a MIDI controller can only be called "CC 20", and a
 * sampler like Kontakt titles every one of its host-automation slots the same
 * thing. The name a curve carries has to be the user's.
 *
 * Double-click to edit, matching how the section labels and instrument names in
 * this app are already renamed. Enter or blur commits, Escape reverts — and an
 * empty name is refused by the store rather than stored, so a lane can never end
 * up nameless.
 */
export function LaneLabel({ label, onRename }: LaneLabelProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft !== label) onRename?.(draft);
  };

  if (!onRename) {
    return (
      <span className="truncate" title={label}>
        {label}
      </span>
    );
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        aria-label={`Rename ${label} lane`}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          // Stopped here, or the timeline's own shortcuts would read the typing
          // as commands — Delete would remove a block mid-word.
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(label);
            setEditing(false);
          }
        }}
        className="w-full min-w-0 bg-gray-700 border border-indigo-500 rounded text-gray-100 text-xs px-1 focus:outline-none"
      />
    );
  }

  return (
    <span
      className="truncate cursor-text"
      title={`${label} — double-click to rename`}
      onDoubleClick={() => {
        setDraft(label);
        setEditing(true);
      }}
    >
      {label}
    </span>
  );
}
