# Development

## Prerequisites

- Node.js **20 or newer** (24 recommended; this is the action runtime).
- Git.
- No global packages are required.

## Setup

```bash
git clone https://github.com/KetanDutt/github-activity-readme.git
cd github-activity-readme
npm ci
```

## Scripts

| Command                | What it does                                                |
| ---------------------- | ----------------------------------------------------------- |
| `npm test`             | Run the full Node.js test suite (140 tests).                |
| `npm run format`       | Format JavaScript, JSON, Markdown, and YAML with Prettier.  |
| `npm run format:check` | Verify formatting without writing.                          |
| `npm run build`        | Bundle `index.js` and `src/` into `dist/index.js` with ncc. |
| `npm run preview`      | Render a section locally without writing or committing.     |
| `npm run verify`       | Format check, tests, and a production build.                |

## Project layout

```text
.
├── action.yml              # Action metadata (inputs, outputs, node24 runtime)
├── index.js                # Runner entrypoint
├── src/
│   ├── action.js           # Orchestration
│   ├── config.js           # Input validation
│   ├── events.js           # Event serializers and filters
│   ├── git.js              # Git commands and push retry
│   ├── github.js           # REST client
│   ├── logger.js           # Workflow commands, outputs, summary
│   ├── section.js          # Marker/section replacement
│   ├── errors.js           # Typed errors
│   └── utils.js            # Formatting helpers
├── test/                   # node:test suites and helpers
├── scripts/
│   ├── preview.js          # Local dry-run renderer
│   └── run-tests.js        # Cross-platform test runner
├── docs/                   # Documentation
└── dist/index.js           # Built bundle (committed)
```

## Tests

The suite uses the built-in `node:test` runner. It covers:

- Input validation and path containment.
- All 16 event serializers and markdown escaping.
- Section replacement, MAX_LINES growth/shrink, CRLF/BOM, code fences, and
  marker errors.
- HTTP retries, rate limits, pagination, multi-user merge, and de-duplication.
- Git commits (including "only the target file"), empty commits, push retries,
  and secret redaction.
- End-to-end action runs in a temporary git repository with a fake API and a
  bare remote.
- Workflow command escaping, outputs, and job summaries.

```bash
npm test
```

There is intentionally **no CI**. See the
[no-CI policy](../CONTRIBUTING.md#no-ci-policy). Maintainers run
`npm run verify` locally before merging and commit the rebuilt `dist/`.

## Local preview

`npm run preview` needs a markdown file with a START marker and a GitHub
token. The token is used for API requests only; without one, GitHub's
unauthenticated limit (60 requests/hour) applies.

```bash
export GITHUB_TOKEN=ghp_...
npm run preview -- --username octocat
npm run preview -- --username octocat --max-lines 10 --show-timestamps
npm run preview -- --username octocat --filter "*"
npm run preview -- --username octocat,hubot --file docs/README.md
```

The preview forces `DRY_RUN`, prints the generated section, and never writes a
file or runs git.

You can also run the bundled action directly with inputs in the environment:

```bash
GITHUB_WORKSPACE="$PWD" \
INPUT_GH_USERNAME=octocat \
INPUT_TARGET_FILE=README.md \
INPUT_DRY_RUN=true \
GITHUB_TOKEN=ghp_... \
node dist/index.js
```

## Building

`dist/index.js` is committed because JavaScript actions run without an
`npm install` step. **Never edit `dist/` by hand.**

```bash
npm run build
git add dist/index.js
```

ncc bundles all local modules; there are no runtime dependencies to install on
the runner. The bundle is roughly 97 KB.

## Releasing

1. Update the version in `package.json` and `package-lock.json`
   (`npm version <major|minor|patch> --no-git-tag-version`).
2. Move the changelog entries from **Unreleased** to the new version.
3. Run `npm run verify`.
4. Commit `dist/index.js` together with the source changes.
5. Create a tag and a GitHub release.
6. Optionally move a floating major tag (for example `v0`) to the new commit.

Consumers can pin `@master`, a semver tag, or a full commit SHA. Pinning to a SHA
is recommended for maximum supply-chain safety.

## Debugging

- Set the repository secret `ACTIONS_STEP_DEBUG` to `true` to see
  `core.debug` output in Actions.
- Locally, set `RUNNER_DEBUG=1` to print debug lines.
- `DRY_RUN: true` logs the generated section without touching git.
- Git commands are logged with secrets redacted when debug mode is enabled.

## Adding an event type

See [Architecture § Extending the event list](architecture.md#extending-the-event-list).
In short:

1. Add a serializer in `src/events.js` and register it.
2. Add tests, docs, and a README row.
3. `npm run verify`.
4. Commit the rebuilt `dist/`.
