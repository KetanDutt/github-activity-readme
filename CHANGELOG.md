# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-10-21

A ground-up reliability, performance, and documentation release. The runtime is
now dependency-free and the bundle is roughly 92% smaller.

### Added

- Support for **16 event types**: commits comments, branch/tag creation and
  deletion, forks, wiki updates, issue comments, issues, collaborators, public
  repositories, pull requests, PR reviews, review comments, review threads,
  pushes, releases, and stars.
- `FILTER_EVENTS: "*"` to opt into every supported event.
- Comma separated `GH_USERNAME` values (up to 10), merged and de-duplicated.
- `SHOW_TIMESTAMPS` with `date`, `datetime`, and `relative` formats.
- `SECTION_NAME` for custom markers and multiple managed sections.
- `EXCLUDE_REPOS` with `owner/repo`, `owner/*`, `*/repo`, and `?` globs.
- `DRY_RUN` plus a local `npm run preview` renderer.
- Action outputs: `changed`, `activity_count`, `target_file`, `result`, and
  `commit_sha`.
- A compact job summary with settings, results, and a preview.
- `EMPTY_COMMIT_DAYS` to make the keep-alive threshold configurable (default
  50; `0` disables it).
- A dependency-free workflow-command logger with output masks, annotations,
  groups, and summaries.
- 140 local tests using `node:test`, including end-to-end runs against a
  temporary repository and bare remote.
- Documentation for configuration, events, architecture, development,
  troubleshooting, and security.
- A project banner and this changelog.

### Fixed

- Merged pull requests were shown as "Closed PR"; `closed` + `merged: true` now
  renders **Merged PR**, and the API's `merged` action is handled too.
- `MAX_LINES` was ignored when the existing section had fewer lines. The whole
  section is now replaced, so it grows and shrinks correctly.
- A missing `END` marker caused the imported content to be treated as activity;
  it is now inserted after the generated list without deleting content below.
- Pull request actions produced `[#123](undefined)` links when `html_url` was
  absent; URLs are now constructed from the repository and PR number.
- `FILTER_EVENTS` used substring matching, so a filter could accidentally match
  a different event type. It is now an exact, case-insensitive set.
- The git error handler referenced an undefined `code` variable and could throw
  a `ReferenceError` while reporting an error.
- Commit identity was written to the global git config. It is now passed per
  command with `-c`.
- Unrelated staged files could be swept into the activity commit. Only
  `TARGET_FILE` is committed.
- Empty commits were skipped when the README was unchanged but the repository
  had been idle. They are now evaluated independently of the diff.
- The `EMPTY_COMMIT_MSG` default said 60 days while the code used 50; the
  message and documentation now agree.
- Section markers inside fenced code blocks were treated as real markers.
- CRLF line endings, UTF-8 BOMs, trailing newlines, and formatter-added blank
  lines caused churn or corruption. All are preserved now.
- Release names, labels, branch names, and other event text could inject
  markdown or HTML into the README. All untrusted values are escaped.
- Relative timestamps and unstable event ordering could cause unnecessary
  commits. Ordering is deterministic and relative timestamps are opt-in.

### Changed

- The action now declares the **`node24`** runtime, matching the removal of
  Node 20 from GitHub Actions runners.
- Replaced `@actions/github` (Octokit) and `@actions/core` with a focused
  `fetch` client and a small workflow-command logger. The bundle dropped from
  ~1.2 MB to ~97 KB and production dependencies dropped to **zero**.
- Push failures caused by concurrent runs are retried after
  `git pull --rebase --autostash` (up to three attempts).
- HTTP requests retry with exponential backoff, honor `Retry-After` and
  `X-RateLimit-Reset`, and fail fast when the reset is far away.
- Repository activity is fetched in parallel for multi-user feeds.
- `actions/checkout@v5` is used in examples, consistent with the Node 24
  transition.

### Security

- `TARGET_FILE` must resolve inside the workspace, including after symlink
  resolution.
- Git commands are shell-free and use `--` before paths.
- Tokens are masked and redacted from errors and command logs.
- Plain log lines starting with `::` are neutralized to prevent workflow
  command injection.
- The committed `dist/` bundle is generated from reviewed source.

## [0.5.0] - Previous release

Baseline release with `IssueCommentEvent`, `IssuesEvent`,
`PullRequestEvent`, and `ReleaseEvent`, a 5-line default, a 50-day empty commit,
and configurable commit identity/messages.

[0.6.0]: https://github.com/KetanDutt/github-activity-readme/compare/0.5.0...0.6.0
[0.5.0]: https://github.com/KetanDutt/github-activity-readme/releases/tag/0.5.0
