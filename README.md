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
