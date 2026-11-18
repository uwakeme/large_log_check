# Project Rules (Always Applied)

From `AGENTS.md` → "PR & commit conventions" (the original `.cursor/rules/custom-rule.mdc` was removed in commit `f737072`; the rules now live there). These are project-wide, always-on rules — they apply to every code change, not just Cursor sessions.

## Rule 1 — Update `README.md` and `CHANGELOG.md` immediately

When you add or modify a user-facing feature, update both files **in the same commit**, not later.

- `README.md` is the user manual — features get a section under "## 使用方法" or a new top-level feature block.
- `CHANGELOG.md` follows Keep-a-Changelog format — feature entries go under the current unreleased section.

## Rule 2 — Unreleased changes live at the top

`CHANGELOG.md` keeps `## [Unreleased]` as the first section. When a release ships, the `[Unreleased]` block moves down under a dated version header (`## [1.2.8] - 2026-06-XX`) and a fresh empty `[Unreleased]` block goes back to the top.

## Rule 3 — One entry per feature per version

Do NOT list the same feature in multiple bullets under the same version. If a feature is delivered together with related sub-changes, write ONE bullet that names the feature and lists the sub-changes inline.

## Rule 4 — The GitHub Release is produced by CI, not by hand

Pushing a `v*` tag runs `.github/workflows/release.yml`, which verifies the tag version against `package.json`, packages the `.vsix`, and creates the Release (title = tag, notes = that version's CHANGELOG section, `.vsix` attached). Do not create releases manually and do not edit release copy in the workflow without checking the existing published releases first (`https://api.github.com/repos/uwakeme/large_log_check/releases/tags/<tag>`).

`npm run publish` (Marketplace) stays a manual, user-approved step — never run it from an agent or a script.

## How to verify

Before opening a PR / committing a feature:

1. `git diff --stat` — confirm `README.md` and `CHANGELOG.md` are in the changeset (if the work was user-facing).
2. `cat CHANGELOG.md` — confirm the new entry is under `## [Unreleased]`, not in a released version.
3. `grep` for the feature name in the unreleased section — confirm it appears exactly once.
