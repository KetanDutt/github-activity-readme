# Troubleshooting

## First things to check

1. The file contains a START **and** an END marker (END is optional, but
   recommended):

   ```md
   <!--START_SECTION:activity-->
   <!--END_SECTION:activity-->
   ```

2. The workflow declares `permissions: contents: write`.
3. `actions/checkout` runs before the action and checks out the branch you want
   to push to.
4. `GH_USERNAME` is correct and has public activity in the last 90 days.
5. The token is passed as `GITHUB_TOKEN` (env) or `GITHUB_TOKEN` (input).

Run the action with `DRY_RUN: true` to see exactly what it would write.

## "Couldn't find the section markers"

The action looked for:

```md
<!--START_SECTION:activity-->
```

with the section name from `SECTION_NAME`. Common causes:

- The marker is inside a fenced code block. Markers in ` ``` ` or `~~~`
  blocks are deliberately ignored, so documentation examples are safe.
- The section name is different. Check for typos; marker matching is
  case-insensitive but the name must match.
- `TARGET_FILE` points at a different file than the one you edited.
- The marker has extra text on the same line. Markers must be on their own
  line (leading/trailing whitespace is allowed).

## Duplicate or reversed markers

```text
Found 2 START markers for section "activity" (lines 10, 42).
```

Keep exactly one START/END pair per `SECTION_NAME`. If you need two activity
lists, use two steps with different `SECTION_NAME` values and different
`TARGET_FILE` values.

```text
The END marker for section "activity" appears before its START marker.
```

Move `<!--END_SECTION:activity-->` below the generated list.

## The README is not updated

- **No matching events.** The default filter only shows issues, issue comments,
  pull requests, and releases. Try `FILTER_EVENTS: "*"` temporarily.
- **The event is older than 90 days.** The GitHub Events API only returns the
  last 90 days, up to 300 events.
- **The activity is private.** Only public events are available for arbitrary
  users; the workflow token cannot reveal another user's private events.
- **The repository is excluded.** Check `EXCLUDE_REPOS`.
- **The section is already up to date.** The action logs "The activity section
  is already up to date." and exits successfully without a commit.
- **The event is not in the supported list.** See [Events](events.md). Unknown
  `FILTER_EVENTS` entries produce a warning in the log.
- **The formatter returned `null`.** Malformed events are skipped rather than
  rendering `undefined`.

## MAX_LINES is not respected

This was fixed in 0.6.0. Older versions only overwrote existing lines, so a
section with two entries never grew to five. Update to the latest version. The
current implementation replaces the whole section body, so it grows **and**
shrinks correctly.

Remember that `MAX_LINES` is applied after filtering and de-duplication.

## `undefined` links in the feed

Older releases produced `[#123](undefined)` for some pull request actions
because the Events API omits `html_url` on `pull_request`. 0.6.0 constructs the
canonical `/pull/<number>` URL and falls back to the repository URL. If you
still see this, you are running an old tag or a stale fork. Pin to `@master` or
to the commit you reviewed.

## Push fails

### `Permission denied` / `could not read Username`

- Add `permissions: contents: write` to the workflow or job.
- Keep `persist-credentials: true` (the default) on `actions/checkout`.
- Organization policy may block the token from pushing; check repository
  settings and branch protection.

### `protected branch` / `GH006`

The Actions bot cannot push to a protected branch. Either allow the GitHub
Actions app to bypass the rule, push to an unprotected branch, or use a
personal access token with permission to bypass protection.

### Detached HEAD

Pull request checkouts are detached (a merge commit), so there is no branch to
push to. Schedule the action on a branch instead of running it on
`pull_request`.

### Non-fast-forward

The action rebases with `--autostash` and retries up to three times. If the
rebase conflicts, the action fails with a hint. Re-run the workflow after the
conflicting change lands.

### Git hooks

A `pre-commit`/`commit-msg` hook can reject automated commits. Either fix the
hook or disable it for the bot. The action restores the original file when the
commit cannot be created.

## Rate limits

GitHub returns 403/429 when the token hits its limit:

- `GITHUB_TOKEN` normally allows 5,000 requests per hour per repository.
- Each run uses at most three requests per username (one page is usually
  enough).
- If the reset is within 30 seconds, the action waits and retries. Otherwise it
  fails with the reset time so the runner is not blocked.
- Multiple usernames multiply the request count. Keep the list short for
  frequent schedules.

## The scheduled workflow was disabled

GitHub disables scheduled workflows after 60 days without repository activity.
The default `EMPTY_COMMIT_DAYS: 50` prevents that by creating an empty commit
when the README has not changed for 50 days. If the branch is protected, the
empty commit fails; set `EMPTY_COMMIT_DAYS: 0` to opt out and re-enable the
workflow manually when needed.

## Self-hosted runner says the action runtime is unsupported

The action declares `using: node24`, matching GitHub's removal of Node 20 from
Actions runners. Self-hosted runners must be new enough to provide the Node 24
action runtime (runner v2.327 or newer). Update the runner, or use a workflow
that runs the action from a source checkout on a supported runtime.

## GitHub Enterprise Server

- `GITHUB_API_URL` must include the API path, for example
  `https://github.example.com/api/v3`.
- `GITHUB_SERVER_URL` controls web links in the generated markdown.
- Old GHES versions may not support `X-GitHub-Api-Version`; it is sent as a
  compatibility header and normally ignored by versions that do not know it.
- If the instance uses a self-signed certificate, configure the runner's
  `NODE_EXTRA_CA_CERTS`.

## Proxy or network failures

The action uses Node's built-in `fetch`. On Node 24, set
`NODE_USE_ENV_PROXY=1` to honor `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`.
Self-hosted runners can also set these on the runner service.

## Timestamps create a commit on every run

`TIMESTAMP_FORMAT: relative` changes as time passes. Use `date` (or turn
timestamps off) if you want the section to remain stable between runs.

## CRLF, BOM, and formatter churn

The action preserves the file's dominant line ending, a UTF-8 BOM, a missing
trailing newline, and one blank line directly inside the section. If a
formatter rewrites the whole file, run the action after formatting or configure
the formatter to leave the generated section alone.

## Still stuck?

Open an issue with:

- The action version/commit you use.
- The relevant workflow file.
- The step log with secrets removed.
- A minimal example of the target file and the expected output.

See [Contributing](../CONTRIBUTING.md) for the issue guidelines.
