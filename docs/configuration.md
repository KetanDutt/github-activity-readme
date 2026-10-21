# Configuration

All inputs are optional except `GH_USERNAME` (which defaults to the repository
owner) and the token (which defaults to the `GITHUB_TOKEN` environment
variable). Inputs are read through the standard GitHub Actions `INPUT_*`
environment variables, so they can also be supplied manually for local runs.

## Inputs

| Input               | Default                                                       | Description                                                                                    |
| ------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GH_USERNAME`       | `${{ github.repository_owner }}`                              | One username, or a comma separated list of up to 10 usernames. Duplicates are ignored.         |
| `COMMIT_NAME`       | `github-actions[bot]`                                         | Git author and committer name.                                                                 |
| `COMMIT_EMAIL`      | `41898282+github-actions[bot]@users.noreply.github.com`       | Git author and committer email.                                                                |
| `COMMIT_MSG`        | `:zap: Update README with the recent activity`                | Commit message used when the section changes.                                                  |
| `EMPTY_COMMIT_MSG`  | `:memo: Empty commit to keep the scheduled workflow active`   | Commit message for the periodic empty commit.                                                  |
| `MAX_LINES`         | `5`                                                           | Number of activity lines to render. Must be an integer from 1 to 100.                          |
| `TARGET_FILE`       | `README.md`                                                   | Repository-relative path of the file to manage. Must exist and stay inside the workspace.      |
| `SECTION_NAME`      | `activity`                                                    | Name used in the `START_SECTION` / `END_SECTION` markers. Letters, numbers, `-`, and `_` only. |
| `FILTER_EVENTS`     | `IssueCommentEvent,IssuesEvent,PullRequestEvent,ReleaseEvent` | Comma separated event types, or `*` for every supported type. Unknown types produce a warning. |
| `EXCLUDE_REPOS`     | _(empty)_                                                     | Comma separated repository globs to hide, for example `owner/*`, `*/repo`, or `owner/repo`.    |
| `SHOW_TIMESTAMPS`   | `false`                                                       | Append a `<sub>` timestamp to every line.                                                      |
| `TIMESTAMP_FORMAT`  | `date`                                                        | `date` (`2026-10-21`), `datetime` (`2026-10-21 12:30 UTC`), or `relative` (`2 hours ago`).     |
| `EMPTY_COMMIT_DAYS` | `50`                                                          | Create an empty commit after this many days without commits. Set `0` to disable.               |
| `DRY_RUN`           | `false`                                                       | Render the section and write a job summary without changing files or git history.              |
| `GITHUB_TOKEN`      | `GITHUB_TOKEN` / `GH_TOKEN` environment variable              | Token used to read public events. Use the input only if you cannot pass `env`.                 |

### Validation

The action validates everything before making a network request:

- `MAX_LINES` must be an integer between 1 and 100.
- `TARGET_FILE` must be a relative path that resolves inside the workspace.
  Symlinks pointing outside the repository are rejected.
- `SECTION_NAME` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$`.
- `TIMESTAMP_FORMAT` must be `date`, `datetime`, or `relative`.
- `EMPTY_COMMIT_DAYS` must be an integer between 0 and 3650.
- `FILTER_EVENTS` must contain at least one supported event type.
- `COMMIT_EMAIL` must contain `@`.
- `GITHUB_API_URL` and `GITHUB_SERVER_URL` must be valid `http(s)` URLs.

Configuration errors are reported as a single actionable error message, with a
hint where possible. Nothing is written or committed when validation fails.

## Outputs

| Output           | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| `changed`        | `true` when the target file was updated, otherwise `false`. |
| `activity_count` | Number of activity lines rendered.                          |
| `target_file`    | Repository-relative file that was managed.                  |
| `result`         | `updated`, `unchanged`, `empty-commit`, or `dry-run`.       |
| `commit_sha`     | SHA of the pushed commit, when a commit was created.        |

Example:

```yaml
- uses: KetanDutt/github-activity-readme@master
  id: activity
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
- run: echo "Changed: ${{ steps.activity.outputs.changed }}"
```

## Permissions and token

The workflow needs `contents: write` to push the update:

```yaml
permissions:
  contents: write
```

`actions/checkout` persists the workflow token in the local git configuration by
default, which is what the action uses to push. If you set
`persist-credentials: false`, you must configure credentials yourself.

The token is passed to the GitHub REST API as a bearer token and is registered
with `::add-mask::` so it cannot appear in logs. The action never prints it.

For private repositories, the workflow token can read the repository's own
events. **Other users' private events are never exposed by the GitHub API**, so
the feed is limited to public activity.

## Multiple users

`GH_USERNAME` accepts a comma separated list:

```yaml
with:
  GH_USERNAME: "octocat,hubot"
  MAX_LINES: 10
```

Each user is fetched in parallel. Events are merged, de-duplicated by event id,
sorted newest first, and trimmed to `MAX_LINES`. The section does not add
username prefixes because every line already includes the repository name.

## Custom sections and files

The markers are derived from `SECTION_NAME`:

```md
<!--START_SECTION:activity-->
<!--END_SECTION:activity-->

<!--START_SECTION:speaking-->
<!--END_SECTION:speaking-->
```

Use two steps with different `SECTION_NAME` values to manage two sections in the
same file:

```yaml
- uses: KetanDutt/github-activity-readme@master
  with:
    SECTION_NAME: activity
    TARGET_FILE: README.md
- uses: KetanDutt/github-activity-readme@master
  with:
    SECTION_NAME: speaking
    TARGET_FILE: docs/speaking.md
```

Notes:

- If the `END` marker is missing, it is inserted immediately after the generated
  list. Existing content below the section is preserved.
- Duplicate markers or an `END` marker before its `START` marker are rejected
  with an actionable error.
- Markers inside fenced code blocks are ignored, so documentation examples do
  not accidentally become the managed section.
- CRLF line endings, a UTF-8 BOM, trailing newlines, and blank lines directly
  inside the section are preserved.

## Filtering repositories

`EXCLUDE_REPOS` hides noisy repositories without changing the event filter:

```yaml
with:
  EXCLUDE_REPOS: "some-org/ci-notes,*/dotfiles,octocat/*"
```

Patterns are matched case-insensitively against `owner/repo`. `*` matches any
number of characters; `?` matches one character. An entry without `/` is
ignored with a warning.

## GitHub Enterprise Server

The action reads the standard runner environment variables:

- `GITHUB_API_URL` (for example `https://github.example.com/api/v3`)
- `GITHUB_SERVER_URL` (for example `https://github.example.com`)

Links in the generated section are built from `GITHUB_SERVER_URL`. The REST
client uses `GITHUB_API_URL`. No extra configuration is required on GHES, but
the token must be able to read the public events endpoint.

For self-hosted runners behind an HTTP proxy, set `NODE_USE_ENV_PROXY=1` (Node 24) or configure the runner's proxy settings. The action uses the runtime's
built-in `fetch`.

## Concurrency

Scheduled runs can overlap. The action:

1. Commits only the target file.
2. Pushes to the branch that is checked out.
3. If the push is rejected as non-fast-forward, rebases with `--autostash` and
   retries up to three times.

Adding a workflow concurrency group is still recommended for busy
repositories:

```yaml
concurrency:
  group: readme-activity
  cancel-in-progress: false
```

## Empty commits

GitHub disables scheduled workflows in repositories that have had no activity
for 60 days. When there is nothing to update, the action can create an empty
commit after `EMPTY_COMMIT_DAYS` (default `50`) so the schedule stays active.
Set it to `0` to opt out:

```yaml
with:
  EMPTY_COMMIT_DAYS: 0
```

If the branch is protected against pushes from the Actions bot, the empty
commit will fail. In that case either allow the bot to push or set
`EMPTY_COMMIT_DAYS: 0` and accept that GitHub may disable the schedule after
60 days of inactivity.

## Dry runs and previews

Set `DRY_RUN: true` to render the section in the job summary and logs without
writing files or creating commits. For a fully local preview that never needs a
workflow, see [Local preview](../README.md#local-preview).
