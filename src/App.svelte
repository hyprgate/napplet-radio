<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { relay, inc } from '@napplet/sdk';
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
  import { radioStore, parseKind31237, stationKey } from './lib/radio-store.js';
  import { coverImageResolves } from './lib/radio-cover-image.js';
  import { getNextRadioPageRequest } from './lib/radio-pagination.js';
  import StationCard from './components/StationCard.svelte';
  import type { RadioStation } from './lib/radio-store.js';
  import type { Subscription } from '@napplet/sdk';
  import type { NostrEvent } from '@hyprgate/types';

  const WAVEFUNC_RELAY = 'wss://relay.wavefunc.live';
  // WaveFunc rejects larger requests with CLOSED instead of returning a page.
  const STATION_PAGE_LIMIT = 500;

  // Version counter pattern for store reactivity
  let version = $state(0);
  function notifyUpdate() { version++; }

  let stations = $derived.by(() => { version; return radioStore.getStations(); });
  let playingId = $derived.by(() => { version; return radioStore.getPlaying(); });
  let coverChecksPending = $state(0);
  let loading = $derived.by(() => {
    version;
    return radioStore.isLoading() || coverChecksPending > 0;
  });
  let playbackStatus = $state<RuntimePlayerStatus | null>(null);
  let activeGenre = $state<string | null>(null);
  let failedStationKey = $state<string | null>(null);
  let showAllGenres = $state(false);
  const GENRE_PREVIEW_COUNT = 8;
  const MAX_PENDING_PLACEHOLDERS = 4;

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

  // The active genre stays in view even when it's past the preview.
  let shownGenres = $derived.by(() => {
    if (showAllGenres || genres.length <= GENRE_PREVIEW_COUNT) return genres;
    const preview = genres.slice(0, GENRE_PREVIEW_COUNT);
    return activeGenre && !preview.includes(activeGenre) ? [...preview, activeGenre] : preview;
  });
  let playingStation = $derived(playingId ? radioStore.getStation(playingId) ?? null : null);
  let failedStation = $derived(failedStationKey ? radioStore.getStation(failedStationKey) ?? null : null);
  let nowPlayingLabel = $derived(
    playbackStatus === 'loading' ? 'Tuning in to' : playbackStatus === 'paused' ? 'Paused' : 'Now playing',
  );

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
  const coverCheckPromises = new Set<Promise<void>>();

  function trackCoverCheck(promise: Promise<void>): void {
    coverCheckPromises.add(promise);
    void promise.finally(() => {
      coverCheckPromises.delete(promise);
    });
  }

  async function waitForCoverChecks(requestId: number): Promise<void> {
    while (!destroyed && requestId === pageRequestId && coverCheckPromises.size > 0) {
      await Promise.allSettled([...coverCheckPromises]);
    }
  }

  function primaryStreamUrl(station: RadioStation): string | null {
    return (station.streams.find((stream) => stream.primary) ?? station.streams[0])?.url ?? null;
  }

  function stationContextDetail(station: RadioStation): string | undefined {
    return station.genres.length > 0 ? station.genres.join(', ') : undefined;
  }

  function stationStreamAddr(station: RadioStation): string {
    return `30311:${station.pubkey}:${station.id}`;
  }

  function stationChatContext(station: RadioStation): RuntimePlaybackChatContext {
    return {
      streamAddr: stationStreamAddr(station),
      title: station.name,
      ...(station.chatRelays.length > 0 ? { chatRelays: station.chatRelays } : {}),
    };
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
        chat: stationChatContext(item.station),
      },
    }));
    const queueIndex = playable.findIndex((item) => stationKey(item.station) === stationKey(station));
    const controls: RuntimePlayerControl[] = ['play', 'pause', 'stop', 'setVolume', 'setMuted'];
    if (queue.length > 1) controls.splice(3, 0, 'prev', 'next');

    return {
      context: {
        label: 'Radio',
        detail: stationContextDetail(station),
        ...(queueIndex >= 0 ? { index: queueIndex, total } : {}),
        chat: stationChatContext(station),
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
        // The player drops back to idle when a source never loads, rather than erroring.
        const failed = state?.state === 'error' || (playbackStatus === 'loading' && state?.state === 'idle');
        failedStationKey = failed ? radioStore.getPlaying() : null;
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
      failedStationKey = stationKey(station);
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
    inc.emit('stream:channel-switch', JSON.stringify(
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

    failedStationKey = null;
    radioStore.setPlaying(stationKey(station));
    radioStore.persistLastStation(stationKey(station));
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

  async function addStationAfterCoverImageResolves(station: RadioStation, requestId: number): Promise<void> {
    coverChecksPending += 1;
    notifyUpdate();
    try {
      const validCover = await coverImageResolves(station.thumbnail);
      if (!validCover || destroyed || requestId !== pageRequestId) return;
      radioStore.addStation(station);
    } finally {
      if (!destroyed) {
        coverChecksPending = Math.max(0, coverChecksPending - 1);
        notifyUpdate();
      }
    }
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
    radioStore.setPlaying(stationKey(station));
    const current = await requestStationPlayback(station, streamUrl);
    if (current) emitChannelSwitch(station, streamUrl);
  }

  function loadNextStationPage(): void {
    const pageRequest = getNextRadioPageRequest({
      isLoading: radioStore.isLoading() || coverChecksPending > 0,
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
      (result) => {
        const event = result.event as NostrEvent;
        if (requestId !== pageRequestId) return;
        pageEventCount++;
        noteSeenStationEvent(event);
        const station = parseKind31237(event);
        if (station) {
          const coverCheck = addStationAfterCoverImageResolves(station, requestId);
          trackCoverCheck(coverCheck);
        }
      },
      async () => {
        if (requestId !== pageRequestId) return;
        closePageSubscription();

        if (pageEventCount < STATION_PAGE_LIMIT || pageEventCount === 0 || oldestSeenCreatedAt === cursorBefore) {
          hasMore = false;
        }

        await waitForCoverChecks(requestId);
        if (requestId !== pageRequestId) return;

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
    coverChecksPending = 0;
    hasMore = true;
    oldestSeenCreatedAt = null;
    pageRequestId = 0;
    restoredLastStation = false;
    loadNextStationPage();

    // Pull-on-mount responder: respond to stream:current-context-get requests
    contextSub = inc.on('stream:current-context-get', (event) => {
      const current = radioStore.getPlaying();
      const station = current ? radioStore.getStation(current) : undefined;
      const streamAddr = station ? stationStreamAddr(station) : null;
      inc.emit('stream:current-context', JSON.stringify(
        createStreamCurrentContextPayload(
          station
            ? { streamAddr, title: station.name, chatRelays: station.chatRelays }
            : { streamAddr: null, title: null, chatRelays: [] },
          event.payload,
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
    <div class="station-grid" aria-busy="true" aria-label="Loading stations" data-radio-skeleton>
      {#each { length: 8 } as _}
        <div class="skeleton-card" aria-hidden="true">
          <div class="skeleton-art"></div>
          <div class="skeleton-line wide"></div>
          <div class="skeleton-line"></div>
        </div>
      {/each}
    </div>
  {:else if !loading && stations.length === 0}
    <div class="empty-state" data-radio-empty>
      <p class="empty-title">No stations yet</p>
      <p class="empty-copy">The station list didn't return anything. New stations will show up here as they arrive.</p>
    </div>
  {:else}
    <header class="header-bar">
      <div class="header-row">
        <div class="header-info">
          <h1 class="title">Radio</h1>
          <span class="count">
            {visibleStations.length} station{visibleStations.length === 1 ? '' : 's'}{#if coverChecksPending > 0}&nbsp;· finding more…{/if}
          </span>
        </div>
        {#if genres.length > 0}
          <div class="genre-filter" class:expanded={showAllGenres} role="group" aria-label="Filter by genre">
            <button
              type="button"
              class="genre-pill"
              class:active={activeGenre === null}
              aria-pressed={activeGenre === null}
              onclick={() => (activeGenre = null)}
            >All</button>
            {#each shownGenres as genre (genre)}
              <button
                type="button"
                class="genre-pill"
                class:active={activeGenre === genre}
                aria-pressed={activeGenre === genre}
                onclick={() => (activeGenre = activeGenre === genre ? null : genre)}
              >{genre}</button>
            {/each}
            {#if genres.length > GENRE_PREVIEW_COUNT}
              <button
                type="button"
                class="genre-more"
                aria-expanded={showAllGenres}
                onclick={() => (showAllGenres = !showAllGenres)}
              >{showAllGenres ? 'Fewer' : `${genres.length - GENRE_PREVIEW_COUNT} more`}</button>
            {/if}
          </div>
        {/if}
      </div>

      {#if playingStation}
        <div class="now-playing" role="status" data-radio-now-playing>
          <span class="now-dot" class:paused={playbackStatus === 'paused'} aria-hidden="true"></span>
          <span class="now-label">{nowPlayingLabel}</span>
          <span class="now-name">{playingStation.name}</span>
        </div>
      {:else if failedStation}
        <div class="now-playing failed" role="alert" data-radio-now-playing>
          <span class="now-name">Couldn't play {failedStation.name}. Try again, or pick another station.</span>
        </div>
      {/if}
    </header>

    {#if visibleStations.length === 0 && coverChecksPending === 0}
      <div class="empty-state" data-radio-empty>
        <p class="empty-title">No stations tagged “{activeGenre}”</p>
        <button type="button" class="empty-action" onclick={() => (activeGenre = null)}>Show all stations</button>
      </div>
    {:else}
      <div class="station-grid">
        {#each visibleStations as station (stationKey(station))}
          <StationCard
            {station}
            selected={playingId === stationKey(station)}
            failed={failedStationKey === stationKey(station)}
            {playbackStatus}
            onselect={() => selectStation(station)}
          />
        {/each}
        <!-- Stations wait on a cover check before they're listed, so hold their place. -->
        {#each { length: Math.min(coverChecksPending, MAX_PENDING_PLACEHOLDERS) } as _}
          <div class="skeleton-card" aria-hidden="true" data-radio-pending>
            <div class="skeleton-art"></div>
            <div class="skeleton-line wide"></div>
            <div class="skeleton-line"></div>
          </div>
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
    {:else if visibleStations.length > 0 && coverChecksPending === 0}
      <div class="load-more-sentinel terminal" aria-live="polite">That's all the stations we found</div>
    {/if}
  {/if}
</div>

<style>
  .header-bar {
    position: sticky;
    top: 0;
    z-index: 5;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--hg-bg-base, #050505) 88%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 14%, transparent);
  }

  .header-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
  }

  .header-info {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .title {
    margin: 0;
    font: inherit;
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
    flex: 1 1 280px;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }

  @media (max-width: 560px) {
    .genre-filter {
      flex-basis: 100%;
    }
  }

  .genre-pill,
  .genre-more {
    flex: none;
    font: inherit;
    font-size: 12px;
    white-space: nowrap;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 22%, transparent);
    background: transparent;
    color: var(--hg-text-muted, #b8b1a4);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }

  .genre-pill {
    text-transform: capitalize;
  }

  .genre-more {
    border-style: dashed;
  }

  .genre-pill:hover,
  .genre-more:hover {
    color: var(--hg-text-primary, #f2efe7);
    border-color: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 50%, transparent);
  }

  .genre-pill.active {
    color: var(--hg-text-primary, #f2efe7);
    border-color: var(--hg-accent-primary, #5d5dff);
    background: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 22%, transparent);
  }

  .genre-pill:focus-visible,
  .genre-more:focus-visible,
  .empty-action:focus-visible,
  .load-more-button:focus-visible {
    outline: 2px solid var(--hg-accent-primary, #5d5dff);
    outline-offset: 2px;
  }

  .now-playing {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    min-width: 0;
    font-size: 13px;
    color: var(--hg-text-primary, #f2efe7);
  }

  .now-playing.failed {
    color: var(--hg-accent-danger, #ff5d5d);
  }

  .now-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--hg-accent-danger, #ff5d5d);
  }

  .now-dot.paused {
    background: var(--hg-text-muted, #b8b1a4);
  }

  .now-label {
    flex: none;
    color: var(--hg-text-muted, #b8b1a4);
  }

  .now-name {
    min-width: 0;
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .station-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 190px), 1fr));
    gap: 20px 16px;
    padding: 14px;
  }

  .skeleton-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .skeleton-art,
  .skeleton-line {
    background: color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 12%, transparent);
    animation: skeleton-pulse 1.4s ease-in-out infinite;
  }

  .skeleton-art {
    aspect-ratio: 1 / 1;
    border-radius: 12px;
  }

  .skeleton-line {
    height: 10px;
    width: 45%;
    margin-inline: 4px;
    border-radius: 3px;
  }

  .skeleton-line.wide {
    width: 75%;
  }

  @keyframes skeleton-pulse {
    50% {
      opacity: 0.45;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton-art,
    .skeleton-line {
      animation: none;
    }
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 72px 24px;
    text-align: center;
  }

  .empty-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--hg-text-primary, #f2efe7);
  }

  .empty-copy {
    margin: 0;
    max-width: 44ch;
    font-size: 13px;
    color: var(--hg-text-muted, #b8b1a4);
  }

  .empty-action {
    font: inherit;
    font-size: 12px;
    padding: 5px 12px;
    border: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 30%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--hg-text-primary, #f2efe7);
    cursor: pointer;
  }

  .empty-action:hover {
    border-color: var(--hg-accent-primary, #5d5dff);
  }

  .load-more-sentinel {
    min-height: 44px;
    padding: 10px 14px 16px;
    text-align: center;
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 12px;
  }

  .load-more-sentinel.terminal {
    opacity: 0.7;
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
