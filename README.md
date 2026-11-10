<!-- HYPRGATE NAPPLET MIRROR NOTICE:START -->
> This repository is a read-only mirror of the `radio` napplet from `hyprgate/gui`.
> Open issues and pull requests in https://github.com/hyprgate/gui.
> Do not push commits to this standalone napplet repository; direct changes are overwritten by Hyprgate's mirror workflow.
<!-- HYPRGATE NAPPLET MIRROR NOTICE:END -->

# Radio

Internet radio stations from kind 31237 events, with genre filters and playback through the
shell's player.

Package: `@hyprgate/napp-radio`. Source lives in the Hyprgate monorepo at `napplets/radio`. The
standalone `hyprgate/napplet-radio` repository is a generated, read-only mirror, so send changes
to `hyprgate/web`.

## Runtime playback lifecycle

Starting a station replaces video playback in the same workspace, including
live streams. The shared shell player owns station queue navigation, volume,
mute, Live Chat context, and OS media controls. OS metadata and controls follow
the runtime player even while another app is focused. Station changes update
the OS title and artwork; stopping clears Radio's selected card, while pausing
keeps it selected.

## Play intent

Radio handles `napplet:radio/play` (NAP-INTENT, archetype `radio`). Its manifest
advertises the convention with the payload fields `query` and `station`, so
other apps and the shell can find it through `intent.available('radio')`.

| Field | Type | Meaning |
| --- | --- | --- |
| `station` | text | A station's id (the kind-31237 `d` tag) or its exact name, ignoring case. |
| `query` | text | Words to look for, such as a genre. |

At least one field is needed; each is at most 200 characters. A `station`
that names nothing Radio knows is treated as a search: its words, without the
ones every station shares (“radio”, “fm”, “station” and the like), become the
query, so `synthwave.radio` looks for synthwave, and the notice says so. Both are text, so
`napplet:radio/play?query=synthwave` carries the same request as the payload
`{ "query": "synthwave" }`.

Radio plays the best match among stations that have a stream: `station` first,
then `query` scored as an exact genre, the station name, a genre containing the
words, every word across name and genres, and last the description. Spacing,
case and punctuation are ignored, and the earliest listed station wins a tie.
A station that is already loaded plays at once. Otherwise Radio asks the relay
for it with one request instead of paging the catalog: an id by its `d` tag,
and a query as a genre tag (`c`, which WaveFunc uses, and `t`) in its common
spellings. WaveFunc holds tens of thousands of stations and rate-limits a
client that walks them, so Radio never pages to find a match. Looked-up
stations are not held back for their cover images the way a page of stations
is: covers are slowest just after Radio opens, which is when an agent's
request tends to arrive. The best match plays 1.5 s after the relay's first
result, or as soon as the shell reports the end of them, and joins the grid
with its two fallbacks. Radio does not wait for that end: the shell reports
it only after its own cache has answered, which takes several seconds while a
station page is being stored. Among stations tagged with the genre, one
that also has the words in its name comes first, then the one with the fewest
genres: a station tagged with three genres is more about the one asked for
than one tagged with thirty.

A listed station's stream can be dead. Radio watches what the shell player
reports for the station it started for a request: on an error, or without
playback after 10 seconds, it moves to the next match, up to three stations,
using the matches it already has. If none plays it says “Stations matching …
were found, but none would play.”
While it looks it says “Looking for a station matching …”; when nothing
matches, or after 20 seconds without an answer, it says “No station matches …”
and leaves whatever was playing alone. A request that
arrives while Radio opens wins over the station restored from last time, and
picking a station by hand ends a pending request.

A station whose name alone matches (no matching genre tag) is found only when
it is already loaded. Looking names up across the catalog needs NIP-50
`search`, which WaveFunc supports but the NAP-RELAY filter type does not
carry.

The convention is Hyprgate's own; NAP-INTENT has no registry for archetypes or
conventions. An intent is delivered, not answered: the sender is not told
whether a station matched.

From the shell's control plane (terminal, WebMCP, paired agents):

```
intent invoke napplet:radio/play --payload '{"query":"synthwave"}'
```

## Station discovery

Radio pages through `wss://relay.wavefunc.live` in requests of at most 500
kind-31237 events. Larger requests currently receive `CLOSED` with
`restricted: limit must not exceed 500`; that ends the subscription instead
of returning a shortened page. A full page retains the existing `until` cursor
and Load more behavior.

When changing Radio during shell development, rebuild the app and restart the
shell dev server. The local relay/Blossom harness publishes the built package at
server startup; rebuilding alone does not replace its in-memory package.

A station is only listed once its cover image has proven loadable, so stations with no cover or
a broken one stay out of counts, filters and the playback queue. The grid holds placeholders
while those checks run.

## Working on it

Run these from the Hyprgate checkout so `workspace:*` packages resolve:

```bash
pnpm install --frozen-lockfile
pnpm --filter ./napplets/radio paja        # Kehto Paja plus the Vite dev server
pnpm --filter ./napplets/radio exec vitest run
pnpm --filter ./napplets/radio type-check
pnpm --filter ./napplets/radio conformance # builds, then checks dist/
```
