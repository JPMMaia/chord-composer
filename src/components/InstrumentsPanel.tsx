import React from 'react';
import { projectStore } from '@/store/projectStore';

/**
 * Placeholder for the instruments sidebar that replaces the old bar navigator.
 *
 * Deliberately thin: it lists what the project already has and says nothing more.
 * `TrackList` is the fully-built component a later pass will wire up here.
 */
export const InstrumentsPanel: React.FC = () => {
  const tracks = projectStore(s => s.project?.tracks) ?? [];

  return (
    <div className="w-48 bg-gray-800 border-r border-gray-700 overflow-y-auto">
      <div className="p-3 border-b border-gray-700">
        <h2 className="text-sm font-semibold text-gray-300">Instruments</h2>
      </div>

      {tracks.map(track => (
        <div key={track.id} className="px-3 py-2 border-b border-gray-700">
          <div className="text-sm text-gray-200">{track.name}</div>
          <div className="text-xs text-gray-500">{track.instrument}</div>
        </div>
      ))}

      <p className="p-3 text-xs text-gray-500 italic">Instruments coming soon</p>
    </div>
  );
};
