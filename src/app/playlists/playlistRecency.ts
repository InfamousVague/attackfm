/**
 * When each playlist was last PLAYED, remembered on this device.
 *
 * The server stamps a playlist when it is edited (updatedAt), but nothing
 * anywhere records listening to one - plays belong to tracks. Rather than
 * grow a server column for a sort key, the device keeps its own small map:
 * starting a playlist stamps it here, and the Library orders the grid by
 * whichever is newer, the last edit or the last listen. Per-device on
 * purpose - "the playlist I had on yesterday" is a memory about THIS phone.
 */

const KEY = 'attackfm-playlist-played';
const CAP = 200;

function read(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
  } catch {
    // A torn entry reads as "never played anything", which only costs order.
  }
  return {};
}

export function notePlaylistPlayed(id: string): void {
  try {
    const map = read();
    map[id] = Date.now();
    const entries = Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, CAP);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage refusing just means the sort forgets across launches.
  }
}

export function playlistPlayedAt(id: string): number {
  return read()[id] ?? 0;
}
