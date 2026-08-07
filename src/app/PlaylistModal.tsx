import { Modal, Text } from '@glacier/react';
import type { Track } from './tauri.ts';
import placeholderArt from '../assets/attack-wave.png';

interface PlaylistModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  tracks: Track[];
  emptyLabel: string;
  onPlay: (track: Track) => void;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

/**
 * A playlist opened as a modal: the collection's tracks in a scrolling list,
 * each row playing the song and closing the sheet.
 */
export function PlaylistModal({ open, onClose, title, tracks, emptyLabel, onPlay }: PlaylistModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="md">
      {tracks.length === 0 ? (
        <Text tone="muted">{emptyLabel}</Text>
      ) : (
        <div className="playlistModalList">
          {tracks.map((track) => (
            <button
              key={track.path}
              type="button"
              className="playlistModalRow"
              onClick={() => {
                onPlay(track);
                onClose();
              }}
            >
              <img className="songArt" src={track.artwork ?? placeholderArt} alt="" loading="lazy" />
              <span className="playlistModalMeta">
                <span className="songTitle">{track.title}</span>
                <span className="songArtist">{track.artist}</span>
              </span>
              <span className="songMuted playlistModalTime">{formatDuration(track.duration)}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
