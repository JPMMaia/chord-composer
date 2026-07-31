import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InstrumentsPanel } from '@/components/InstrumentsPanel';
import { projectStore } from '@/store/projectStore';

describe('InstrumentsPanel', () => {
  beforeEach(() => {
    projectStore.getState().createProject();
  });

  it('renders a titled panel', () => {
    render(<InstrumentsPanel />);
    expect(screen.getByText('Instruments')).toBeInTheDocument();
  });

  it('says instruments are still to come when the project has no tracks', () => {
    render(<InstrumentsPanel />);
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it('lists the project tracks with their instrument label', () => {
    const project = projectStore.getState().project!;
    projectStore.getState().loadProject({
      ...project,
      tracks: [
        { id: 't1', name: 'Piano', instrument: 'acoustic_grand', volume: 1, pan: 0, muted: false, solo: false },
      ],
    });

    render(<InstrumentsPanel />);

    expect(screen.getByText('Piano')).toBeInTheDocument();
    expect(screen.getByText('acoustic_grand')).toBeInTheDocument();
  });
});
