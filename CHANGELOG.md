# Changelog

All notable changes to this project are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version stays `0.x`, minor bumps may carry breaking changes.

The release workflow reads the section matching the pushed tag (`v0.1.0` →
`## [0.1.0]`) and uses it verbatim as the GitHub Release notes, so keep each
entry written for someone deciding whether to upgrade.

## [Unreleased]

## [0.1.0] - 2026-08-29

First public release.

### Added
- Browser-driven TikTok collection that reads the feed responses the page's own
  JavaScript makes, rather than reimplementing request signing. Real Chrome,
  logged out, human-paced.
- Local SQLite library (`node:sqlite`) holding every post, account, run, and
  analysis. FTS5 search over everything collected.
- Run scoping: one research question per run, so unrelated niches never mix in
  an answer.
- MCP server (26 tools) and a matching CLI. The server never calls a model —
  `read_slides` hands slide images to whichever agent is driving.
- Metrics built to avoid being fooled by raw views: views-per-follower, outlier
  score (best ÷ median), a `repeatable` gate that needs 3+ hits with one inside
  90 days, save-rate calibration, and operator-cluster detection on shared
  sounds.
- `swipekit` and `swipekit-plan` skills carrying the evidence floor and
  how to read the numbers.
- Self-contained HTML report and a Notion-importable markdown + images export,
  both named after the run they cover.
- One Chrome across every session: a second process attaches to the first one's
  browser over CDP instead of fighting it for the profile lock, and opens a fresh
  one if that session has gone away. Servers exit with the client that started
  them, and concurrent writers wait on the database rather than failing.
- An optional HTTP transport for several agents sharing one warm cache. It binds
  to localhost and validates `Origin`, which is what actually keeps a web page
  out of a local server.
- Each skill is carried as an independent copy per agent: `.claude/skills/` for
  Claude Code, `.agents/skills/` for Codex (with an `agents/openai.yaml`
  declaring the MCP dependency).
- CI runs typecheck, lint, and test as separate jobs on every push and PR. A
  `v*` tag runs the gate and publishes a GitHub Release with notes from this
  file.
- `SECURITY.md`, `CODEOWNERS`, and GitHub issue and PR templates.

### Known limitations
- Analyzes slideshows only. Video is collected with full stats but not yet
  interpreted.
- TikTok only.
- The HTML report's slide thumbnails need macOS (`sips`); everything else is
  cross-platform.

[Unreleased]: https://github.com/jorge-dev/swipekit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jorge-dev/swipekit/releases/tag/v0.1.0
