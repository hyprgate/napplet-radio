export interface RadioPageRequestInput {
  isLoading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadedStationCount: number;
  oldestSeenCreatedAt: number | null;
}

export interface RadioPageRequest {
  initialLoad: boolean;
  until: number | undefined;
  cursorBefore: number | null;
}

export function getNextRadioPageRequest(input: RadioPageRequestInput): RadioPageRequest | null {
  if (input.isLoading || input.loadingMore || !input.hasMore) return null;

  return {
    initialLoad: input.loadedStationCount === 0 && input.oldestSeenCreatedAt === null,
    until: input.oldestSeenCreatedAt === null ? undefined : input.oldestSeenCreatedAt - 1,
    cursorBefore: input.oldestSeenCreatedAt,
  };
}
