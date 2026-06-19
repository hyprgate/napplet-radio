// napps/radio/src/lib/radio-store.ts
// Radio station state — pure TypeScript, no Svelte runes.
// Keep this as .ts (not .svelte.ts) so vitest can import without Svelte compiler.

import type { NostrEvent } from '@hyprgate/types';
import { storage } from '@napplet/sdk';

export interface RadioStream {
  url: string;
  format: string;
  quality: { bitrate?: number; codec?: string; sampleRate?: number } | null;
  primary: boolean;
}

export interface RadioStation {
  id: string;          // d-tag
  name: string;        // name tag
  genres: string[];    // t tags plus WaveFunc c genre tags
  thumbnail: string | null;  // thumbnail tag
  streams: RadioStream[];
  description: string;
  pubkey: string;      // event pubkey
  createdAt: number;   // event created_at
  /** Relay URLs where kind 1311 stream chat events are hosted (from "relays" tag). */
  chatRelays: string[];
}

/**
 * Parse a kind 31237 Nostr event into a RadioStation.
 * Returns null if required fields (d-tag, name tag) are missing.
 */
export function parseKind31237(event: NostrEvent): RadioStation | null {
  const dTag = event.tags.find(t => t[0] === 'd');
  const id = dTag?.[1];
  if (!id) return null;

  const nameTag = event.tags.find(t => t[0] === 'name');
  const name = nameTag?.[1];
  if (!name) return null;

  const genres = [...new Set(event.tags
    .filter(t => t[0] === 't' || (t[0] === 'c' && (t[2] === undefined || t[2] === 'genre')))
    .map(t => t[1])
    .filter((g): g is string => Boolean(g)))];
  const thumbnailTag = event.tags.find(t => t[0] === 'thumbnail');
  const thumbnail = thumbnailTag?.[1] ?? null;

  let streams: RadioStream[] = [];
  let description = '';

  try {
    const content = JSON.parse(event.content);
    description = content.description ?? '';
    if (Array.isArray(content.streams)) {
      streams = content.streams
        .filter((s: Record<string, unknown>) => typeof s.url === 'string' && s.url)
        .map((s: Record<string, unknown>) => ({
          url: s.url as string,
          format: (typeof s.format === 'string' ? s.format : 'audio/mpeg'),
          quality: s.quality && typeof s.quality === 'object' ? s.quality as RadioStream['quality'] : null,
          primary: s.primary === true,
        }));
    }
  } catch {
    // Malformed JSON — streams stays empty, description stays empty
  }

  // Relay URLs from the "relays" tag — where kind 1311 chat events are hosted.
  // Kind 31237 may carry the same "relays" tag as kind 30311 (NIP-53 convention).
  const relaysTag = event.tags.find(t => t[0] === 'relays');
  const chatRelays: string[] = relaysTag ? relaysTag.slice(1).filter((r): r is string => typeof r === 'string' && r.startsWith('wss://')) : [];

  return {
    id,
    name,
    genres,
    thumbnail,
    streams,
    description,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    chatRelays,
  };
}

/** Storage key for the last-selected station ID. */
const LAST_STATION_KEY = 'last-station-id';

const stations = new Map<string, RadioStation>();
let playingId: string | null = null;
let loading = true;

export const radioStore = {
  addStation(station: RadioStation): void {
    stations.set(station.id, station);
  },
  reset(): void {
    stations.clear();
    playingId = null;
    loading = true;
  },
  getStations(): RadioStation[] {
    return Array.from(stations.values());
  },
  getStation(id: string): RadioStation | undefined {
    return stations.get(id);
  },
  setPlaying(id: string | null): void {
    playingId = id;
  },
  getPlaying(): string | null {
    return playingId;
  },
  isLoading(): boolean {
    return loading;
  },
  setLoading(v: boolean): void {
    loading = v;
  },

  /**
   * Persist the last-selected station ID to storage.
   * Fire-and-forget — no await needed for persistence.
   */
  persistLastStation(stationId: string | null): void {
    if (stationId) {
      void storage.setItem(LAST_STATION_KEY, stationId).catch(() => {
        // Ignore storage errors — persistence is best-effort
      });
    } else {
      void storage.removeItem(LAST_STATION_KEY).catch(() => {
        // Ignore storage errors
      });
    }
  },

  /**
   * Restore the last-selected station from storage.
   * Returns the station ID if found in both storage and the current station map,
   * or null if not available.
   */
  async restoreLastStation(): Promise<string | null> {
    try {
      const savedId = await storage.getItem(LAST_STATION_KEY);
      if (!savedId) return null;
      // Only restore if the station exists in the fetched list
      if (stations.has(savedId)) {
        playingId = savedId;
        return savedId;
      }
      return null;
    } catch {
      // Storage read failed — ignore, start fresh
      return null;
    }
  },
};
