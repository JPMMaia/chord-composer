import React from 'react';
import { trackStore } from '@/store/trackStore';

interface TrackListProps {
  selectedTrackId: string | null;
  onSelectTrack: (trackId: string) => void;
}

/**
 * Track header list with mute/solo/volume/pan controls per track.
 */
export const TrackList: React.FC<TrackListProps> = ({
  selectedTrackId,
  onSelectTrack,
}) => {
  const tracks = trackStore(s => s.tracks);
  const addTrack = trackStore(s => s.addTrack);
  const removeTrack = trackStore(s => s.removeTrack);
  const toggleTrackMute = trackStore(s => s.toggleTrackMute);
  const toggleTrackSolo = trackStore(s => s.toggleTrackSolo);
  const setTrackVolume = trackStore(s => s.setTrackVolume);
  const setTrackPan = trackStore(s => s.setTrackPan);

  const handleVolumeChange = (trackId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    if (!isNaN(value)) {
      setTrackVolume(trackId, Math.max(0, Math.min(1, value)));
    }
  };

  const handlePanChange = (trackId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    if (!isNaN(value)) {
      setTrackPan(trackId, Math.max(-1, Math.min(1, value)));
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-800">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 bg-gray-800">
        <h2 className="text-sm font-semibold text-gray-300">Tracks</h2>
        <button
          onClick={() => addTrack()}
          className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors px-2 py-1 rounded hover:bg-gray-700"
          aria-label="Add Track"
        >
          + Add
        </button>
      </div>

      {/* Track list */}
      <div className="flex-1 overflow-y-auto">
        {tracks.map(track => (
          <div
            key={track.id}
            data-track-id={track.id}
            data-testid={selectedTrackId === track.id ? 'track-row-highlighted' : 'track-row'}
            className={`border-b border-gray-700 transition-colors ${
              selectedTrackId === track.id ? 'bg-indigo-600' : 'bg-gray-800 hover:bg-gray-700'
            }`}
          >
            {/* Track header row */}
            <button
              onClick={() => onSelectTrack(track.id)}
              className="w-full text-left px-3 py-2 flex items-center justify-between"
            >
              <span className="text-sm font-medium text-gray-200 truncate">
                {track.name}
              </span>
              <button
                onClick={e => {
                  e.stopPropagation();
                  removeTrack(track.id);
                }}
                className="text-gray-500 hover:text-red-400 transition-colors ml-2 flex-shrink-0"
                aria-label={`Remove ${track.name}`}
                title="Remove track"
              >
                ✕
              </button>
            </button>

            {/* Controls row */}
            <div className="px-3 pb-2 flex items-center gap-2">
              {/* Mute */}
              <button
                onClick={() => toggleTrackMute(track.id)}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  track.muted
                    ? 'bg-red-600 text-white'
                    : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                }`}
                aria-label={`Mute ${track.name}`}
                title="Mute"
              >
                M
              </button>

              {/* Solo */}
              <button
                onClick={() => toggleTrackSolo(track.id)}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  track.solo
                    ? 'bg-yellow-600 text-white'
                    : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                }`}
                aria-label={`Solo ${track.name}`}
                title="Solo"
              >
                S
              </button>

              {/* Volume */}
              <div className="flex-1 flex items-center gap-1">
                <span className="text-xs text-gray-400 w-4">V</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={track.volume}
                  onChange={e => handleVolumeChange(track.id, e)}
                  className="flex-1 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  aria-label={`Volume ${track.name}`}
                  title="Volume"
                />
              </div>

              {/* Pan */}
              <div className="flex items-center gap-1">
                <span className="text-xs text-gray-400 w-4">P</span>
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step="0.01"
                  value={track.pan}
                  onChange={e => handlePanChange(track.id, e)}
                  className="w-12 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  aria-label={`Pan ${track.name}`}
                  title="Pan"
                />
              </div>
            </div>
          </div>
        ))}

        {/* Add track button at bottom */}
        <button
          onClick={() => addTrack()}
          className="w-full text-left px-3 py-2 text-sm text-indigo-400 hover:bg-gray-700 transition-colors border-t border-gray-700"
        >
          + Add Track
        </button>
      </div>
    </div>
  );
};
