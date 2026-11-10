import { describe, expect, it } from 'vitest';
import {
  findStationForRequest,
  radioLookupFilters,
  rankStationMatches,
  STRONG_MATCH_SCORE,
  radioPlayRequestFromDelivery,
  radioPlayRequestLabel,
  searchWordsFromStation,
} from './radio-intent.js';
import type { RadioStation } from './radio-store.js';

function station(overrides: Partial<RadioStation> & Pick<RadioStation, 'id' | 'name'>): RadioStation {
  return {
    genres: [],
    thumbnail: null,
    streams: [{ url: `https://radio.example.test/${overrides.id}.mp3`, format: 'audio/mpeg', quality: null, primary: true }],
    description: '',
    pubkey: 'a'.repeat(64),
    createdAt: 1700000000,
    chatRelays: [],
    ...overrides,
  };
}

function delivery(payload: unknown, overrides: Record<string, string> = {}) {
  return { sender: 'shell', archetype: 'radio', action: 'play', convention: 'napplet:radio/play', payload, ...overrides };
}

describe('radioPlayRequestFromDelivery', () => {
  it('reads the station and query text fields of napplet:radio/play', () => {
    expect(radioPlayRequestFromDelivery(delivery({ query: ' synthwave ' }))).toEqual({ query: 'synthwave' });
    expect(radioPlayRequestFromDelivery(delivery({ station: 'nightride-fm' }))).toEqual({ station: 'nightride-fm', query: 'nightride' });
    expect(radioPlayRequestFromDelivery(delivery({ station: 'nightride-fm', query: 'synthwave', extra: 1 })))
      .toEqual({ station: 'nightride-fm', query: 'synthwave' });
  });

  it('ignores other conventions and payloads without a usable field', () => {
    expect(radioPlayRequestFromDelivery(delivery({ query: 'synthwave' }, { convention: 'napplet:radio/open', action: 'open' }))).toBeNull();
    expect(radioPlayRequestFromDelivery(delivery({ query: 'synthwave' }, { archetype: 'note', convention: 'napplet:note/play' }))).toBeNull();
    for (const payload of [undefined, null, 'synthwave', ['synthwave'], {}, { query: '   ' }, { query: 7 }, { station: 'x'.repeat(201) }]) {
      expect(radioPlayRequestFromDelivery(delivery(payload))).toBeNull();
    }
  });

  it('searches for the telling words of a station name it may not know', () => {
    const guessed = radioPlayRequestFromDelivery(delivery({ station: 'synthwave.radio' }))!;
    expect(guessed).toEqual({ station: 'synthwave.radio', query: 'synthwave' });
    expect(radioPlayRequestLabel(guessed)).toBe('synthwave');
    expect(radioLookupFilters(guessed, 500)).toEqual([
      { kinds: [31237], '#d': ['synthwave.radio'] },
      { kinds: [31237], '#c': ['synthwave'], limit: 500 },
      { kinds: [31237], '#t': ['synthwave'], limit: 500 },
    ]);
    expect(radioPlayRequestFromDelivery(delivery({ station: 'The Dark Jazz Station FM' }))?.query).toBe('dark jazz');
    // Nothing but generic words: only the name itself can match.
    expect(radioPlayRequestFromDelivery(delivery({ station: 'Radio FM' }))).toEqual({ station: 'Radio FM' });
    // An explicit query is kept as given.
    expect(radioPlayRequestFromDelivery(delivery({ station: 'synthwave.radio', query: 'jazz' }))?.query).toBe('jazz');
    expect(searchWordsFromStation('www.synthwave-radio.com')).toBe('synthwave');
  });

  it('labels a request by what was asked for', () => {
    expect(radioPlayRequestLabel({ query: 'synthwave', station: 'nightride-fm' })).toBe('synthwave');
    expect(radioPlayRequestLabel({ station: 'nightride-fm' })).toBe('nightride-fm');
  });
});

describe('findStationForRequest', () => {
  const stations = [
    station({ id: 'jazz-24', name: 'Jazz 24', genres: ['jazz'], description: 'No synthwave here, only jazz.' }),
    station({ id: 'wave-city', name: 'Synthwave City FM', genres: ['electronic'] }),
    station({ id: 'nightride-fm', name: 'Nightride FM', genres: ['Synth-Wave', 'retrowave'] }),
    station({ id: 'dark-synth', name: 'Dark Corner', genres: ['darksynthwave'] }),
    station({ id: 'silent', name: 'Synthwave Silent', genres: ['synthwave'], streams: [] }),
  ];

  it('matches a station id exactly, then a name ignoring case', () => {
    expect(findStationForRequest(stations, { station: 'jazz-24' })?.id).toBe('jazz-24');
    expect(findStationForRequest(stations, { station: 'nightride fm' })?.id).toBe('nightride-fm');
    expect(findStationForRequest(stations, { station: 'Nightride' })).toBeNull();
  });

  it('prefers a genre match, then the name, then a looser genre, then the description', () => {
    expect(findStationForRequest(stations, { query: 'synthwave' })?.id).toBe('nightride-fm');
    expect(findStationForRequest(stations, { query: 'synth wave' })?.id).toBe('nightride-fm');
    expect(findStationForRequest(stations.filter((item) => item.id !== 'nightride-fm'), { query: 'synthwave' })?.id).toBe('wave-city');
    expect(findStationForRequest(stations.filter((item) => !['nightride-fm', 'wave-city'].includes(item.id)), { query: 'synthwave' })?.id).toBe('dark-synth');
    expect(findStationForRequest([stations[0]!], { query: 'synthwave' })?.id).toBe('jazz-24');
  });

  it('matches every word across name and genres, and keeps the earliest station on a tie', () => {
    expect(findStationForRequest(stations, { query: 'fm retrowave' })?.id).toBe('nightride-fm');
    const tied = [station({ id: 'first', name: 'First', genres: ['ambient'] }), station({ id: 'second', name: 'Second', genres: ['ambient'] })];
    expect(findStationForRequest(tied, { query: 'ambient' })?.id).toBe('first');
  });

  it('falls back from an unknown station to the query, and never picks a station without a stream', () => {
    expect(findStationForRequest(stations, { station: 'missing', query: 'jazz' })?.id).toBe('jazz-24');
    expect(findStationForRequest(stations, { station: 'silent' })).toBeNull();
    expect(findStationForRequest([stations[4]!], { query: 'synthwave' })).toBeNull();
    expect(findStationForRequest(stations, { query: 'polka' })).toBeNull();
    expect(findStationForRequest(stations, { query: '---' })).toBeNull();
  });
});

describe('radioLookupFilters', () => {
  it('asks for a station id by its d tag', () => {
    expect(radioLookupFilters({ station: 'nightride-fm' }, 500)).toEqual([{ kinds: [31237], '#d': ['nightride-fm'] }]);
  });

  it('asks for a query as a genre tag in its common spellings', () => {
    expect(radioLookupFilters({ query: 'synthwave' }, 500)).toEqual([
      { kinds: [31237], '#c': ['synthwave'], limit: 500 },
      { kinds: [31237], '#t': ['synthwave'], limit: 500 },
    ]);
    const [, byGenre] = radioLookupFilters({ station: 'nightride-fm', query: 'Synth Wave' }, 500);
    expect(byGenre).toEqual({ kinds: [31237], '#c': ['Synth Wave', 'synth wave', 'synth-wave', 'synthwave'], limit: 500 });
  });
});

describe('rankStationMatches', () => {
  // The live catalog case: sixteen genres with the one asked for in eleventh place, against focused stations.
  const broad = station({ id: 'high-fi-dream', name: 'High Fi Dream', genres: ['new wave', 'shoegaze', 'melodic house', 'dream pop', 'electronic', 'synthwave', 'synthpop', 'indie'] });
  const focused = station({ id: 'nightride-fm', name: 'Nightride FM', genres: ['outrun', 'retrowave', 'synthwave'] });
  const named = station({ id: 'synthwave-city', name: 'Synthwave City FM', genres: ['synthwave', 'electronic', 'chillsynth', 'darksynth'] });
  const mention = station({ id: 'talk', name: 'Talk Radio', genres: ['talk'], description: 'Sometimes we discuss synthwave.' });
  const silent = station({ id: 'silent', name: 'Synthwave Silent', genres: ['synthwave'], streams: [] });

  it('puts the station most about the genre first and keeps the rest as fallbacks', () => {
    const ranked = rankStationMatches([mention, broad, silent, focused, named], { query: 'synthwave' });
    expect(ranked.map((match) => match.station.id)).toEqual(['synthwave-city', 'nightride-fm', 'high-fi-dream', 'talk']);
    expect(ranked.map((match) => match.score)).toEqual([110, 100, 100, 20]);
    expect(ranked[3]!.score).toBeLessThan(STRONG_MATCH_SCORE);
  });

  it('puts a station asked for by id or name ahead of query matches', () => {
    expect(rankStationMatches([focused, named, broad], { station: 'high-fi-dream', query: 'synthwave' }).map((match) => match.station.id))
      .toEqual(['high-fi-dream', 'synthwave-city', 'nightride-fm']);
    expect(rankStationMatches([focused, named], { station: 'nightride fm' })).toEqual([{ station: focused, score: 900 }]);
    expect(rankStationMatches([focused, named], { query: 'polka' })).toEqual([]);
  });
});
