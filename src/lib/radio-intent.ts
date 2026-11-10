// napplets/radio/src/lib/radio-intent.ts
// `napplet:radio/play`: ask Radio to play a station. Pure TypeScript so vitest
// can import it without the Svelte compiler.
//
// The convention is Hyprgate's own; NAP-INTENT leaves archetype names and
// conventions to the apps that share them. Payload fields are text, so the
// query-string form works too: `napplet:radio/play?query=synthwave`.
//
//   station  a station's id (the kind 31237 d tag) or its exact name
//   query    words to look for in station names, genres and descriptions
//
// At least one is needed. `station` wins when both are given and it matches.
// A `station` that names nothing Radio knows is searched for instead: its
// words, without the ones every station shares, become the query.

import type { NostrFilter } from '@hyprgate/types';
import type { RadioStation } from './radio-store.js';

export const RADIO_ARCHETYPE = 'radio';
export const RADIO_PLAY_ACTION = 'play';
export const RADIO_PLAY_CONVENTION = 'napplet:radio/play';
export const RADIO_PLAY_PARAMS = ['query', 'station'] as const;

const MAX_FIELD_LENGTH = 200;

/** Words that say "this is a station" and nothing about which one. */
const GENERIC_WORDS = new Set([
  'radio', 'fm', 'am', 'station', 'stations', 'stream', 'live', 'online', 'channel', 'music', 'the',
  'www', 'http', 'https', 'com', 'net', 'org',
]);

export interface RadioPlayRequest {
  station?: string;
  query?: string;
}

/** The delivery fields Radio reads; the runtime attests the rest. */
export interface RadioIntentDelivery {
  archetype: string;
  action: string;
  convention: string;
  payload?: unknown;
}

function textField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_FIELD_LENGTH ? trimmed : undefined;
}

/** Returns the request, or null when the delivery is not a usable `napplet:radio/play`. */
export function radioPlayRequestFromDelivery(delivery: RadioIntentDelivery): RadioPlayRequest | null {
  if (delivery.archetype !== RADIO_ARCHETYPE || delivery.action !== RADIO_PLAY_ACTION
    || delivery.convention !== RADIO_PLAY_CONVENTION) return null;
  const payload = delivery.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const station = textField((payload as Record<string, unknown>).station);
  // A caller that guesses a station name ("synthwave.radio") still means something.
  const query = textField((payload as Record<string, unknown>).query) ?? (station ? searchWordsFromStation(station) : undefined);
  if (!station && !query) return null;
  return { ...(station ? { station } : {}), ...(query ? { query } : {}) };
}

/** The words of a station name worth searching for, or undefined when only generic ones are left. */
export function searchWordsFromStation(station: string): string | undefined {
  const kept = words(station).filter((word) => !GENERIC_WORDS.has(word));
  return kept.length > 0 ? kept.join(' ') : undefined;
}

/** What the user sees while Radio looks, and when nothing matches: the words actually searched for. */
export function radioPlayRequestLabel(request: RadioPlayRequest): string {
  return request.query ?? request.station ?? '';
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** "Synth-Wave", "synth wave" and "synthwave" compare equal. */
function compact(text: string): string {
  return words(text).join('');
}

/**
 * Relay filters that fetch the stations a request names, so Radio does not
 * have to page the whole catalog to find them. An id is the `d` tag. A query
 * is looked up as a genre: WaveFunc tags genres `["c", genre, "genre"]` and
 * other publishers use `t`, and tag filters match exactly, so the query goes
 * out in its common spellings.
 *
 * A station whose name alone matches is found only once it is loaded. Looking
 * names up on the relay needs NIP-50 `search`, which the NAP-RELAY filter type
 * does not carry.
 */
export function radioLookupFilters(request: RadioPlayRequest, limit: number): NostrFilter[] {
  const filters: NostrFilter[] = [];
  if (request.station) filters.push({ kinds: [31237], '#d': [request.station] });
  if (request.query) {
    const parts = words(request.query);
    const spellings = [...new Set([
      request.query, request.query.toLowerCase(), parts.join(' '), parts.join('-'), parts.join(''),
    ].filter(Boolean))];
    filters.push({ kinds: [31237], '#c': spellings, limit }, { kinds: [31237], '#t': spellings, limit });
  }
  return filters;
}

function isPlayable(station: RadioStation): boolean {
  return station.streams.some((stream) => Boolean(stream.url));
}

function queryScore(station: RadioStation, query: string): number {
  const wanted = compact(query);
  if (!wanted) return 0;
  const name = compact(station.name);
  const genres = station.genres.map(compact);
  if (genres.includes(wanted)) return 100;
  if (name === wanted) return 90;
  if (name.includes(wanted)) return 70;
  if (genres.some((genre) => genre.includes(wanted))) return 60;
  const queryWords = words(query);
  const labelWords = new Set([...words(station.name), ...station.genres.flatMap(words)]);
  if (queryWords.every((word) => labelWords.has(word))) return 50;
  if (compact(station.description).includes(wanted)) return 20;
  return 0;
}

/** At or above this a loaded station is played without asking the relay for better ones. */
export const STRONG_MATCH_SCORE = 90;

export interface RadioStationMatch {
  station: RadioStation;
  score: number;
}

/**
 * Every station that fits a request, best first, among stations that have a
 * stream. `station` matches an id exactly or a name ignoring case and always
 * comes first. `query` ranks by score; on a tie the station with fewer genres
 * wins, because one tagged with three genres is more about the one asked for
 * than one tagged with thirty, and after that the earliest listed.
 */
export function rankStationMatches(
  stations: readonly RadioStation[],
  request: RadioPlayRequest,
): RadioStationMatch[] {
  const wantedName = request.station?.toLowerCase();
  const matches: Array<RadioStationMatch & { index: number }> = [];
  stations.filter(isPlayable).forEach((station, index) => {
    let score = 0;
    if (request.station && station.id === request.station) score = 1000;
    else if (wantedName && station.name.trim().toLowerCase() === wantedName) score = 900;
    else if (request.query) {
      score = queryScore(station, request.query);
      // A genre match that also carries the words in its name is the most on topic.
      if (score === 100 && compact(station.name).includes(compact(request.query))) score = 110;
    }
    if (score > 0) matches.push({ station, score, index });
  });
  matches.sort((left, right) => right.score - left.score
    || left.station.genres.length - right.station.genres.length
    || left.index - right.index);
  return matches.map(({ station, score }) => ({ station, score }));
}

/** The best station for a request, or null. */
export function findStationForRequest(
  stations: readonly RadioStation[],
  request: RadioPlayRequest,
): RadioStation | null {
  return rankStationMatches(stations, request)[0]?.station ?? null;
}
