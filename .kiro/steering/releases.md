# Release Process

## Overview

Releases are **automated and conventional-commit-driven** via release-please. You don't hand-pick version numbers or write release notes — the version comes from commit types since the last release, and notes come from commit subjects.

## How a release happens (the normal path)

1. **Land conventional commits on `main`.** Because we squash-merge, the *PR title* becomes the single commit subject — so the PR title is what matters. `pr-title-lint.yml` enforces the format on every PR.

2. **release-please opens/updates a "Release vX.Y.Z" PR** (`release-please.yml` runs on each push to `main`). It computes the next version from the commits, stages the `package.json` bump + a generated `CHANGELOG.md` section. This PR sits open and keeps updating itself as more commits land — it's the human-approval gate.

3. **Merge the Release PR when you want to ship.** On merge, release-please creates the `vX.Y.Z` tag + a GitHub Release (with generated notes) and sets `release_created=true`.

4. **That triggers the build** (`release-please.yml` calls the reusable `release-build.yml`): typecheck + unit tests → 5-platform binaries/tarballs → `checksums.txt` → uploads them to the Release → bumps `Formula/localpress.rb` and pushes it to both `main` and `gfargo/homebrew-tap`.

That's it — merging one PR is the whole release.

## How the version is decided (semver from commit types)

| Commit type on `main` | Bump | Example |
| --- | --- | --- |
| `fix:` | patch | 2.7.0 → 2.7.1 |
| `feat:` | minor | 2.7.0 → 2.8.0 |
| `feat!:` / `BREAKING CHANGE:` footer | major | 2.7.0 → 3.0.0 |
| `docs:` `chore:` `refactor:` `test:` `ci:` `build:` `perf:` | none on their own | — |

`perf:` shows in the changelog but doesn't force a release by itself; the type→section mapping lives in `release-please-config.json`.

## The pieces

- **`.github/workflows/release-please.yml`** — runs on push to `main`; maintains the Release PR and, on merge, tags + calls the build.
- **`.github/workflows/release-build.yml`** — reusable (`workflow_call`) build + publish + Homebrew pipeline, parameterized by tag.
- **`.github/workflows/release.yml`** — manual fallback. Push a `v*` tag by hand and it runs the same `release-build.yml`. Use only if the automated flow is wedged.
- **`.github/workflows/pr-title-lint.yml`** — conventional-commit check on PR titles.
- **`release-please-config.json`** — bump rules, changelog sections, tag format.
- **`.release-please-manifest.json`** — the current released version (`{ ".": "2.7.0" }`). Don't hand-edit.

## Invariants (don't break these)

- **Don't manually bump `package.json` or hand-write the top `CHANGELOG.md` section** — release-please owns both.
- **The tag → build link relies on staying in one workflow.** Don't "simplify" into a tag-listener; it will silently stop building.
- **`HOMEBREW_TAP_TOKEN`** (repo secret, PAT with `repo` scope on `gfargo/homebrew-tap`) must be present or the tap-push step no-ops.
- The formula commit back to `main` carries `[skip ci]` so it doesn't spin up another release-please run.

## PR title conventions

Since we squash-merge, the PR title IS the commit message that drives versioning:

```
feat: add SEO audit command
fix(mcp): close audit tool schema gap
docs: update CLAUDE.md to v2.7.0
chore: update test fixtures
```

Scopes in parentheses are optional but helpful for changelog grouping.

## Secrets Required

- `HOMEBREW_TAP_TOKEN`: GitHub PAT with `repo` scope on `gfargo/homebrew-tap`
- `VERCEL_DEPLOY_HOOK`: Vercel deploy hook URL for rebuilding localpress.griffen.codes

## Website

The marketing site at `localpress.griffen.codes` is a separate Vercel project. It auto-rebuilds on:

- Wiki page edits (via `rebuild-on-wiki.yml` → Vercel deploy hook)
- New releases (chained off `release-please.yml`)

Wiki changes don't need a release — they're live immediately on push to the wiki repo.
