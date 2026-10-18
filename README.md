<!-- HYPRGATE NAPPLET MIRROR NOTICE:START -->
> This repository is a read-only mirror of the `radio` napplet from `hyprgate/gui`.
> Open issues and pull requests in https://github.com/hyprgate/gui.
> Do not push commits to this standalone napplet repository; direct changes are overwritten by Hyprgate's mirror workflow.
<!-- HYPRGATE NAPPLET MIRROR NOTICE:END -->

# napplet-radio

[![CI](https://github.com/hyprgate/napplet-radio/actions/workflows/ci.yml/badge.svg)](https://github.com/hyprgate/napplet-radio/actions/workflows/ci.yml)

Forkable source repository for the Hyprgate built-in napplet currently packaged as `@hyprgate/napp-radio`.

This repository was split from `hyprgate/gui` and is mounted back into the parent checkout as `napplets/radio`.
It still expects the parent workspace when built through Hyprgate because shared `@hyprgate/*` packages remain workspace dependencies.

## Parent checkout

```bash
git clone --recurse-submodules git@github.com:hyprgate/gui.git
cd gui
pnpm install --frozen-lockfile
pnpm --filter @hyprgate/napp-radio build
```

## Paja runtime

```bash
pnpm --filter @hyprgate/napp-radio paja
```

This starts Kehto Paja and the napplet's Vite dev server together, using
the port configured in `vite.config.ts`.

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

## Testing

Run these checks from a Hyprgate parent checkout so workspace dependencies resolve:

```bash
git clone --recurse-submodules git@github.com:hyprgate/gui.git
cd gui
pnpm install --frozen-lockfile
pnpm --filter @hyprgate/napp-radio conformance
pnpm --filter @hyprgate/napp-radio test
pnpm --filter @hyprgate/napp-radio build
```

The `conformance` script builds the napplet and runs `@napplet/conformance-cli` against `dist/`. CI runs the same conformance, unit test, and build checks for every push and pull request.

CI runs from the standalone napplet repository but checks out `hyprgate/gui` to resolve private `workspace:*` packages. Configure `HYPRGATE_GUI_CHECKOUT_TOKEN` with read access to `hyprgate/gui` before enabling GitHub Actions.
