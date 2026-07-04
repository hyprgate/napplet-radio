import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import App from './App.svelte';
import { relay } from '@napplet/sdk';
import { requestRuntimePlayback } from '@hyprgate/utils';
import type { NostrEvent } from '@hyprgate/types';

type RelayEventResult = { event: NostrEvent };

vi.mock('@napplet/sdk', () => ({
  relay: {
    subscribe: vi.fn().mockReturnValue({ close: vi.fn() }),
  },
  inc: {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue({ close: vi.fn() }),
  },
  storage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@hyprgate/utils', () => ({
  createStreamChannelSwitchPayload: vi.fn((payload) => payload),
  createStreamCurrentContextPayload: vi.fn((context, payload) => ({ context, payload })),
  requestRuntimePlayback: vi.fn().mockResolvedValue({ sessionId: 'radio-session', state: { state: 'playing' } }),
  releaseRuntimePlayback: vi.fn().mockResolvedValue(undefined),
  subscribeRuntimePlayback: vi.fn().mockReturnValue({ close: vi.fn() }),
}));

function makeStationEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    kind: 31237,
    id: 'station-event',
    pubkey: 'station-host',
    created_at: 1700000000,
    content: JSON.stringify({
      description: 'Phase 94 station',
      streams: [{ url: 'https://radio.example.test/live.mp3', format: 'audio/mpeg', primary: true }],
    }),
    tags: [
      ['d', 'phase-94-radio'],
      ['name', 'Phase 94 Radio'],
      ['relays', 'wss://relay.example'],
    ],
    sig: 'sig',
    ...overrides,
  };
}

describe('radio app relay subscription', () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('subscribes to WaveFunc stations through an explicit relay hint with the expanded station cap', async () => {
    const component = mount(App, { target: document.body });
    await Promise.resolve();

    expect(relay.subscribe).toHaveBeenCalledWith(
      { kinds: [31237], limit: 1000 },
      expect.any(Function),
      expect.any(Function),
      { relay: 'wss://relay.wavefunc.live' },
    );
    const [filter] = vi.mocked(relay.subscribe).mock.calls[0]!;
    expect(filter).not.toMatchObject({ limit: 100 });
    expect(filter).not.toHaveProperty('until');

    unmount(component);
  });

  it('requests the next station page with an until cursor from the oldest loaded station', async () => {
    const component = mount(App, { target: document.body });
    await Promise.resolve();

    const eventCallback = vi.mocked(relay.subscribe).mock.calls[0]![1] as (result: RelayEventResult) => void;
    const eoseCallback = vi.mocked(relay.subscribe).mock.calls[0]![2] as () => void;
    const firstCreatedAt = 1_700_000_000;
    for (let index = 0; index < 1000; index++) {
      eventCallback({ event: makeStationEvent({ created_at: firstCreatedAt - index }) });
    }
    eoseCallback();
    await tick();

    const button = document.querySelector<HTMLButtonElement>('.load-more-button');
    expect(button?.textContent).toContain('Load more stations');
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    expect(relay.subscribe).toHaveBeenCalledTimes(2);
    expect(vi.mocked(relay.subscribe).mock.calls[1]![0]).toMatchObject({
      kinds: [31237],
      limit: 1000,
      until: firstCreatedAt - 1000,
    });

    unmount(component);
  });

  it('shows terminal no-more copy when a station page returns fewer than the page limit', async () => {
    const component = mount(App, { target: document.body });
    await Promise.resolve();

    const eventCallback = vi.mocked(relay.subscribe).mock.calls[0]![1] as (result: RelayEventResult) => void;
    const eoseCallback = vi.mocked(relay.subscribe).mock.calls[0]![2] as () => void;
    eventCallback({ event: makeStationEvent() });
    eoseCallback();
    await tick();

    expect(document.body.textContent).toContain('No more stations found');
    expect(document.querySelector('.load-more-button')).toBeNull();

    unmount(component);
  });

  it('requests runtime playback with selected station chat context when relay metadata is present', async () => {
    const component = mount(App, { target: document.body });
    await Promise.resolve();

    const eventCallback = vi.mocked(relay.subscribe).mock.calls[0]![1] as (result: RelayEventResult) => void;
    eventCallback({ event: makeStationEvent() });
    await tick();

    const stationButton = document.querySelector<HTMLButtonElement>('button[title="Phase 94 Radio"]');
    expect(stationButton).not.toBeNull();
    stationButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requestRuntimePlayback).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Phase 94 Radio',
      context: expect.objectContaining({
        label: 'Radio',
        chat: {
          streamAddr: '30311:station-host:phase-94-radio',
          title: 'Phase 94 Radio',
          chatRelays: ['wss://relay.example'],
        },
      }),
    }));

    unmount(component);
  });
});
