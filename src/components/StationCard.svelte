<script lang="ts">
  import { resourceImage } from '@hyprgate/utils';
  import type { RadioStation } from '../lib/radio-store.js';

  interface Props {
    station: RadioStation;
    isPlaying: boolean;
    loading?: boolean;
    onselect: () => void;
  }

  let { station, isPlaying, loading = false, onselect }: Props = $props();

  const MAX_CARD_GENRES = 3;
  let cardGenres = $derived(station.genres.slice(0, MAX_CARD_GENRES));
</script>

<div class="card group" class:active={isPlaying}>
  <button
    class="thumb"
    onclick={onselect}
    aria-pressed={isPlaying}
    title={station.name}
  >
    {#if station.thumbnail}
      <img
        use:resourceImage={station.thumbnail}
        alt={station.name}
        class="w-full h-full object-cover"
      />
    {:else}
      <div class="thumb-fallback" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M9 18V6l10-2v12" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="16" cy="16" r="3" />
        </svg>
      </div>
    {/if}

    <div class="play-overlay" aria-hidden="true">
      <span class="play-glyph">
        {#if isPlaying}
          <svg viewBox="0 0 24 24" focusable="false"><path d="M8 6v12" /><path d="M16 6v12" /></svg>
        {:else}
          <svg viewBox="0 0 24 24" focusable="false"><path d="M8 5.5v13l10-6.5z" /></svg>
        {/if}
      </span>
    </div>

    {#if isPlaying}
      <div class="badge badge-live">
        <span class="live-dot" class:is-buffering={loading}></span>
        {loading ? 'TUNING' : 'LIVE'}
      </div>
    {/if}
  </button>

  <div class="info">
    <div class="name" title={station.name}>{station.name}</div>
    {#if cardGenres.length > 0}
      <div class="genres">
        {#each cardGenres as genre (genre)}
          <span class="genre-chip">{genre}</span>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .card {
    display: flex;
    flex-direction: column;
    width: 100%;
    text-align: left;
  }

  .thumb {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 1 / 1;
    background: var(--hg-bg-elevated, #1a1a1a);
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 12%, transparent);
    border-radius: 12px;
    padding: 0;
    cursor: pointer;
    color: inherit;
    transition: box-shadow 160ms ease, border-color 160ms ease, transform 160ms ease;
  }

  .thumb:hover {
    transform: translateY(-2px);
    border-color: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 42%, transparent);
    box-shadow: 0 12px 28px color-mix(in srgb, var(--hg-shadow-color, #000) 48%, transparent);
  }

  .card.active .thumb {
    border-color: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 70%, transparent);
    box-shadow:
      inset 0 0 0 2px var(--hg-accent-primary, #5d5dff),
      0 0 24px color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 26%, transparent);
  }

  .thumb-fallback {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    background:
      radial-gradient(circle at 32% 28%, color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 26%, transparent), transparent 60%),
      color-mix(in srgb, var(--hg-bg-elevated, #1a1a1a) 92%, transparent);
    color: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 70%, var(--hg-text-muted, #b8b1a4));
  }

  .thumb-fallback svg {
    width: 38%;
    height: 38%;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .thumb-fallback svg path:first-child {
    fill: currentColor;
    stroke: none;
    opacity: 0.85;
  }

  .play-overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--hg-bg-base, #050505) 34%, transparent);
    opacity: 0;
    transition: opacity 160ms ease;
    pointer-events: none;
  }

  .thumb:hover .play-overlay,
  .thumb:focus-visible .play-overlay,
  .card.active .play-overlay {
    opacity: 1;
  }

  .play-glyph {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border-radius: 999px;
    color: var(--hg-bg-base, #050505);
    background: var(--hg-accent-primary, #5d5dff);
    box-shadow: 0 6px 18px color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 40%, transparent);
  }

  .play-glyph svg {
    width: 22px;
    height: 22px;
    fill: currentColor;
    stroke: none;
  }

  .badge {
    position: absolute;
    top: 8px;
    left: 8px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    line-height: 1;
    padding: 4px 7px;
    border-radius: 999px;
  }

  .badge-live {
    color: var(--hg-text-primary, #f2efe7);
    background: color-mix(in srgb, var(--hg-bg-base, #050505) 70%, transparent);
    backdrop-filter: blur(4px);
  }

  .live-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--hg-accent-danger, #ff5d5d);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--hg-accent-danger, #ff5d5d) 24%, transparent);
    animation: live-pulse 1.6s ease-in-out infinite;
  }

  .live-dot.is-buffering {
    background: var(--hg-accent-primary, #5d5dff);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 24%, transparent);
  }

  @keyframes live-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .info {
    padding: 8px 4px 0;
    min-width: 0;
  }

  .name {
    font-size: 13px;
    font-weight: 600;
    color: var(--hg-text-primary, #f2efe7);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .genres {
    display: flex;
    flex-wrap: nowrap;
    gap: 4px;
    margin-top: 6px;
    overflow: hidden;
    max-height: 20px;
  }

  .genre-chip {
    flex: none;
    font-size: 10px;
    line-height: 1;
    white-space: nowrap;
    padding: 3px 7px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 20%, transparent);
    color: var(--hg-text-muted, #b8b1a4);
  }
</style>
