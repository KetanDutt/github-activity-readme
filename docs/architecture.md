# Architecture

The action is a small, dependency-free Node.js program. It is bundled into a
single file (`dist/index.js`) with `@vercel/ncc` so the runner does not need
`npm install` at execution time.

## Data flow

```text
GitHub Actions runner
        │
        ▼
 index.js ──► src/action.js ──► src/config.js
                    │                │
                    │                ├── validate inputs
                    │                └── resolve TARGET_FILE
                    │
                    ├──► src/github.js ──► REST /users/{user}/events/public
                    │        │                (paginated, retried)
                    │        └──► src/events.js (filter + format)
                    │
                    ├──► src/section.js (replace markers safely)
                    │
                    ├──► src/git.js (add, commit, push, rebase retry)
                    │
                    └──► src/logger.js (logs, annotations, outputs, summary)
```

## Modules

| Module               | Responsibility                                                                        |
| -------------------- | ------------------------------------------------------------------------------------- |
| `index.js`           | Process entrypoint. Delegates to `runAction` and turns errors into a failed step.     |
| `src/action.js`      | Orchestration: read file, fetch, format, replace, commit/push, outputs, job summary.  |
| `src/config.js`      | Input parsing, defaults, validation, target-file containment, URLs, usernames.        |
| `src/github.js`      | `fetch` client: auth headers, timeouts, retries, rate limits, pagination, multi-user. |
| `src/events.js`      | 16 event serializers, event filter, repository globs, sorting helpers.                |
| `src/section.js`     | Marker parsing (code-fence aware), section replacement, line-ending/BOM preservation. |
| `src/git.js`         | Shell-free git commands, identity, target-only commits, push with rebase retry.       |
| `src/logger.js`      | Workflow commands, outputs, masks, job summary — a tiny `@actions/core` replacement.  |
| `src/errors.js`      | Typed errors with actionable hints (`ConfigError`, `SectionError`, `GitError`, ...).  |
| `src/utils.js`       | Escaping, truncation, timestamps, parsing, redaction, sorting, sleep.                 |
| `scripts/preview.js` | Local dry-run renderer with a console logger.                                         |

## Why no runtime dependencies?

The previous implementation used `@actions/github` (Octokit) and
`@actions/core`. That produced a 1.2 MB bundle and pulled in `undici`, which
had to be kept patched. The action only performs one REST `GET`, so a small
`fetch` client plus a tiny workflow-command logger removes the entire runtime
dependency tree:

- Bundle: **~1.2 MB → ~97 KB**.
- Cold start: less JavaScript to parse and evaluate.
- Supply chain: zero production dependencies (`npm audit` clean).
- Behaviour: identical headers, pagination, retries, and logging semantics.

Node 24 is the action runtime; the code also runs on Node 20+ for local
development.

## Failure handling

- **Validation** happens before any network call. Bad configuration never
  writes a file or creates a commit.
- **Network** errors are retried three times with exponential backoff
  (1s, 2s, 4s, capped at 8s). `Retry-After` and `X-RateLimit-Reset` are honored
  when the wait is at most 30 seconds; otherwise the action fails with the
  reset time instead of blocking a runner.
- **Markers** are validated before fetching. Duplicate markers, reversed
  markers, and missing START markers are rejected with line numbers.
- **File writes** calculate the complete next file in memory first. If git
  cannot create the commit (for example a pre-commit hook fails), the original
  file is restored.
- **Pushes** retry after a non-fast-forward rejection by rebasing with
  `--autostash`. Authentication and branch-protection failures are not retried
  and include a targeted hint.
- **Empty commits** are only attempted when the last commit is at least
  `EMPTY_COMMIT_DAYS` old, and are skipped entirely in detached HEAD state.

## Section replacement algorithm

1. Read the file as UTF-8 and record BOM, dominant line ending, and trailing
   newline.
2. Split into lines and scan for markers, toggling a fenced-code-block state so
   examples inside ` ``` ` blocks are ignored.
3. Validate exactly one START and at most one END marker.
4. Preserve a single blank line immediately inside the section (this prevents
   churn with markdown formatters).
5. Replace only the lines between the markers; if END is missing, insert it
   after the generated list and leave the rest of the file untouched.
6. Re-serialize with the original BOM/EOL/trailing-newline settings.
7. Write only when the resulting text differs from the original.

This is what fixes the historical "MAX_LINES is not respected when the section
already has fewer lines" bug: the whole section body is replaced, so it can grow
and shrink.

## Security boundaries

- Event text is untrusted. Release names, labels, branch names, collaborator
  logins, and repository names are escaped before entering markdown.
- Plain log lines beginning with `::` are prefixed with a space so they cannot
  inject workflow commands.
- The token is masked and redacted from errors.
- `TARGET_FILE` must resolve inside the workspace, including after symlink
  resolution.
- Git commands use `spawn` with an argument array (no shell), and pathspecs are
  separated with `--`.

See [Security](security.md) for the full threat model.

## Extending the event list

1. Add a serializer in `src/events.js` and register it in `eventFormatters`.
2. Return a string, or `null` for malformed payloads.
3. Add a test in `test/events.test.js`.
4. Add a row to [Events](events.md#supported-events) and the README table.
5. Run `npm test`, `npm run format`, and `npm run build`.

The supported event list is derived from `Object.keys(eventFormatters)`, so a
registered serializer automatically becomes available to `FILTER_EVENTS` and to
the warning that lists valid types.
