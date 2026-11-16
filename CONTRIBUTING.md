# Contributing

Thanks for considering a contribution. Contributing here is easy: no build step, no runtime dependencies.

## Setup

```bash
npm install
```

## Before you open a PR

```bash
npm test        # node:test, runs on the current Node (>= 22.6)
npm run typecheck   # tsc --noEmit
```

Then try the extension in a live session:

```bash
pi -e /path/to/this/repo
```

## Guidelines

- Keep the extension dependency-free: Pi provides `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as peers. Anything else needs a strong justification.
- No build step. The TypeScript source is what Pi loads and what npm ships.
- No network calls, no telemetry, no data collection. A move only touches files under the Pi agent directory, on purpose.
- Never delete a session file: originals go to the trash, and every step before the switch must be undoable.
- Tests live in `test/` and run with `node --test` against temporary session trees. Keep the filesystem logic in `relocate.ts`, free of Pi runtime calls, so it stays testable.
- Keep messages shown to the user short and concrete: what happened, and what the options are.

## Releasing

Versions are bumped manually and released by tagging:

```bash
npm version patch|minor|major
git push --follow-tags
```

The `release` GitHub Action publishes to npm on `v*` tags using npm trusted publishing (OIDC), so no npm token is stored in the repo.

First publish only: the package name must exist on npm and be linked to this repo as a trusted publisher (npmjs.com, package settings, "Trusted Publisher": repository `clementprevot/pi-session-relocate`, workflow `release.yml`). Publish the first version locally with `npm publish` while logged in, then link the trusted publisher so later tags publish automatically.
