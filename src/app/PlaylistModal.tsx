import { IconButton, Modal, Text } from '@glacier/react';
import { Trash2, X } from '@glacier/icons';
import { EmptyArt, type EmptyArtName } from './EmptyArt.tsx';
import type { Track } from './tauri.ts';
import placeholderArt from '../assets/attack-wave.png';

interface PlaylistModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  tracks: Track[];
  emptyLabel: string;
  /** The spot illustration to sit above the empty label, if any. */
  emptyArt?: EmptyArtName;
  onPlay: (track: Track) => void;
  /** Opens the artist's page from a row's artist line; the caller closes the
   *  sheet itself so the page is not buried under it. */
  onOpenArtist?: (artist: string) => void;
  /** Present only for the user's own playlists: sheds one row. */
  onRemoveTrack?: (path: string) => void;
  /** Present only for the user's own playlists: deletes the list whole. */
  onDelete?: () => void;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

/**
 * A playlist opened as a modal: the collection's tracks in a scrolling list,
 * each row playing the song and closing the sheet. A user playlist's rows
 * carry a remove control beside the time - a sibling, not a nested button,
 * because the row itself is one - and a delete row under the list.
 */
export function PlaylistModal({
  open,
  onClose,
  title,
  tracks,
  emptyLabel,
  emptyArt,
  onPlay,
  onOpenArtist,
  onRemoveTrack,
  onDelete,
}: PlaylistModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="md">
      {tracks.length === 0 ? (
        emptyArt ? (
          <div className="emptyState">
            <EmptyArt name={emptyArt} />
            <Text tone="muted">{emptyLabel}</Text>
          </div>
        ) : (
          <Text tone="muted">{emptyLabel}</Text>
        )
      ) : (
        <div className="playlistModalList">
          {tracks.map((track) => (
            <div key={track.path} className="playlistModalItem">
              <button
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
                  {onOpenArtist ? (
                    <span
                      role="link"
                      tabIndex={0}
                      className="songArtist songArtistLink"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenArtist(track.artist);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          onOpenArtist(track.artist);
                        }
                      }}
                    >
                      {track.artist}
                    </span>
                  ) : (
                    <span className="songArtist">{track.artist}</span>
                  )}
                </span>
                <span className="songMuted playlistModalTime">{formatDuration(track.duration)}</span>
              </button>
              {onRemoveTrack && (
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${track.title}`}
                  onClick={() => onRemoveTrack(track.path)}
                >
                  <X size={15} />
                </IconButton>
              )}
            </div>
          ))}
        </div>
      )}
      {onDelete && (
        <button type="button" className="playlistDelete" onClick={onDelete}>
          <Trash2 size={15} />
          Delete playlist
        </button>
      )}
    </Modal>
  );
}
