import { describe, expect, it } from 'vitest';
import { getNextRadioPageRequest } from './radio-pagination.js';

describe('getNextRadioPageRequest', () => {
  it('requests the first station page without an until cursor', () => {
    expect(getNextRadioPageRequest({
      isLoading: false,
      loadingMore: false,
      hasMore: true,
      loadedStationCount: 0,
      oldestSeenCreatedAt: null,
    })).toEqual({
      initialLoad: true,
      until: undefined,
      cursorBefore: null,
    });
  });

  it('requests the next station page with until set to oldest seen station minus one', () => {
    expect(getNextRadioPageRequest({
      isLoading: false,
      loadingMore: false,
      hasMore: true,
      loadedStationCount: 1000,
      oldestSeenCreatedAt: 1_700_000_000,
    })).toEqual({
      initialLoad: false,
      until: 1_699_999_999,
      cursorBefore: 1_700_000_000,
    });
  });

  it('does not request while loading or after exhaustion', () => {
    expect(getNextRadioPageRequest({
      isLoading: true,
      loadingMore: false,
      hasMore: true,
      loadedStationCount: 1,
      oldestSeenCreatedAt: 1_700_000_000,
    })).toBeNull();

    expect(getNextRadioPageRequest({
      isLoading: false,
      loadingMore: true,
      hasMore: true,
      loadedStationCount: 1,
      oldestSeenCreatedAt: 1_700_000_000,
    })).toBeNull();

    expect(getNextRadioPageRequest({
      isLoading: false,
      loadingMore: false,
      hasMore: false,
      loadedStationCount: 1,
      oldestSeenCreatedAt: 1_700_000_000,
    })).toBeNull();
  });
});
