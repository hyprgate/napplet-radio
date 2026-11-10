import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import App from './App.svelte';
import { inc, intent, relay, storage } from '@napplet/sdk';
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
  intent: {
    onDelivery: vi.fn().mockReturnValue({ close: vi.fn() }),
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
      expect(document.body.textContent).toContain("That's all the stations we found");
    });

    expect(document.body.textContent).toContain("That's all the stations we found");
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
      expect(document.body.textContent).toContain('No stations yet');
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
      expect(document.body.textContent).toContain('No stations yet');
    });
    expect(document.querySelector<HTMLButtonElement>('button[title="Missing Cover Radio"]')).toBeNull();
    expect(coverImageMock.coverImageResolves).toHaveBeenCalledWith(null);

    unmount(component);
  });

  async function mountWithStation(): Promise<{ component: ReturnType<typeof mount>; card: HTMLButtonElement }> {
    const component = mount(App, { target: document.body });
    await waitForInitialSubscription();
    const eventCallback = vi.mocked(relay.subscribe).mock.calls[0]![1] as (result: RelayEventResult) => void;
    eventCallback({ event: makeStationEvent() });
    await vi.waitFor(() => expect(document.querySelector('button[title="Phase 94 Radio"]')).not.toBeNull());
    return { component, card: document.querySelector<HTMLButtonElement>('button[title="Phase 94 Radio"]')! };
  }

  it('shows the station description on the card', async () => {
    const { component } = await mountWithStation();

    expect(document.querySelector('.description')?.textContent).toBe('Phase 94 station');

    unmount(component);
  });

  it('names what is playing, and says so when it never starts', async () => {
    vi.mocked(requestRuntimePlayback).mockResolvedValueOnce({ sessionId: 'radio-session' });
    const { component, card } = await mountWithStation();
    card.click();
    await vi.waitFor(() => expect(subscribeRuntimePlayback).toHaveBeenCalled());
    await vi.waitFor(() => expect(document.querySelector('[data-radio-now-playing]')?.textContent).toContain('Tuning in to'));
    const onState = vi.mocked(subscribeRuntimePlayback).mock.calls[0]![1];

    onState({ sessionId: 'radio-session', windowId: '', state: 'idle', position: 0, duration: null, volume: 1, muted: false });
    await vi.waitFor(() => expect(document.querySelector('[data-radio-now-playing]')?.textContent).toContain("Couldn't play Phase 94 Radio"));
    expect(card.querySelector('.badge-failed')?.textContent).toBe("Can't play");
    expect(card.getAttribute('aria-pressed')).toBe('false');

    unmount(component);
  });

  it('does not call stopping a playing station a failure', async () => {
    const { component, card } = await mountWithStation();
    card.click();
    await vi.waitFor(() => expect(subscribeRuntimePlayback).toHaveBeenCalled());
    const onState = vi.mocked(subscribeRuntimePlayback).mock.calls[0]![1];
    const runtime = { sessionId: 'radio-session', windowId: '', position: 0, duration: null, volume: 1, muted: false };

    onState({ ...runtime, state: 'playing' });
    await tick();
    onState({ ...runtime, state: 'idle' });
    await vi.waitFor(() => expect(document.querySelector('[data-radio-now-playing]')).toBeNull());
    expect(card.querySelector('.badge-failed')).toBeNull();

    unmount(component);
  });

  it('keeps long genre lists short until asked, and keeps the active one in view', async () => {
    const component = mount(App, { target: document.body });
    await waitForInitialSubscription();
    const eventCallback = vi.mocked(relay.subscribe).mock.calls[0]![1] as (result: RelayEventResult) => void;
    const names = Array.from({ length: 12 }, (_, index) => `genre-${index}`);
    eventCallback({ event: makeStationEvent({ tags: [['d', 'many'], ['name', 'Many'], ['thumbnail', 'https://cover.example.test/m.png'], ...names.map((name) => ['t', name])] }) });
    await vi.waitFor(() => expect(document.querySelector('.genre-more')).not.toBeNull());

    const pills = () => [...document.querySelectorAll('.genre-pill')].map((pill) => pill.textContent);
    expect(pills()).toHaveLength(9);
    expect(document.querySelector('.genre-more')?.textContent).toBe('4 more');

    document.querySelector<HTMLButtonElement>('.genre-more')!.click();
    await tick();
    expect(pills()).toHaveLength(13);

    [...document.querySelectorAll<HTMLButtonElement>('.genre-pill')].find((pill) => pill.textContent === 'genre-11')!.click();
    await tick();
    document.querySelector<HTMLButtonElement>('.genre-more')!.click();
    await tick();
    expect(pills()).toContain('genre-11');

    unmount(component);
  });

  it('holds places for stations still waiting on a cover check', async () => {
    coverImageMock.state.autoResolve = false;
    const component = mount(App, { target: document.body });
    await waitForInitialSubscription();
    const eventCallback = vi.mocked(relay.subscribe).mock.calls[0]![1] as (result: RelayEventResult) => void;
    eventCallback({ event: makeStationEvent() });
    await vi.waitFor(() => expect(document.querySelector('[data-radio-skeleton]')).not.toBeNull());
    expect(document.querySelector('button[title="Phase 94 Radio"]')).toBeNull();

    unmount(component);
  });

  describe('napplet:radio/play', () => {
    type Delivery = Parameters<Parameters<typeof intent.onDelivery>[0]>[0];

    function stationEvent(id: string, name: string, genres: string[], createdAt = 1700000000): NostrEvent {
      return makeStationEvent({
        id: `event-${id}`,
        created_at: createdAt,
        tags: [
          ['d', id], ['name', name], ['thumbnail', `https://cover.example.test/${id}.png`],
          ...genres.map((genre) => ['t', genre]),
        ],
      });
    }

    function pageCallbacks(call: number): { onEvent: (result: RelayEventResult) => void; onEose: () => void } {
      const args = vi.mocked(relay.subscribe).mock.calls[call]!;
      return { onEvent: args[1] as (result: RelayEventResult) => void, onEose: args[2] as () => void };
    }

    function deliver(payload: unknown): void {
      const onDelivery = vi.mocked(intent.onDelivery).mock.calls.at(-1)![0];
      onDelivery({ sender: 'shell', archetype: 'radio', action: 'play', convention: 'napplet:radio/play', payload } as Delivery);
    }

    it('plays the station matching a query that arrives before the stations do, instead of the last one played', async () => {
      // Restoring is skipped, so a queued once-value would leak into the next test.
      vi.mocked(storage.getItem).mockResolvedValue('jazz-24');
      const component = mount(App, { target: document.body });
      await waitForInitialSubscription();
      deliver({ query: 'synthwave' });
      await tick();
      expect(document.querySelector('[data-radio-play-notice]')?.getAttribute('data-radio-play-notice')).toBe('searching');
      expect(document.body.textContent).toContain('Looking for a station matching “synthwave”');
      expect(requestRuntimePlayback).not.toHaveBeenCalled();
      // The lookup is already out; the first page answers sooner here.
      expect(relay.subscribe).toHaveBeenCalledTimes(2);

      const { onEvent, onEose } = pageCallbacks(0);
      onEvent({ event: stationEvent('jazz-24', 'Jazz 24', ['jazz']) });
      onEvent({ event: stationEvent('nightride-fm', 'Nightride FM', ['synthwave']) });
      onEose();

      await vi.waitFor(() => expect(requestRuntimePlayback).toHaveBeenCalledTimes(1));
      expect(vi.mocked(requestRuntimePlayback).mock.calls[0]![0]).toMatchObject({ title: 'Nightride FM', autoplay: true });
      expect(storage.getItem).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(document.querySelector('button[title="Nightride FM"]')?.getAttribute('aria-pressed')).toBe('true'));
      expect(document.querySelector('button[title="Jazz 24"]')?.getAttribute('aria-pressed')).toBe('false');
      expect(document.querySelector('[data-radio-play-notice]')).toBeNull();
      expect(storage.setItem).toHaveBeenCalledWith('last-station-id', 'station-host:nightride-fm');
      vi.mocked(storage.getItem).mockResolvedValue(null);
      await unmount(component);
    });

    it('plays a loaded station at once, by id, and shows it when a genre filter hid it', async () => {
      const component = mount(App, { target: document.body });
      await waitForInitialSubscription();
      const { onEvent, onEose } = pageCallbacks(0);
      onEvent({ event: stationEvent('jazz-24', 'Jazz 24', ['jazz']) });
      onEvent({ event: stationEvent('nightride-fm', 'Nightride FM', ['synthwave']) });
      onEose();
      await vi.waitFor(() => expect(document.querySelector('button[title="Jazz 24"]')).not.toBeNull());
      const jazzPill = [...document.querySelectorAll<HTMLButtonElement>('.genre-pill')].find((pill) => pill.textContent === 'jazz')!;
      jazzPill.click();
      await tick();
      expect(document.querySelector('button[title="Nightride FM"]')).toBeNull();

      deliver({ station: 'nightride-fm' });
      await vi.waitFor(() => expect(requestRuntimePlayback).toHaveBeenCalledTimes(1));
      expect(vi.mocked(requestRuntimePlayback).mock.calls[0]![0]).toMatchObject({ title: 'Nightride FM' });
      await vi.waitFor(() => expect(document.querySelector('button[title="Nightride FM"]')?.getAttribute('aria-pressed')).toBe('true'));
      await unmount(component);
    });

    it('looks an unloaded station up on the relay by genre instead of paging for it', async () => {
      const component = mount(App, { target: document.body });
      await waitForInitialSubscription();
      const { onEvent, onEose } = pageCallbacks(0);
      onEvent({ event: stationEvent('jazz-24', 'Jazz 24', ['jazz']) });
      onEose();
      await vi.waitFor(() => expect(document.querySelector('button[title="Jazz 24"]')).not.toBeNull());

      deliver({ query: 'synthwave' });
      await tick();
      expect(relay.subscribe).toHaveBeenCalledTimes(2);
      const lookupCall = vi.mocked(relay.subscribe).mock.calls[1]!;
      expect(lookupCall[0]).toEqual([
        { kinds: [31237], '#c': ['synthwave'], limit: 500 },
        { kinds: [31237], '#t': ['synthwave'], limit: 500 },
      ]);
      expect(lookupCall[3]).toEqual({ relay: 'wss://relay.wavefunc.live' });
      expect(document.querySelector('[data-radio-play-notice]')?.getAttribute('data-radio-play-notice')).toBe('searching');
      expect(requestRuntimePlayback).not.toHaveBeenCalled();

      const lookup = pageCallbacks(1);
      lookup.onEvent({ event: stationEvent('nightride-fm', 'Nightride FM', ['synthwave'], 1600000000) });
      lookup.onEose();
      await vi.waitFor(() => expect(requestRuntimePlayback).toHaveBeenCalledTimes(1));
      expect(vi.mocked(requestRuntimePlayback).mock.calls[0]![0]).toMatchObject({ title: 'Nightride FM' });
      await vi.waitFor(() => expect(document.querySelector('button[title="Nightride FM"]')?.getAttribute('aria-pressed')).toBe('true'));
      expect(document.querySelector('[data-radio-play-notice]')).toBeNull();
      // One lookup, no further pages.
      expect(relay.subscribe).toHaveBeenCalledTimes(2);
      await unmount(component);
    });

    it('says so when the lookup finds nothing, and leaves what was playing alone', async () => {
      const component = mount(App, { target: document.body });
      await waitForInitialSubscription();
      const { onEvent, onEose } = pageCallbacks(0);
      onEvent({ event: stationEvent('jazz-24', 'Jazz 24', ['jazz']) });
      onEose();
      await vi.waitFor(() => expect(document.querySelector('button[title="Jazz 24"]')).not.toBeNull());
      document.querySelector<HTMLButtonElement>('button[title="Jazz 24"]')!.click();
      await vi.waitFor(() => expect(requestRuntimePlayback).toHaveBeenCalledTimes(1));

      deliver({ query: 'synthwave' });
      await tick();
      expect(document.querySelector('[data-radio-play-notice]')?.getAttribute('data-radio-play-notice')).toBe('searching');
      pageCallbacks(1).onEose();
      await vi.waitFor(() => expect(document.querySelector('[data-radio-play-notice]')?.getAttribute('data-radio-play-notice')).toBe('not-found'));
      const notice = document.querySelector('[data-radio-play-notice]')!;
      expect(notice.textContent).toContain('No station matches “synthwave”.');
      expect(relay.subscribe).toHaveBeenCalledTimes(2);
      expect(requestRuntimePlayback).toHaveBeenCalledTimes(1);
      expect(document.querySelector('button[title="Jazz 24"]')?.getAttribute('aria-pressed')).toBe('true');

      notice.querySelector<HTMLButtonElement>('button')!.click();
      await tick();
      expect(document.querySelector('[data-radio-play-notice]')).toBeNull();

      // A payload Radio cannot use is ignored: no notice, no lookup.
      deliver({ volume: 11 });
      await tick();
      expect(document.querySelector('[data-radio-play-notice]')).toBeNull();
      expect(relay.subscribe).toHaveBeenCalledTimes(2);
      await unmount(component);
    });

    it('plays a looked-up station without waiting for cover images', async () => {
      const component = mount(App, { target: document.body });
      await waitForInitialSubscription();
      const { onEvent, onEose } = pageCallbacks(0);
      onEvent({ event: stationEvent('jazz-24', 'Jazz 24', ['jazz']) });
      onEose();
      await vi.waitFor(() => expect(document.querySelector('button[title="Jazz 24"]')).not.toBeNull());

      // Covers are slowest right after Radio opens; from here none of them answers.
      coverImageMock.state.autoResolve = false;
      coverImageMock.coverImageResolves.mockClear();
      deliver({ query: 'synthwave' });
      await tick();
      const lookup = pageCallbacks(1);
      for (let index = 0; index < 6; index++) {
        lookup.onEvent({ event: stationEvent(`broad-${index}`, `Broad ${index}`, ['pop', 'rock', 'synthwave'], 1600000010 + index) });
      }
      lookup.onEvent({ event: stationEvent('nightride-fm', 'Nightride FM', ['synthwave'], 1600000000) });
      lookup.onEose();
      await vi.waitFor(() => expect(requestRuntimePlayback).toHaveBeenCalledTimes(1));
      expect(vi.mocked(requestRuntimePlayback).mock.calls[0]![0]).toMatchObject({ title: 'Nightride FM' });
      expect(coverImageMock.coverImageResolves).not.toHaveBeenCalled();
      // The station playing and its two fallbacks join the grid; the rest of the results do not.
      await vi.waitFor(() => expect(document.querySelector('button[title="Nightride FM"]')?.getAttribute('aria-pressed')).toBe('true'));
      expect(document.querySelector('[data-radio-root]')?.getAttribute('data-radio-count')).toBe('4');
      expect(document.querySelector('[data-radio-play-notice]')).toBeNull();
      await unmount(component);
    });

    it('plays shortly after the relay\'s matches arrive, without waiting to be told they have ended', async () => {
      const component = mount(App, { target: document.body });
      await waitForInitialSubscription();
      const { onEvent, onEose } = pageCallbacks(0);
      onEvent({ event: stationEvent('jazz-24', 'Jazz 24', ['jazz']) });
      onEose();
      await vi.waitFor(() => expect(document.querySelector('button[title="Jazz 24"]')).not.toBeNull());
      deliver({ query: 'synthwave' });
      await tick();
      const lookup = pageCallbacks(1);
      lookup.onEvent({ event: stationEvent('everything-fm', 'Everything FM', ['pop', 'rock', 'synthwave'], 1600000002) });
      lookup.onEvent({ event: stationEvent('nightride-fm', 'Nightride FM', ['synthwave'], 1600000001) });
      expect(requestRuntimePlayback).not.toHaveBeenCalled();
      // No end-of-stored-events from the shell: the best of what arrived plays after the settle time.
      await vi.waitFor(() => expect(requestRuntimePlayback).toHaveBeenCalledTimes(1), { timeout: 4_000 });
      expect(vi.mocked(requestRuntimePlayback).mock.calls[0]![0]).toMatchObject({ title: 'Nightride FM' });
      await unmount(component);
    });

    it('moves to the next match when the stream fails or never starts, and says so when none plays', async () => {
      const component = mount(App, { target: document.body });
      await waitForInitialSubscription();
      const { onEvent, onEose } = pageCallbacks(0);
      onEvent({ event: stationEvent('jazz-24', 'Jazz 24', ['jazz']) });
      onEose();
      await vi.waitFor(() => expect(document.querySelector('button[title="Jazz 24"]')).not.toBeNull());

      deliver({ query: 'synthwave' });
      await tick();
      const lookup = pageCallbacks(1);
      // The broad station arrives first; the focused one ranks above it.
      lookup.onEvent({ event: stationEvent('everything-fm', 'Everything FM', ['pop', 'rock', 'jazz', 'synthwave'], 1600000002) });
      lookup.onEvent({ event: stationEvent('nightride-fm', 'Nightride FM', ['synthwave'], 1600000001) });
      lookup.onEose();
      await vi.waitFor(() => expect(requestRuntimePlayback).toHaveBeenCalledTimes(1));
      expect(vi.mocked(requestRuntimePlayback).mock.calls[0]![0]).toMatchObject({ title: 'Nightride FM' });
      expect(relay.subscribe).toHaveBeenCalledTimes(2);

      // The shell player reports the stream dead: the next match is tried, with no new lookup.
      const runtimeState = { sessionId: 'radio-session', windowId: '', position: 0, duration: null, volume: 0.7, muted: false };
      await vi.waitFor(() => expect(subscribeRuntimePlayback).toHaveBeenCalledTimes(1));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        vi.mocked(subscribeRuntimePlayback).mock.calls[0]![1]({ ...runtimeState, state: 'error' });
        await vi.advanceTimersByTimeAsync(0);
        expect(requestRuntimePlayback).toHaveBeenCalledTimes(2);
        expect(vi.mocked(requestRuntimePlayback).mock.calls[1]![0]).toMatchObject({ title: 'Everything FM' });
        expect(document.querySelector('[data-radio-play-notice]')).toBeNull();

        // That one never reaches playing. After ten seconds there is nothing left to try.
        vi.mocked(subscribeRuntimePlayback).mock.calls[1]![1]({ ...runtimeState, state: 'loading' });
        await vi.advanceTimersByTimeAsync(9_999);
        expect(document.querySelector('[data-radio-play-notice]')).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        await tick();
        const notice = document.querySelector('[data-radio-play-notice]')!;
        expect(notice.getAttribute('data-radio-play-notice')).toBe('failed');
        expect(notice.textContent).toContain('Stations matching “synthwave” were found, but none would play.');
        expect(requestRuntimePlayback).toHaveBeenCalledTimes(2);
        expect(relay.subscribe).toHaveBeenCalledTimes(2);
        expect(document.querySelector('button[title="Everything FM"]')?.getAttribute('aria-pressed')).toBe('false');
      } finally {
        vi.useRealTimers();
      }
      await unmount(component);
    });

    it('stops trying other stations once the requested one plays', async () => {
      const component = mount(App, { target: document.body });
      await waitForInitialSubscription();
      const { onEvent, onEose } = pageCallbacks(0);
      onEvent({ event: stationEvent('nightride-fm', 'Nightride FM', ['synthwave']) });
      onEvent({ event: stationEvent('everything-fm', 'Everything FM', ['pop', 'synthwave']) });
      onEose();
      await vi.waitFor(() => expect(document.querySelector('button[title="Nightride FM"]')).not.toBeNull());
      deliver({ query: 'synthwave' });
      await vi.waitFor(() => expect(subscribeRuntimePlayback).toHaveBeenCalledTimes(1));
      // A strong match was already loaded, so nothing was looked up.
      expect(relay.subscribe).toHaveBeenCalledTimes(1);
      const onState = vi.mocked(subscribeRuntimePlayback).mock.calls[0]![1];
      const runtimeState = { sessionId: 'radio-session', windowId: '', position: 0, duration: null, volume: 0.7, muted: false };
      onState({ ...runtimeState, state: 'playing' });
      // A later error is an ordinary stop, not a reason to switch stations.
      onState({ ...runtimeState, state: 'error' });
      await tick();
      expect(requestRuntimePlayback).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[data-radio-play-notice]')).toBeNull();
      await unmount(component);
    });

    it('gives up after twenty seconds when the relay never answers', async () => {
      const component = mount(App, { target: document.body });
      await waitForInitialSubscription();
      const { onEvent, onEose } = pageCallbacks(0);
      onEvent({ event: stationEvent('jazz-24', 'Jazz 24', ['jazz']) });
      onEose();
      await vi.waitFor(() => expect(document.querySelector('button[title="Jazz 24"]')).not.toBeNull());

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        deliver({ query: 'synthwave' });
        await tick();
        await vi.advanceTimersByTimeAsync(19_999);
        await tick();
        expect(document.querySelector('[data-radio-play-notice]')?.getAttribute('data-radio-play-notice')).toBe('searching');
        await vi.advanceTimersByTimeAsync(1);
        await tick();
        const notice = document.querySelector('[data-radio-play-notice]')!;
        expect(notice.getAttribute('data-radio-play-notice')).toBe('not-found');
        expect(notice.textContent).toContain('No station matches “synthwave”.');
        // A station that turns up after the deadline is not played.
        const lookup = pageCallbacks(1);
        lookup.onEvent({ event: stationEvent('nightride-fm', 'Nightride FM', ['synthwave'], 1600000000) });
        lookup.onEose();
        await vi.advanceTimersByTimeAsync(100);
        expect(requestRuntimePlayback).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
      await unmount(component);
    });

    it('searches for the telling word of a guessed station name and says what it is looking for', async () => {
      const component = mount(App, { target: document.body });
      await waitForInitialSubscription();
      const { onEvent, onEose } = pageCallbacks(0);
      onEvent({ event: stationEvent('jazz-24', 'Jazz 24', ['jazz']) });
      onEose();
      await vi.waitFor(() => expect(document.querySelector('button[title="Jazz 24"]')).not.toBeNull());

      deliver({ station: 'synthwave.radio' });
      await tick();
      expect(document.querySelector('[data-radio-play-notice]')?.textContent).toContain('Looking for a station matching “synthwave”');
      expect(vi.mocked(relay.subscribe).mock.calls[1]![0]).toEqual([
        { kinds: [31237], '#d': ['synthwave.radio'] },
        { kinds: [31237], '#c': ['synthwave'], limit: 500 },
        { kinds: [31237], '#t': ['synthwave'], limit: 500 },
      ]);
      const lookup = pageCallbacks(1);
      lookup.onEvent({ event: stationEvent('nightride-fm', 'Nightride FM', ['synthwave'], 1600000000) });
      lookup.onEose();
      await vi.waitFor(() => expect(requestRuntimePlayback).toHaveBeenCalledTimes(1));
      expect(vi.mocked(requestRuntimePlayback).mock.calls[0]![0]).toMatchObject({ title: 'Nightride FM' });
      await unmount(component);
    });

    it('waits for the first page before saying nothing matches', async () => {
      const component = mount(App, { target: document.body });
      await waitForInitialSubscription();
      deliver({ query: 'nightride' });
      await tick();
      // The genre lookup comes back empty while the first page is still loading.
      pageCallbacks(1).onEose();
      await tick();
      await tick();
      expect(document.querySelector('[data-radio-play-notice]')?.getAttribute('data-radio-play-notice')).toBe('searching');

      const { onEvent, onEose } = pageCallbacks(0);
      onEvent({ event: stationEvent('nightride-fm', 'Nightride FM', ['synthwave']) });
      onEose();
      await vi.waitFor(() => expect(requestRuntimePlayback).toHaveBeenCalledTimes(1));
      expect(vi.mocked(requestRuntimePlayback).mock.calls[0]![0]).toMatchObject({ title: 'Nightride FM' });
      expect(document.querySelector('[data-radio-play-notice]')).toBeNull();
      await unmount(component);
    });

    it('drops a pending request when the user picks a station by hand', async () => {
      const component = mount(App, { target: document.body });
      await waitForInitialSubscription();
      const { onEvent, onEose } = pageCallbacks(0);
      onEvent({ event: stationEvent('jazz-24', 'Jazz 24', ['jazz']) });
      onEose();
      await vi.waitFor(() => expect(document.querySelector('button[title="Jazz 24"]')).not.toBeNull());
      deliver({ query: 'synthwave' });
      await tick();
      expect(relay.subscribe).toHaveBeenCalledTimes(2);

      document.querySelector<HTMLButtonElement>('button[title="Jazz 24"]')!.click();
      await vi.waitFor(() => expect(requestRuntimePlayback).toHaveBeenCalledTimes(1));
      expect(document.querySelector('[data-radio-play-notice]')).toBeNull();
      const lookup = pageCallbacks(1);
      lookup.onEvent({ event: stationEvent('nightride-fm', 'Nightride FM', ['synthwave'], 1600000000) });
      lookup.onEose();
      await tick();
      await tick();
      expect(requestRuntimePlayback).toHaveBeenCalledTimes(1);
      expect(vi.mocked(requestRuntimePlayback).mock.calls[0]![0]).toMatchObject({ title: 'Jazz 24' });
      expect(document.querySelector('button[title="Nightride FM"]')).toBeNull();
      await unmount(component);
    });
  });
});
