import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { trackStore } from '@/store/trackStore';
import { TrackList } from '@/components/TrackList';

describe('TrackList', () => {
  const mockOnSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    trackStore.getState().resetTracks();
    // Add 2 tracks for testing (auto-named so counter increments)
    trackStore.getState().addTrack();
    trackStore.getState().addTrack();
  });

  it('renders all tracks', () => {
    render(<TrackList onSelectTrack={mockOnSelect} />);
    expect(screen.getByText('Track 1')).toBeInTheDocument();
    expect(screen.getByText('Track 2')).toBeInTheDocument();
  });

  it('shows track name', () => {
    render(<TrackList onSelectTrack={mockOnSelect} />);
    expect(screen.getByText('Track 1')).toBeInTheDocument();
  });

  it('shows mute/solo/volume/pan controls', () => {
    render(<TrackList onSelectTrack={mockOnSelect} />);
    const track1 = screen.getByText('Track 1').closest('[data-track-id]');
    expect(track1).toBeInTheDocument();
    // Mute button
    expect(track1?.querySelector('[aria-label="Mute Track 1"]')).toBeInTheDocument();
    // Solo button
    expect(track1?.querySelector('[aria-label="Solo Track 1"]')).toBeInTheDocument();
    // Volume slider
    expect(track1?.querySelector('[aria-label="Volume Track 1"]')).toBeInTheDocument();
    // Pan slider
    expect(track1?.querySelector('[aria-label="Pan Track 1"]')).toBeInTheDocument();
  });

  it('allows adding a new track', () => {
    const { container } = render(<TrackList onSelectTrack={mockOnSelect} />);
    const addBtn = screen.getByText('+ Add Track');
    fireEvent.click(addBtn);
    expect(trackStore.getState().tracks.length).toBe(3);
    expect(screen.getByText('Track 3')).toBeInTheDocument();
  });

  it('allows removing a track', () => {
    render(<TrackList onSelectTrack={mockOnSelect} />);
    const removeBtn = screen.getByRole('button', { name: /remove track 1/i });
    fireEvent.click(removeBtn);
    expect(trackStore.getState().tracks.length).toBe(1);
    expect(screen.queryByText('Track 1')).not.toBeInTheDocument();
  });

  it('highlights the selected track', () => {
    render(<TrackList onSelectTrack={mockOnSelect} selectedTrackId="nonexistent" />);
    // No track should be highlighted
    const tracks = screen.getAllByTestId('track-row');
    tracks.forEach(t => expect(t).not.toHaveClass('bg-indigo-600'));

    const tracksArr = trackStore.getState().tracks;
    render(<TrackList onSelectTrack={mockOnSelect} selectedTrackId={tracksArr[0].id} />);
    const highlighted = screen.getByTestId('track-row-highlighted');
    expect(highlighted).toBeInTheDocument();
  });

  it('toggles mute on button click', () => {
    render(<TrackList onSelectTrack={mockOnSelect} />);
    const muteBtn = screen.getByLabelText('Mute Track 1');
    fireEvent.click(muteBtn);
    expect(trackStore.getState().tracks[0].muted).toBe(true);
    fireEvent.click(muteBtn);
    expect(trackStore.getState().tracks[0].muted).toBe(false);
  });

  it('toggles solo on button click', () => {
    render(<TrackList onSelectTrack={mockOnSelect} />);
    const soloBtn = screen.getByLabelText('Solo Track 1');
    fireEvent.click(soloBtn);
    expect(trackStore.getState().tracks[0].solo).toBe(true);
    fireEvent.click(soloBtn);
    expect(trackStore.getState().tracks[0].solo).toBe(false);
  });

  it('updates volume on slider change', () => {
    render(<TrackList onSelectTrack={mockOnSelect} />);
    const volumeSlider = screen.getByLabelText('Volume Track 1') as HTMLInputElement;
    fireEvent.input(volumeSlider, { target: { value: '0.75' } });
    expect(trackStore.getState().tracks[0].volume).toBeCloseTo(0.75, 2);
  });

  it('updates pan on slider change', () => {
    render(<TrackList onSelectTrack={mockOnSelect} />);
    const panSlider = screen.getByLabelText('Pan Track 1') as HTMLInputElement;
    fireEvent.input(panSlider, { target: { value: '-0.5' } });
    expect(trackStore.getState().tracks[0].pan).toBeCloseTo(-0.5, 2);
  });

  it('calls onSelectTrack when a track is clicked', () => {
    render(<TrackList onSelectTrack={mockOnSelect} />);
    const trackBtn = screen.getByText('Track 1').closest('button');
    fireEvent.click(trackBtn!);
    expect(mockOnSelect).toHaveBeenCalled();
  });
});
