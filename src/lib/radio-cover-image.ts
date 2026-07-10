import { loadResourceObjectUrls, type ResourceObjectUrlSubscription } from '@hyprgate/utils';

const COVER_IMAGE_RESOLVE_TIMEOUT_MS = 10_000;
export const COVER_IMAGE_RESOURCE_BATCH_SIZE = 20;
export const COVER_IMAGE_RESOURCE_BATCH_INTERVAL_MS = 250;

const NOOP_SUBSCRIPTION: ResourceObjectUrlSubscription = {
  close: () => {
    /* no-op */
  },
};

function normalizedSource(source: string | null | undefined): string | null {
  if (typeof source !== 'string') return null;
  const trimmed = source.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface CoverImageRequest {
  resolve(valid: boolean): void;
  source: string;
  timeoutMs: number;
}

const pendingCoverImageRequests: CoverImageRequest[] = [];
const activeCoverImageResolutions = new Map<string, Promise<boolean>>();
let coverImageBatchTimer: ReturnType<typeof setTimeout> | null = null;
let lastCoverImageBatchStartedAt = 0;

function coverImageResolutionKey(source: string, timeoutMs: number): string {
  return `${source}\0${timeoutMs}`;
}

function scheduleNextCoverImageBatch(): void {
  if (coverImageBatchTimer !== null || pendingCoverImageRequests.length === 0) return;
  const elapsed = Date.now() - lastCoverImageBatchStartedAt;
  const delay = lastCoverImageBatchStartedAt === 0
    ? 0
    : Math.max(0, COVER_IMAGE_RESOURCE_BATCH_INTERVAL_MS - elapsed);
  coverImageBatchTimer = setTimeout(processNextCoverImageBatch, delay);
}

function processNextCoverImageBatch(): void {
  coverImageBatchTimer = null;
  if (pendingCoverImageRequests.length === 0) return;
  lastCoverImageBatchStartedAt = Date.now();

  const batch = pendingCoverImageRequests.splice(0, COVER_IMAGE_RESOURCE_BATCH_SIZE);
  processCoverImageBatch(batch);
  scheduleNextCoverImageBatch();
}

function processCoverImageBatch(batch: CoverImageRequest[]): void {
  const requestsBySource = new Map<string, CoverImageRequest[]>();
  for (const request of batch) {
    const existing = requestsBySource.get(request.source) ?? [];
    existing.push(request);
    requestsBySource.set(request.source, existing);
  }

  const pendingSources = new Set(requestsBySource.keys());
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const images = new Map<string, HTMLImageElement>();
  let subscription: ResourceObjectUrlSubscription = NOOP_SUBSCRIPTION;
  let closeAfterAssign = false;

  function maybeCloseSubscription(): void {
    if (pendingSources.size > 0) return;
    if (subscription === NOOP_SUBSCRIPTION) {
      closeAfterAssign = true;
    } else {
      subscription.close();
    }
  }

  function finishSource(source: string, valid: boolean): void {
    if (!pendingSources.delete(source)) return;
    const timer = timers.get(source);
    if (timer) clearTimeout(timer);
    timers.delete(source);

    const image = images.get(source);
    if (image) {
      image.onload = null;
      image.onerror = null;
      images.delete(source);
    }

    for (const request of requestsBySource.get(source) ?? []) request.resolve(valid);
    maybeCloseSubscription();
  }

  function probeResolvedUrl(source: string, url: string | null): void {
    if (!pendingSources.has(source)) return;
    if (!url) return;

    const image = new Image();
    images.set(source, image);
    image.onload = () => finishSource(source, true);
    image.onerror = () => finishSource(source, false);
    image.src = url;

    if (image.complete) {
      queueMicrotask(() => {
        if (!pendingSources.has(source)) return;
        finishSource(source, image.naturalWidth > 0 || image.naturalHeight > 0);
      });
    }
  }

  for (const [source, requests] of requestsBySource) {
    const timeoutMs = Math.max(...requests.map((request) => request.timeoutMs));
    timers.set(source, setTimeout(() => finishSource(source, false), timeoutMs));
  }

  try {
    subscription = loadResourceObjectUrls(
      [...requestsBySource.keys()],
      probeResolvedUrl,
      {
        chunkSize: COVER_IMAGE_RESOURCE_BATCH_SIZE,
      },
    );
  } catch {
    for (const source of [...pendingSources]) finishSource(source, false);
  }

  if (closeAfterAssign) subscription.close();
}

export function coverImageResolves(
  source: string | null | undefined,
  timeoutMs = COVER_IMAGE_RESOLVE_TIMEOUT_MS,
): Promise<boolean> {
  const normalized = normalizedSource(source);
  if (!normalized) return Promise.resolve(false);

  const key = coverImageResolutionKey(normalized, timeoutMs);
  const active = activeCoverImageResolutions.get(key);
  if (active) return active;

  const promise = new Promise<boolean>((resolve) => {
    pendingCoverImageRequests.push({ resolve, source: normalized, timeoutMs });
    scheduleNextCoverImageBatch();
  }).finally(() => {
    activeCoverImageResolutions.delete(key);
  });
  activeCoverImageResolutions.set(key, promise);
  return promise;
}
