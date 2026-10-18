import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import App from './App.svelte';
import { inc, relay, storage } from '@napplet/sdk';
import { requestRuntimePlayback, subscribeRuntimePlayback } from '@hyprgate/utils';
import type { NostrEvent } from '@hyprgate/types';

type RelayEventResult = { event: NostrEvent };

const coverImageMock = vi.hoisted(() => {
  const state = {
    autoResolve: true,
    callbacks: new Map<string, (valid: boolean) => void>(),
    results: new Map<string, boolean>(),
  };
  const coverImageResolves = vi.fn((source: string | null | undefined) => {
    const key = source ?? '';
    if (state.autoResolve) {
      return Promise.resolve(source ? state.results.get(key) ?? true : false);
    }
    return new Promise<boolean>((resolve) => {
      state.callbacks.set(key, resolve);
    });
  });
  return { coverImageResolves, state };
});

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
  resourceImage: vi.fn(() => ({ destroy: vi.fn(), update: vi.fn() })),
  releaseRuntimePlayback: vi.fn().mockResolvedValue(undefined),
  subscribeRuntimePlayback: vi.fn().mockReturnValue({ close: vi.fn() }),
}));

vi.mock('./lib/radio-cover-image.js', () => ({
  coverImageResolves: coverImageMock.coverImageResolves,
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
      ['thumbnail', 'https://cover.example.test/phase-94.png'],
      ['relays', 'wss://relay.example'],
    ],
    sig: 'sig',
    ...overrides,
  };
}

describe('radio app relay subscription', () => {
  afterEach(() => {
    vi.clearAllMocks();
    coverImageMock.state.autoResolve = true;
    coverImageMock.state.callbacks.clear();
    coverImageMock.state.results.clear();
    document.body.innerHTML = '';
  });

  beforeEach(() => {
    coverImageMock.state.autoResolve = true;
  });

  async function waitForInitialSubscription(): Promise<void> {
    await vi.waitFor(() => {
      expect(relay.subscribe).toHaveBeenCalled();
    });
  }

  it.each(['idle', null] as const)('keeps radio selected through loading/pause and clears stopped or released playback (%s)', async (status) => {
    const component = mount(App, { target: document.body });
    await waitForInitialSubscription();
    const eventCallback = vi.mocked(relay.subscribe).mock.calls[0]![1] as (result: RelayEventResult) => void;
    eventCallback({ event: makeStationEvent() });
    await vi.waitFor(() => expect(document.querySelector('button[title="Phase 94 Radio"]')).not.toBeNull());
    const card = document.querySelector<HTMLButtonElement>('button[title="Phase 94 Radio"]')!;
    card.click();
    await vi.waitFor(() => expect(subscribeRuntimePlayback).toHaveBeenCalled());
    const onState = vi.mocked(subscribeRuntimePlayback).mock.calls[0]![1];
    const runtimeState = { sessionId: 'radio-session', windowId: '', position: 0, duration: null, volume: 0.7, muted: false };
    for (const [state, badge] of [['loading', 'TUNING'], ['playing', 'LIVE'], ['paused', 'PAUSED']] as const) {
      onState({ ...runtimeState, state });
      await tick();
      expect(card.getAttribute('aria-pressed')).toBe('true');
      expect(card.querySelector('.badge')?.textContent?.trim()).toBe(badge);
      expect(card.querySelector('.is-buffering') !== null).toBe(state === 'loading');
      expect(card.querySelector('.live-dot') !== null).toBe(state !== 'paused');
    }
    onState(status === null ? null : { ...runtimeState, state: status });
    await tick();
    expect(card.getAttribute('aria-pressed')).toBe('false');
    expect(card.querySelector('.badge')).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith('last-station-id');
    const [, onContext] = vi.mocked(inc.on).mock.calls.find(([topic]) => topic === 'stream:current-context-get')!;
    onContext!({ topic: 'stream:current-context-get', sender: 'chat', payload: {} });
    expect(inc.emit).toHaveBeenLastCalledWith('stream:current-context', JSON.stringify({
      context: { streamAddr: null, title: null, chatRelays: [] }, payload: {},
    }));
    card.click();
    await vi.waitFor(() => expect(requestRuntimePlayback).toHaveBeenCalledTimes(2));
    await unmount(component);
  });

  it('keeps the station request within WaveFunc’s 500-event maximum', async () => {
    const component = mount(App, { target: document.body });
    await waitForInitialSubscription();

    expect(relay.subscribe).toHaveBeenCalledWith(
      { kinds: [31237], limit: 500 },
      expect.any(Function),
      expect.any(Function),
      { relay: 'wss://relay.wavefunc.live' },
    );
    const [filter] = vi.mocked(relay.subscribe).mock.calls[0]!;
    expect(filter).not.toMatchObject({ limit: 100 });
    expect(filter).not.toHaveProperty('until');
    expect(coverImageMock.coverImageResolves).not.toHaveBeenCalled();

    unmount(component);
  });

  it('requests the next station page with an until cursor from the oldest loaded station', async () => {
    const component = mount(App, { target: document.body });
    await waitForInitialSubscription();

    const eventCallback = vi.mocked(relay.subscribe).mock.calls[0]![1] as (result: RelayEventResult) => void;
    const eoseCallback = vi.mocked(relay.subscribe).mock.calls[0]![2] as () => void;
    const firstCreatedAt = 1_700_000_000;
    for (let index = 0; index < 500; index++) {
      eventCallback({ event: makeStationEvent({ created_at: firstCreatedAt - index }) });
    }
    eoseCallback();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>('.load-more-button')).not.toBeNull();
    });

    const button = document.querySelector<HTMLButtonElement>('.load-more-button');
    expect(button?.textContent).toContain('Load more stations');
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    expect(relay.subscribe).toHaveBeenCalledTimes(2);
    expect(vi.mocked(relay.subscribe).mock.calls[1]![0]).toMatchObject({
      kinds: [31237],
      limit: 500,
      until: firstCreatedAt - 500,
    });

    unmount(component);
  });

  it('shows terminal no-more copy when a station page returns fewer than the page limit', async () => {
    const component = mount(App, { target: document.body });
    await waitForInitialSubscription();

    const eventCallback = vi.mocked(relay.subscribe).mock.calls[0]![1] as (result: RelayEventResult) => void;
    const eoseCallback = vi.mocked(relay.subscribe).mock.calls[0]![2] as () => void;
    eventCallback({ event: makeStationEvent() });
    eoseCallback();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('No more stations found');
    });

    expect(document.body.textContent).toContain('No more stations found');
    expect(document.querySelector('.load-more-button')).toBeNull();

    unmount(component);
  });

  it('requests runtime playback with selected station chat context when relay metadata is present', async () => {
    const component = mount(App, { target: document.body });
    await waitForInitialSubscription();

    const eventCallback = vi.mocked(relay.subscribe).mock.calls[0]![1] as (result: RelayEventResult) => void;
    eventCallback({ event: makeStationEvent() });
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>('button[title="Phase 94 Radio"]')).not.toBeNull();
    });

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

  it('responds to a one-event stream-context request with only its optional payload', async () => {
    const component = mount(App, { target: document.body });
    await waitForInitialSubscription();

    const [, callback] = vi.mocked(inc.on).mock.calls.find(
      ([topic]) => topic === 'stream:current-context-get',
    )!;
    const payload = { requestId: 'warm-context-request' };
    callback!({
      topic: 'stream:current-context-get',
      sender: 'runtime-attested-stream',
      payload,
    });

    expect(inc.emit).toHaveBeenCalledWith(
      'stream:current-context',
      JSON.stringify({
        context: { streamAddr: null, title: null, chatRelays: [] },
        payload,
      }),
    );

    unmount(component);
  });

  it('keeps a station hidden until its cover image resource resolves to a loadable image', async () => {
    coverImageMock.state.autoResolve = false;
    const component = mount(App, { target: document.body });
    await waitForInitialSubscription();

    const eventCallback = vi.mocked(relay.subscribe).mock.calls[0]![1] as (result: RelayEventResult) => void;
    const station = makeStationEvent();
    eventCallback({ event: station });
    await tick();

    expect(document.querySelector<HTMLButtonElement>('button[title="Phase 94 Radio"]')).toBeNull();
    expect(document.querySelector('[data-radio-root]')?.getAttribute('data-radio-count')).toBe('0');

    coverImageMock.state.callbacks.get('https://cover.example.test/phase-94.png')?.(true);

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>('button[title="Phase 94 Radio"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-radio-root]')?.getAttribute('data-radio-count')).toBe('1');

    unmount(component);
  });

  it('does not show stations whose cover image resource resolves to a broken image', async () => {
    const brokenCover = 'https://cover.example.test/broken.png';
    coverImageMock.state.results.set(brokenCover, false);

    const component = mount(App, { target: document.body });
    await waitForInitialSubscription();

    const eventCallback = vi.mocked(relay.subscribe).mock.calls[0]![1] as (result: RelayEventResult) => void;
    const eoseCallback = vi.mocked(relay.subscribe).mock.calls[0]![2] as () => void;
    eventCallback({
      event: makeStationEvent({
        tags: [
          ['d', 'broken-cover-radio'],
          ['name', 'Broken Cover Radio'],
          ['thumbnail', brokenCover],
        ],
      }),
    });
    eoseCallback();

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('No stations found');
    });
    expect(document.querySelector<HTMLButtonElement>('button[title="Broken Cover Radio"]')).toBeNull();
    expect(document.querySelector('[data-radio-root]')?.getAttribute('data-radio-count')).toBe('0');

    unmount(component);
  });

  it('does not show stations without a cover image resource', async () => {
    const component = mount(App, { target: document.body });
    await waitForInitialSubscription();

    const eventCallback = vi.mocked(relay.subscribe).mock.calls[0]![1] as (result: RelayEventResult) => void;
    const eoseCallback = vi.mocked(relay.subscribe).mock.calls[0]![2] as () => void;
    eventCallback({
      event: makeStationEvent({
        tags: [
          ['d', 'missing-cover-radio'],
          ['name', 'Missing Cover Radio'],
        ],
      }),
    });
    eoseCallback();

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('No stations found');
    });
    expect(document.querySelector<HTMLButtonElement>('button[title="Missing Cover Radio"]')).toBeNull();
    expect(coverImageMock.coverImageResolves).toHaveBeenCalledWith(null);

    unmount(component);
  });
});
