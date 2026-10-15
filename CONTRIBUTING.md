# Contributing

## Branches and commits

- `main`: validated prototype baseline and subsequent checked releases.
- `develop`: integration branch for upcoming changes.
- `feature/<description>`: new gameplay, presentation, or tooling work.
- `fix/<description>`: a focused bug fix.
- `chore/<description>`: maintenance and dependency updates.

Start each task from an up-to-date `develop`. Keep commits focused and use a short, imperative subject,
such as `feat(game): add a lap countdown cue` or `fix(sim): reject reversed gate crossings`.
Use the body to explain behavior, tradeoffs, and relevant validation when needed.

Open pull requests into `develop`; integrate checked milestones into `main`. Use merge commits when
integrating a feature or milestone so its boundary remains visible. The initial `feature/import-canyon-charge`
branch is retained as the record of the existing game's import. Its commits group imported files by role;
they do not claim that the underlying game was developed in that sequence.

## Required validation

Install Node.js 22.12+ and pnpm 10.18.0, then install the pinned dependencies:

```bash
pnpm install --frozen-lockfile
pnpm install --dir server --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:server
```

GitHub Actions runs these checks on Windows and Linux. Browser flow checks are separate and need a
running dev server and Chromium; follow the setup guide. Describe manual checks and any checks you
could not run in the pull request.

Gameplay state changes belong in fixed steps inside `src/sim/`; UI, rendering, audio, and networking
read simulation state. Keep client and ghost-service simulation builds matched. Add regression coverage
when changing race rules, input encoding, deterministic state, or the server protocol.

## Files to commit

Include source, lockfiles, tests, required runtime assets, and relevant documentation. Keep secrets,
installed dependencies, build output, generated `server/lib/`, screenshots, and local logs out of commits.
Preserve asset credits and font licenses. Large raw production assets remain outside the normal checkout.
