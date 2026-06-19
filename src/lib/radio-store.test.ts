import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@napplet/sdk', () => ({
  relay: {
    subscribe: vi.fn().mockReturnValue({ close: vi.fn() }),
    publish: vi.fn().mockResolvedValue({}),
    query: vi.fn().mockResolvedValue([]),
  },
  identity: { getPublicKey: vi.fn().mockResolvedValue('a'.repeat(64)) },
  ipc: {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue({ close: vi.fn() }),
  },
  storage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
  },
  media: {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
    updateSession: vi.fn(),
    destroySession: vi.fn(),
    reportState: vi.fn(),
    reportCapabilities: vi.fn(),
    onCommand: vi.fn().mockReturnValue({ close: vi.fn() }),
    onControls: vi.fn().mockReturnValue({ close: vi.fn() }),
  },
}));

import { parseKind31237, radioStore } from './radio-store.js';
import { storage } from '@napplet/sdk';
import type { NostrEvent } from '@hyprgate/types';

function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'test-id',
    pubkey: 'test-pubkey',
    created_at: 1700000000,
    kind: 31237,
    tags: [
      ['d', 'station-1'],
      ['name', 'Test Radio'],
      ['t', 'rock'],
      ['t', 'indie'],
      ['thumbnail', 'https://example.com/logo.png'],
    ],
    content: JSON.stringify({
      description: 'A test radio station',
      streams: [
        {
          url: 'https://stream.example.com/live',
          format: 'audio/mpeg',
          quality: { bitrate: 128, codec: 'mp3', sampleRate: 44100 },
          primary: true,
        },
      ],
    }),
    sig: 'test-sig',
    ...overrides,
  };
}

describe('parseKind31237', () => {
  it('parses valid event with streams in content JSON', () => {
    const station = parseKind31237(makeEvent());
    expect(station).not.toBeNull();
    expect(station!.id).toBe('station-1');
    expect(station!.name).toBe('Test Radio');
    expect(station!.genres).toEqual(['rock', 'indie']);
    expect(station!.thumbnail).toBe('https://example.com/logo.png');
    expect(station!.streams).toHaveLength(1);
    expect(station!.streams[0]!.url).toBe('https://stream.example.com/live');
    expect(station!.streams[0]!.format).toBe('audio/mpeg');
    expect(station!.streams[0]!.primary).toBe(true);
    expect(station!.streams[0]!.quality).toEqual({ bitrate: 128, codec: 'mp3', sampleRate: 44100 });
    expect(station!.description).toBe('A test radio station');
    expect(station!.pubkey).toBe('test-pubkey');
    expect(station!.createdAt).toBe(1700000000);
  });

  it('returns null when d-tag is missing', () => {
    const event = makeEvent({
      tags: [['name', 'Test Radio']],
    });
    expect(parseKind31237(event)).toBeNull();
  });

  it('returns null when name tag is missing', () => {
    const event = makeEvent({
      tags: [['d', 'station-1']],
    });
    expect(parseKind31237(event)).toBeNull();
  });

  it('returns RadioStation with empty streams on malformed JSON content', () => {
    const event = makeEvent({ content: 'not valid json{{{' });
    const station = parseKind31237(event);
    expect(station).not.toBeNull();
    expect(station!.streams).toEqual([]);
    expect(station!.description).toBe('');
  });

  it('returns RadioStation with empty streams when content has no streams array', () => {
    const event = makeEvent({ content: JSON.stringify({ description: 'no streams' }) });
    const station = parseKind31237(event);
    expect(station).not.toBeNull();
    expect(station!.streams).toEqual([]);
    expect(station!.description).toBe('no streams');
  });

  it('extracts multiple genre t tags', () => {
    const event = makeEvent({
      tags: [
        ['d', 'station-1'],
        ['name', 'Multi Genre'],
        ['t', 'rock'],
        ['t', 'jazz'],
        ['t', 'electronic'],
      ],
    });
    const station = parseKind31237(event);
    expect(station!.genres).toEqual(['rock', 'jazz', 'electronic']);
  });

  it('extracts WaveFunc c genre tags', () => {
    const event = makeEvent({
      tags: [
        ['d', 'station-1'],
        ['name', 'WaveFunc Radio'],
        ['c', 'local', 'genre'],
        ['c', 'latin', 'genre'],
        ['c', 'podcast', 'format'],
      ],
    });
    const station = parseKind31237(event);
    expect(station!.genres).toEqual(['local', 'latin']);
  });

  it('deduplicates genres across t and c tags', () => {
    const event = makeEvent({
      tags: [
        ['d', 'station-1'],
        ['name', 'Deduped Radio'],
        ['t', 'local'],
        ['c', 'local', 'genre'],
        ['c', 'jazz', 'genre'],
      ],
    });
    const station = parseKind31237(event);
    expect(station!.genres).toEqual(['local', 'jazz']);
  });

  it('filters out stream objects missing url', () => {
    const event = makeEvent({
      content: JSON.stringify({
        streams: [
          { url: 'https://valid.example.com/stream', format: 'audio/mpeg' },
          { format: 'audio/aac' }, // missing url
          { url: '', format: 'audio/ogg' }, // empty url
        ],
      }),
    });
    const station = parseKind31237(event);
    expect(station!.streams).toHaveLength(1);
    expect(station!.streams[0]!.url).toBe('https://valid.example.com/stream');
  });

  it('defaults format to audio/mpeg when not specified', () => {
    const event = makeEvent({
      content: JSON.stringify({
        streams: [{ url: 'https://stream.example.com/live', primary: false }],
      }),
    });
    const station = parseKind31237(event);
    expect(station!.streams[0]!.format).toBe('audio/mpeg');
  });

  it('returns thumbnail null when thumbnail tag is absent', () => {
    const event = makeEvent({
      tags: [['d', 'station-1'], ['name', 'No Thumb']],
    });
    const station = parseKind31237(event);
    expect(station!.thumbnail).toBeNull();
  });
});

describe('radioStore', () => {
  beforeEach(() => {
    // Reset store state by clearing and re-adding
    // Since the store uses a module-level Map, we need to clear it
    for (const s of radioStore.getStations()) {
      // No remove method, but we can test addStation overwrites
    }
    radioStore.setPlaying(null);
    radioStore.setLoading(true);
  });

  it('addStation + getStations returns added stations', () => {
    const station = parseKind31237(makeEvent())!;
    radioStore.addStation(station);
    const stations = radioStore.getStations();
    expect(stations.some(s => s.id === 'station-1')).toBe(true);
  });

  it('setPlaying + getPlaying returns correct id', () => {
    radioStore.setPlaying('station-1');
    expect(radioStore.getPlaying()).toBe('station-1');
  });

  it('setPlaying null clears playing', () => {
    radioStore.setPlaying('station-1');
    radioStore.setPlaying(null);
    expect(radioStore.getPlaying()).toBeNull();
  });

  it('setLoading + isLoading returns correct value', () => {
    radioStore.setLoading(false);
    expect(radioStore.isLoading()).toBe(false);
    radioStore.setLoading(true);
    expect(radioStore.isLoading()).toBe(true);
  });

  it('addStation with duplicate id replaces existing entry', () => {
    const station1 = parseKind31237(makeEvent())!;
    radioStore.addStation(station1);

    const updatedEvent = makeEvent({
      tags: [
        ['d', 'station-1'],
        ['name', 'Updated Radio'],
      ],
    });
    const station2 = parseKind31237(updatedEvent)!;
    radioStore.addStation(station2);

    const found = radioStore.getStation('station-1');
    expect(found!.name).toBe('Updated Radio');
  });
});

describe('last station persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storage.setItem).mockResolvedValue(undefined);
    vi.mocked(storage.removeItem).mockResolvedValue(undefined);
    radioStore.setPlaying(null);
  });

  it('persistLastStation writes station ID to storage', () => {
    radioStore.persistLastStation('station-1');
    expect(storage.setItem).toHaveBeenCalledWith('last-station-id', 'station-1');
  });

  it('persistLastStation with null removes the key', () => {
    radioStore.persistLastStation(null);
    expect(storage.removeItem).toHaveBeenCalledWith('last-station-id');
  });

  it('restoreLastStation sets playingId when station exists', async () => {
    vi.mocked(storage.getItem).mockResolvedValue('station-1');
    // Add a station to the store first
    radioStore.addStation(parseKind31237(makeEvent())!);

    const result = await radioStore.restoreLastStation();
    expect(result).toBe('station-1');
    expect(radioStore.getPlaying()).toBe('station-1');
  });

  it('restoreLastStation returns null when no saved station', async () => {
    vi.mocked(storage.getItem).mockResolvedValue(null);

    const result = await radioStore.restoreLastStation();
    expect(result).toBeNull();
    expect(radioStore.getPlaying()).toBeNull();
  });

  it('restoreLastStation returns null when saved station not in map', async () => {
    vi.mocked(storage.getItem).mockResolvedValue('nonexistent-id');

    const result = await radioStore.restoreLastStation();
    expect(result).toBeNull();
  });
});
