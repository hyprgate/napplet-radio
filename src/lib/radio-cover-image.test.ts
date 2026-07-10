import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadResourceObjectUrls } from '@hyprgate/utils';
import {
  COVER_IMAGE_RESOURCE_BATCH_INTERVAL_MS,
  COVER_IMAGE_RESOURCE_BATCH_SIZE,
  coverImageResolves,
} from './radio-cover-image.js';

const resourceObjectUrlBatchMock = vi.hoisted(() => {
  const state = {
    resolvedUrls: new Map<string, string | null>(),
    resolutionSequences: new Map<string, Array<string | null>>(),
  };
  const loadResourceObjectUrls = vi.fn((
    sources: readonly string[],
    onChange: (source: string, url: string | null) => void,
  ) => {
    queueMicrotask(() => {
      for (const source of sources) {
        const sequence = state.resolutionSequences.get(source)
          ?? [state.resolvedUrls.has(source) ? state.resolvedUrls.get(source)! : `blob:${source}`];
        for (const url of sequence) onChange(source, url);
      }
    });
    return { close: vi.fn() };
  });
  return { loadResourceObjectUrls, state };
});

const imageMock = vi.hoisted(() => ({
  outcomes: new Map<string, 'load' | 'error' | 'pending'>(),
}));

vi.mock('@hyprgate/utils', () => ({
  loadResourceObjectUrls: resourceObjectUrlBatchMock.loadResourceObjectUrls,
}));

function stubImageLoader(): void {
  class MockImage {
    onload: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    complete = false;
    naturalWidth = 0;
    naturalHeight = 0;
    private source = '';

    get src(): string {
      return this.source;
    }

    set src(value: string) {
      this.source = value;
      const outcome = imageMock.outcomes.get(value) ?? 'load';
      if (outcome === 'pending') return;
      queueMicrotask(() => {
        if (outcome === 'load') {
          this.complete = true;
          this.naturalWidth = 64;
          this.naturalHeight = 64;
          this.onload?.(new Event('load'));
          return;
        }
        this.onerror?.(new Event('error'));
      });
    }
  }

  vi.stubGlobal('Image', MockImage);
}

describe('coverImageResolves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    resourceObjectUrlBatchMock.state.resolvedUrls.clear();
    resourceObjectUrlBatchMock.state.resolutionSequences.clear();
    imageMock.outcomes.clear();
    stubImageLoader();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('batches and paces cover resource resolution to stay under the init-burst firewall', async () => {
    vi.useFakeTimers();
    const sources = Array.from(
      { length: COVER_IMAGE_RESOURCE_BATCH_SIZE + 5 },
      (_, index) => `https://cover.example.test/${index}.png`,
    );

    const results = sources.map((source) => coverImageResolves(source));

    expect(loadResourceObjectUrls).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(loadResourceObjectUrls).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadResourceObjectUrls).mock.calls[0]![0]).toEqual(sources.slice(0, COVER_IMAGE_RESOURCE_BATCH_SIZE));

    await vi.advanceTimersByTimeAsync(COVER_IMAGE_RESOURCE_BATCH_INTERVAL_MS - 1);
    expect(loadResourceObjectUrls).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(loadResourceObjectUrls).toHaveBeenCalledTimes(2);
    expect(vi.mocked(loadResourceObjectUrls).mock.calls[1]![0]).toEqual(sources.slice(COVER_IMAGE_RESOURCE_BATCH_SIZE));

    await expect(Promise.all(results)).resolves.toEqual(sources.map(() => true));
  });

  it('returns false when the resolved cover URL is not a loadable image', async () => {
    const source = 'https://cover.example.test/broken.png';
    resourceObjectUrlBatchMock.state.resolvedUrls.set(source, 'blob:broken-cover');
    imageMock.outcomes.set('blob:broken-cover', 'error');

    await expect(coverImageResolves(source)).resolves.toBe(false);
  });

  it('waits for a later object URL when a pending resource reports null first', async () => {
    const source = 'https://cover.example.test/pending.png';
    resourceObjectUrlBatchMock.state.resolutionSequences.set(source, [null, 'blob:pending-cover']);

    await expect(coverImageResolves(source)).resolves.toBe(true);
  });

  it('returns false without a resource request when the station has no cover source', async () => {
    await expect(coverImageResolves(null)).resolves.toBe(false);
    expect(loadResourceObjectUrls).not.toHaveBeenCalled();
  });
});
