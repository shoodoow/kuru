# Contributing

Thanks for helping with Kuru.

## Setup

1. Node.js >= 22.13, pnpm 12.6 (`corepack` or `npm i -g pnpm@12.6.0`), Docker.
2. `pnpm install`
3. `docker compose up -d postgres && pnpm db:migrate`
4. Copy env examples:
   - `apps/core/.env.example` → `apps/core/.env`
   - `apps/mobile/.env.example` → `apps/mobile/.env`
5. Full tunnel/OAuth/push walkthrough: `deploy/SETUP.md`.

Never commit `.env` or real secrets. Test fixtures only.

## Workflow

- Branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`.
- Keep PRs small and focused; one behavior change per PR.
- Update docs when setup, env vars, or user flows change (`README.md`, `deploy/SETUP.md`).
- Add/extend tests for behavior changes:
  - core: `pnpm --filter core test` (needs local Postgres + Docker; runs against its own `nano_agents_test` database, created on first run)
  - mobile: `pnpm --filter mobile test` and `pnpm --filter mobile typecheck`
  - root: `pnpm build` and `pnpm lint`

## PR checklist

- [ ] `pnpm build` and `pnpm lint` pass
- [ ] New/changed behavior covered by tests
- [ ] No secrets, private hosts, or local-only URLs committed
- [ ] Docs updated (`README.md` / `deploy/SETUP.md` if applicable)
- [ ] Screenshots/video for mobile UI changes

## Commit messages

Short imperative subject + body explaining why. Example:

```
feat(rooms): wake mentioned agents in order

No mention wakes only the room owner; unknown names are ignored.
```

Do not add `Co-authored-by` trailers unless the co-author agrees.

## Releasing

1. Set the new number in two places: `KURU_VERSION` in `packages/shared/src/version.ts` and `version` in the root `package.json`. A test fails when they differ or when `CHANGELOG.md` has no entry for it.
2. Add the entry at the top of `CHANGELOG.md`. Say under **To update** anything the person running a server has to do: a new setting, a new app build.
3. If the release changes or removes something an older app calls, raise `MIN_APP_VERSION`. If the app starts to need something an older server lacks, raise `MIN_SERVER_VERSION`.
4. Merge to `main`, then tag it: `git tag -a v0.3.0 -m "Kuru 0.3.0" && git push --tags`.
5. For the phone: `npx eas-cli update --channel preview --message "0.3.0"` from `apps/mobile`. If a native library was added or upgraded, raise `version` in `apps/mobile/app.json` and make a new build instead.
