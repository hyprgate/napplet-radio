<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { relay, inc as ipc } from '@napplet/sdk';
  import {
    createStreamChannelSwitchPayload,
    createStreamCurrentContextPayload,
    requestRuntimePlayback,
    releaseRuntimePlayback,
    subscribeRuntimePlayback,
    type RuntimePlaybackChatContext,
    type RuntimePlaybackContext,
    type RuntimePlaybackQueueItem,
    type RuntimePlayerControl,
    type RuntimePlayerStatus,
    type RuntimePlayerSubscription,
  } from '@hyprgate/utils';
  import { radioStore, parseKind31237 } from './lib/radio-store.js';
  import { getNextRadioPageRequest } from './lib/radio-pagination.js';
  import StationCard from './components/StationCard.svelte';
  import type { RadioStation } from './lib/radio-store.js';
  import type { Subscription } from '@napplet/sdk';

  const WAVEFUNC_RELAY = 'wss://relay.wavefunc.live';
  const STATION_PAGE_LIMIT = 1000;

  // Version counter pattern for store reactivity
  let version = $state(0);
  function notifyUpdate() { version++; }

  let stations = $derived.by(() => { version; return radioStore.getStations(); });
  let playingId = $derived.by(() => { version; return radioStore.getPlaying(); });
  let loading = $derived.by(() => { version; return radioStore.isLoading(); });
  let playbackStatus = $state<RuntimePlayerStatus | null>(null);
  let activeGenre = $state<string | null>(null);

  let genres = $derived.by(() => {
    version;
    const counts = new Map<string, number>();
    for (const station of radioStore.getStations()) {
      for (const genre of station.genres) counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([genre]) => genre);
  });

  let visibleStations = $derived.by(() => {
    version;
    void activeGenre;
    const all = radioStore.getStations();
    return activeGenre ? all.filter((station) => station.genres.includes(activeGenre)) : all;
  });

  let sub: Subscription | null = null;
  let contextSub: { close(): void } | null = null;
  let runtimeSubscription: RuntimePlayerSubscription | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let scrollContainer: HTMLDivElement | undefined = $state();
  let loadMoreSentinel: HTMLDivElement | undefined = $state();
  let observer: IntersectionObserver | null = null;
  let runtimeSessionId: string | null = null;
  let playbackRequestToken = 0;
  let loadingMore = $state(false);
  let hasMore = $state(true);
  let oldestSeenCreatedAt: number | null = null;
  let pageRequestId = 0;
  let restoredLastStation = false;
  let destroyed = false;

  function primaryStreamUrl(station: RadioStation): string | null {
    return (station.streams.find((stream) => stream.primary) ?? station.streams[0])?.url ?? null;
  }

  function stationContextDetail(station: RadioStation): string | undefined {
    return station.genres.length > 0 ? station.genres.join(', ') : undefined;
  }

  function stationStreamAddr(station: RadioStation): string {
    return `30311:${station.pubkey}:${station.id}`;
  }

  function stationChatContext(station: RadioStation): RuntimePlaybackChatContext | undefined {
    return station.chatRelays.length > 0
      ? { streamAddr: stationStreamAddr(station), title: station.name, chatRelays: station.chatRelays }
      : undefined;
  }

  function buildStationQueue(station: RadioStation): {
    context: RuntimePlaybackContext;
    queue: RuntimePlaybackQueueItem[];
    queueIndex: number | undefined;
    controls: RuntimePlayerControl[];
  } {
    const playable = radioStore.getStations()
      .map((candidate) => ({ station: candidate, url: primaryStreamUrl(candidate) }))
      .filter((item): item is { station: RadioStation; url: string } => Boolean(item.url));
    const total = playable.length;
    const queue = playable.map((item, index) => ({
      url: item.url,
      kind: 'icecast' as const,
      title: item.station.name,
      artist: stationContextDetail(item.station),
      album: 'Radio',
      artworkUrl: item.station.thumbnail ?? undefined,
      live: true,
      context: {
        label: 'Radio',
        detail: stationContextDetail(item.station),
        index,
        total,
        ...(stationChatContext(item.station) ? { chat: stationChatContext(item.station) } : {}),
      },
    }));
    const queueIndex = playable.findIndex((item) => item.station.id === station.id);
    const controls: RuntimePlayerControl[] = ['play', 'pause', 'stop', 'setVolume', 'setMuted'];
    if (queue.length > 1) controls.splice(3, 0, 'prev', 'next');

    return {
      context: {
        label: 'Radio',
        detail: stationContextDetail(station),
        ...(queueIndex >= 0 ? { index: queueIndex, total } : {}),
        ...(stationChatContext(station) ? { chat: stationChatContext(station) } : {}),
      },
      queue,
      queueIndex: queueIndex >= 0 ? queueIndex : undefined,
      controls,
    };
  }

  function clearRuntimeSubscription(): void {
    runtimeSubscription?.close();
    runtimeSubscription = null;
  }

  async function releaseRuntimeSession(): Promise<void> {
    const sessionId = runtimeSessionId;
    runtimeSessionId = null;
    clearRuntimeSubscription();
    if (!sessionId) return;
    try {
      await releaseRuntimePlayback(sessionId);
    } catch (error) {
      console.warn('[radio] player.release failed', error);
    }
  }

  /** Track the shell session so the card state clears when playback stops or fails. */
  function trackRuntimeSession(sessionId: string, token: number): void {
    clearRuntimeSubscription();
    runtimeSubscription = subscribeRuntimePlayback(sessionId, (state) => {
      if (destroyed || token !== playbackRequestToken) return;
      if (!state || state.state === 'idle' || state.state === 'ended' || state.state === 'error') {
        playbackStatus = state?.state ?? null;
        runtimeSessionId = null;
        clearRuntimeSubscription();
        radioStore.setPlaying(null);
        radioStore.persistLastStation(null);
        notifyUpdate();
        return;
      }
      playbackStatus = state.state;
      notifyUpdate();
    });
  }

  async function requestStationPlayback(station: RadioStation, streamUrl: string): Promise<boolean> {
    const token = ++playbackRequestToken;
    await releaseRuntimeSession();
    if (destroyed || token !== playbackRequestToken) return false;
    playbackStatus = 'loading';
    notifyUpdate();

    try {
      const playbackQueue = buildStationQueue(station);
      const result = await requestRuntimePlayback({
        url: streamUrl,
        kind: 'icecast',
        title: station.name,
        artist: station.genres.join(', ') || undefined,
        album: 'Radio',
        artworkUrl: station.thumbnail ?? undefined,
        context: playbackQueue.context,
        queue: playbackQueue.queue,
        queueIndex: playbackQueue.queueIndex,
        capabilities: playbackQueue.controls,
        autoplay: true,
        live: true,
      });
      if (destroyed || token !== playbackRequestToken) {
        void releaseRuntimePlayback(result.sessionId).catch((error) => {
          console.warn('[radio] stale player.release failed', error);
        });
        return false;
      }
      runtimeSessionId = result.sessionId;
      playbackStatus = result.state?.state ?? 'loading';
      trackRuntimeSession(result.sessionId, token);
    } catch (error) {
      if (destroyed || token !== playbackRequestToken) return false;
      playbackStatus = 'error';
      radioStore.setPlaying(null);
      console.warn('[radio] player.requestPlayback failed', error);
    }
    notifyUpdate();
    return true;
  }

  function emitChannelSwitch(station: RadioStation, streamUrl: string): void {
    // NIP-53 addressable coordinate for kind 1311 chat. Radio stations are kind
    // 31237 events; their live chat follows NIP-53 "30311:<pubkey>:<d-tag>" so the
    // chat napp can subscribe with '#a'.
    const streamAddr = stationStreamAddr(station);
    ipc.emit('stream:channel-switch', [], JSON.stringify(
      createStreamChannelSwitchPayload({
        streamId: streamAddr,
        streamUrl,
        title: station.name,
        chatRelays: station.chatRelays,
        hostPubkey: station.pubkey,
      }),
    ));
  }

  async function selectStation(station: RadioStation) {
    const streamUrl = primaryStreamUrl(station);
    if (!streamUrl) return;

    radioStore.setPlaying(station.id);
    radioStore.persistLastStation(station.id);
    notifyUpdate();

    const current = await requestStationPlayback(station, streamUrl);
    if (!current) return;

    emitChannelSwitch(station, streamUrl);
  }

  function closePageSubscription(): void {
    sub?.close();
    sub = null;
  }

  function noteSeenStationEvent(event: { created_at: number }): void {
    oldestSeenCreatedAt = oldestSeenCreatedAt === null
      ? event.created_at
      : Math.min(oldestSeenCreatedAt, event.created_at);
  }

  async function restoreLastStationOnce(): Promise<void> {
    if (restoredLastStation) return;
    restoredLastStation = true;
    const restoredId = await radioStore.restoreLastStation();
    if (!restoredId) return;
    const station = radioStore.getStation(restoredId);
    if (!station) return;
    const streamUrl = primaryStreamUrl(station);
    if (!streamUrl) return;
    radioStore.setPlaying(station.id);
    const current = await requestStationPlayback(station, streamUrl);
    if (current) emitChannelSwitch(station, streamUrl);
  }

  function loadNextStationPage(): void {
    const pageRequest = getNextRadioPageRequest({
      isLoading: radioStore.isLoading(),
      loadingMore,
      hasMore,
      loadedStationCount: radioStore.getStations().length,
      oldestSeenCreatedAt,
    });
    if (!pageRequest) return;

    const { initialLoad, until, cursorBefore } = pageRequest;
    const requestId = ++pageRequestId;
    let pageEventCount = 0;

    closePageSubscription();
    loadingMore = !initialLoad;
    radioStore.setLoading(initialLoad);
    notifyUpdate();

    sub = relay.subscribe(
      { kinds: [31237], limit: STATION_PAGE_LIMIT, ...(until === undefined ? {} : { until }) },
      (event) => {
        if (requestId !== pageRequestId) return;
        pageEventCount++;
        noteSeenStationEvent(event);
        const station = parseKind31237(event);
        if (station) { radioStore.addStation(station); notifyUpdate(); }
      },
      async () => {
        if (requestId !== pageRequestId) return;
        closePageSubscription();

        if (pageEventCount < STATION_PAGE_LIMIT || pageEventCount === 0 || oldestSeenCreatedAt === cursorBefore) {
          hasMore = false;
        }

        loadingMore = false;
        radioStore.setLoading(false);
        notifyUpdate();

        if (initialLoad) {
          await restoreLastStationOnce();
          notifyUpdate();
        }
      },
      { relay: WAVEFUNC_RELAY },
    );
  }

  function handleScroll(): void {
    if (!scrollContainer) return;
    const remaining = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    if (remaining < 600) loadNextStationPage();
  }

  $effect(() => {
    const sentinel = loadMoreSentinel;
    const root = scrollContainer;
    const canLoadMore = hasMore;

    observer?.disconnect();
    observer = null;

    if (canLoadMore && sentinel && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) loadNextStationPage();
        },
        { root: root ?? null, rootMargin: '600px 0px' },
      );
      observer.observe(sentinel);
    }

    return () => {
      observer?.disconnect();
      observer = null;
    };
  });

  onMount(() => {
    radioStore.reset();
    radioStore.setLoading(false);
    loadingMore = false;
    hasMore = true;
    oldestSeenCreatedAt = null;
    pageRequestId = 0;
    restoredLastStation = false;
    loadNextStationPage();

    // Pull-on-mount responder: respond to stream:current-context-get requests
    contextSub = ipc.on('stream:current-context-get', (payload) => {
      const current = radioStore.getPlaying();
      const station = current ? radioStore.getStation(current) : undefined;
      const streamAddr = station ? stationStreamAddr(station) : null;
      ipc.emit('stream:current-context', [], JSON.stringify(
        createStreamCurrentContextPayload(
          station
            ? { streamAddr, title: station.name, chatRelays: station.chatRelays }
            : { streamAddr: null, title: null, chatRelays: [] },
          payload,
        ),
      ));
    });

    pollInterval = setInterval(notifyUpdate, 500);
  });

  onDestroy(() => {
    destroyed = true;
    playbackRequestToken++;
    closePageSubscription();
    contextSub?.close();
    observer?.disconnect();
    if (pollInterval) clearInterval(pollInterval);
    void releaseRuntimeSession();
  });
</script>

<div
  class="h-full overflow-auto"
  style="background: var(--hg-bg-base);"
  bind:this={scrollContainer}
  onscroll={handleScroll}
  data-radio-root
  data-radio-count={stations.length}
  data-radio-loading={loading}
  data-radio-loading-more={loadingMore}
  data-radio-has-more={hasMore}
>
  {#if loading && stations.length === 0}
    <div class="state-message">Loading stations…</div>
  {:else if !loading && stations.length === 0}
    <div class="state-message">No stations found</div>
  {:else}
    <header class="header-bar">
      <div class="header-info">
        <span class="title">Radio</span>
        <span class="count">{visibleStations.length} station{visibleStations.length === 1 ? '' : 's'}</span>
      </div>
      {#if genres.length > 0}
        <div class="genre-filter">
          <button
            type="button"
            class="genre-pill"
            class:active={activeGenre === null}
            aria-pressed={activeGenre === null}
            onclick={() => (activeGenre = null)}
          >All</button>
          {#each genres as genre (genre)}
            <button
              type="button"
              class="genre-pill"
              class:active={activeGenre === genre}
              aria-pressed={activeGenre === genre}
              onclick={() => (activeGenre = activeGenre === genre ? null : genre)}
            >{genre}</button>
          {/each}
        </div>
      {/if}
    </header>

    {#if visibleStations.length === 0}
      <div class="state-message">
        No stations tagged “{activeGenre}”.
        <button type="button" class="inline-clear" onclick={() => (activeGenre = null)}>Show all</button>
      </div>
    {:else}
      <div class="station-grid">
        {#each visibleStations as station (station.id)}
          <StationCard
            {station}
            isPlaying={playingId === station.id}
            loading={playingId === station.id && playbackStatus !== 'playing'}
            onselect={() => selectStation(station)}
          />
        {/each}
      </div>
    {/if}

    {#if hasMore}
      <div bind:this={loadMoreSentinel} class="load-more-sentinel" aria-live="polite">
        {#if loadingMore}
          Loading more stations…
        {:else}
          <button type="button" class="load-more-button" onclick={loadNextStationPage}>Load more stations</button>
        {/if}
      </div>
    {:else}
      <div class="load-more-sentinel terminal" aria-live="polite">No more stations found</div>
    {/if}
  {/if}
</div>

<style>
  .header-bar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--hg-bg-base, #050505) 88%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 14%, transparent);
  }

  .header-info {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .title {
    font-size: 15px;
    font-weight: 700;
    color: var(--hg-text-primary, #f2efe7);
  }

  .count {
    font-size: 12px;
    color: var(--hg-text-muted, #b8b1a4);
  }

  .genre-filter {
    display: flex;
    flex-wrap: nowrap;
    gap: 6px;
    overflow-x: auto;
    min-width: 0;
    scrollbar-width: none;
  }

  .genre-filter::-webkit-scrollbar {
    display: none;
  }

  .genre-pill {
    flex: none;
    font: inherit;
    font-size: 12px;
    white-space: nowrap;
    text-transform: capitalize;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 22%, transparent);
    background: transparent;
    color: var(--hg-text-muted, #b8b1a4);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }

  .genre-pill:hover {
    color: var(--hg-text-primary, #f2efe7);
    border-color: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 50%, transparent);
  }

  .genre-pill.active {
    color: var(--hg-text-primary, #f2efe7);
    border-color: var(--hg-accent-primary, #5d5dff);
    background: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 22%, transparent);
  }

  .station-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 16px;
    padding: 14px;
  }

  .state-message {
    padding: 16px;
    font-size: 13px;
    color: var(--hg-text-muted, #b8b1a4);
  }

  .inline-clear {
    font: inherit;
    color: var(--hg-accent-primary, #5d5dff);
    background: none;
    border: none;
    padding: 0;
    margin-left: 4px;
    cursor: pointer;
    text-decoration: underline;
  }

  .load-more-sentinel {
    min-height: 44px;
    padding: 10px 14px 16px;
    text-align: center;
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 12px;
  }

  .load-more-sentinel.terminal {
    border-top: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 12%, transparent);
  }

  .load-more-button {
    font: inherit;
    color: var(--hg-text-primary, #f2efe7);
    background: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 20%, transparent);
    border: 1px solid color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 48%, transparent);
    border-radius: 6px;
    padding: 6px 12px;
    cursor: pointer;
  }

  .load-more-button:hover {
    background: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 30%, transparent);
  }
</style>
