import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import {
  freeBarAfter,
  phraseById,
  phraseColorAt,
  phraseLengthBars,
  placementCount,
} from '@/engine/phrases';
import { TRACK_COLORS } from '@/utils/constants';

/**
 * What the selected block in the arrangement is, and the things only it can do.
 *
 * A block is a *placement*, so this panel edits two things at once and has to keep
 * them apart: the name, colour and length belong to the phrase and so reach every
 * placement of it, while Remove takes away this one placement and leaves the phrase
 * in the library. The placement count is what makes that difference visible — without
 * it, renaming a phrase would silently rename three blocks the user cannot see.
 *
 * Duplicate and Duplicate Linked are the two ways out of one block: the first copies
 * the music too, the second places the same phrase again. Make Unique is the escape
 * hatch from that sharing: it deep-copies the phrase for
 * this block alone, which is what turns "the third chorus, but different" from a
 * reason not to duplicate into an ordinary edit.
 */
export const PhraseInspector: React.FC = () => {
  const project = projectStore(s => s.project);
  const renamePhrase = projectStore(s => s.renamePhrase);
  const setPhraseColor = projectStore(s => s.setPhraseColor);
  const setPhraseLength = projectStore(s => s.setPhraseLength);
  const duplicateClip = projectStore(s => s.duplicateClip);
  const linkClip = projectStore(s => s.linkClip);
  const makeClipUnique = projectStore(s => s.makeClipUnique);
  const removeClip = projectStore(s => s.removeClip);
  const openClip = projectStore(s => s.openClip);

  const selectedClipId = selectionStore(s => s.selectedClipId);
  const selectClip = selectionStore(s => s.selectClip);

  const clip = project?.clips.find(c => c.id === selectedClipId) ?? null;
  const phrase = clip && project ? phraseById(project.phrases, clip.phraseId) : null;

  if (!project || !clip || !phrase) return null;

  const placements = placementCount(project.clips, phrase.id);
  const track = project.tracks.find(t => t.id === clip.trackId);
  const color =
    phrase.color ?? phraseColorAt(project.phrases.findIndex(p => p.id === phrase.id));

  return (
    <div className="pt-2 border-t border-gray-700 space-y-3" data-testid="phrase-inspector">
      <div className="flex items-center gap-2">
        <span
          style={{ backgroundColor: color }}
          className="shrink-0 w-3 h-3 rounded-sm"
          aria-hidden
        />
        <input
          data-testid="phrase-inspector-name"
          aria-label="Phrase name"
          value={phrase.name}
          onChange={e => renamePhrase(phrase.id, e.target.value)}
          className="min-w-0 flex-1 bg-gray-700 border border-gray-600 rounded text-sm text-gray-100 px-1 focus:outline-none focus:border-indigo-500"
        />
      </div>

      <div className="text-xs text-gray-500">
        Bars {clip.startBar + 1}–{clip.startBar + phraseLengthBars(phrase)}
        {track && ` · ${track.name}`}
      </div>

      <label className="flex items-center justify-between gap-2 text-xs text-gray-400">
        Length
        <span className="flex items-center gap-1">
          <input
            data-testid="phrase-length"
            aria-label="Phrase length in bars"
            type="number"
            min={1}
            value={phraseLengthBars(phrase)}
            onChange={e => setPhraseLength(phrase.id, Math.max(1, Number(e.target.value) || 1))}
            className="w-14 bg-gray-700 border border-gray-600 rounded text-gray-200 px-1 focus:outline-none focus:border-indigo-500"
          />
          bars
        </span>
      </label>

      <div className="flex flex-wrap gap-1" role="group" aria-label="Phrase colour">
        {TRACK_COLORS.map(swatch => (
          <button
            key={swatch}
            type="button"
            aria-label={`Colour ${swatch}`}
            aria-pressed={color === swatch}
            onClick={() => setPhraseColor(phrase.id, swatch)}
            style={{ backgroundColor: swatch }}
            className={`w-4 h-4 rounded-sm border ${
              color === swatch ? 'border-gray-100' : 'border-transparent'
            }`}
          />
        ))}
      </div>

      {/* The whole point of a linked block, and the thing that would otherwise
          surprise: an edit made here reaches places the user is not looking at. */}
      {placements > 1 && (
        <p data-testid="phrase-placements" className="text-xs text-amber-400">
          Played in {placements} places — editing it changes them all.
        </p>
      )}

      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => openClip(clip.id)}
          className="px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-xs text-gray-100 transition-colors"
        >
          Edit
        </button>

        {/* The two ways to repeat a block, named for what they leave behind rather
            than for the gesture. Both land on the first free bar after this one. */}
        <button
          type="button"
          data-testid="duplicate-clip"
          title="Copy this block and its music, so editing the copy leaves this one alone"
          onClick={() => {
            const id = duplicateClip(
              clip.id,
              clip.trackId,
              freeBarAfter(project.clips, project.phrases, clip)
            );
            if (id) selectClip(id);
          }}
          className="px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 transition-colors"
        >
          Duplicate
        </button>

        <button
          type="button"
          data-testid="link-clip"
          title="Play the same phrase again — editing either changes both"
          onClick={() => {
            const id = linkClip(
              clip.id,
              clip.trackId,
              freeBarAfter(project.clips, project.phrases, clip)
            );
            if (id) selectClip(id);
          }}
          className="px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 transition-colors"
        >
          Duplicate linked
        </button>

        {/* Only where there is sharing to break. On a phrase played once it would
            do nothing but make a second copy of a name. */}
        {placements > 1 && (
          <button
            type="button"
            data-testid="make-unique"
            title="Give this block its own copy, so editing it leaves the others alone"
            onClick={() => makeClipUnique(clip.id)}
            className="px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 transition-colors"
          >
            Make unique
          </button>
        )}

        <button
          type="button"
          data-testid="remove-clip"
          title="Take this placement away. The phrase stays, unplaced."
          onClick={() => {
            removeClip(clip.id);
            selectClip(null);
          }}
          className="px-2 py-0.5 rounded bg-gray-700 hover:bg-red-600 text-xs text-gray-300 hover:text-white transition-colors"
        >
          Remove
        </button>
      </div>
    </div>
  );
};
