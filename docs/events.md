# Supported events

The action renders 16 event types. The default filter deliberately includes
only the four "high signal" types, because a profile README with 5 lines can
otherwise be dominated by pushes and stars.

Set `FILTER_EVENTS: "*"` to show every supported type, or provide a comma
separated list:

```yaml
with:
  FILTER_EVENTS: "PullRequestEvent,PullRequestReviewEvent,ReleaseEvent"
```

## Default filter

`IssueCommentEvent,IssuesEvent,PullRequestEvent,ReleaseEvent`

Unknown event names are ignored with a warning in the workflow log. Matching is
case-insensitive, and whitespace around commas is ignored.

## Supported events

| Event                           | Default | Example output                                                 |
| ------------------------------- | :-----: | -------------------------------------------------------------- |
| `CommitCommentEvent`            |    —    | `💬 Commented on commit a1b2c3d in octocat/hello-world`        |
| `CreateEvent`                   |    —    | `🌱 Created branch feature/login in octocat/hello-world`       |
| `DeleteEvent`                   |    —    | `🗑️ Deleted branch old-branch in octocat/hello-world`          |
| `ForkEvent`                     |    —    | `🍴 Forked octocat/hello-world to someone/hello-world`         |
| `GollumEvent`                   |    —    | `📝 Updated the wiki in octocat/hello-world`                   |
| `IssueCommentEvent`             |   ✅    | `🗣 Commented on issue #12 in octocat/hello-world`             |
| `IssuesEvent`                   |   ✅    | `❗ Opened issue #13 in octocat/hello-world`                   |
| `MemberEvent`                   |    —    | `👥 Added @hubot as a collaborator in octocat/hello-world`     |
| `PublicEvent`                   |    —    | `📣 Made octocat/hello-world public`                           |
| `PullRequestEvent`              |   ✅    | `🎉 Merged PR #42 in octocat/hello-world`                      |
| `PullRequestReviewCommentEvent` |    —    | `💬 Commented on a review of PR #42 in octocat/hello-world`    |
| `PullRequestReviewEvent`        |    —    | `✅ Approved PR #42 in octocat/hello-world`                    |
| `PullRequestReviewThreadEvent`  |    —    | `🧵 Resolved a review thread on PR #42 in octocat/hello-world` |
| `PushEvent`                     |    —    | `⬆️ Pushed commit a1b2c3d to octocat/hello-world`              |
| `ReleaseEvent`                  |   ✅    | `🚀 Published release v1.2.0 in octocat/hello-world`           |
| `WatchEvent`                    |    —    | `⭐ Starred octocat/hello-world`                               |

## Action-level details

### Issues

`opened`, `closed`, `reopened`, `labeled`, `unlabeled`, `assigned`,
`unassigned`, `edited`, `pinned`, `unpinned`, `transferred`, `milestoned`,
`demilestoned`, `locked`, `unlocked`, and `deleted` all have specific verb
phrases. Closed issues that are marked "not planned" use a distinct line.
Labels, assignees, and milestones are included when the payload provides them.

### Pull requests

- `closed` with `merged: true` renders **Merged PR** with 🎉. A plain close
  renders **Closed PR** with ❌.
- `opened`, `reopened`, `ready_for_review`, `converted_to_draft`,
  `review_requested`, `review_request_removed`, `synchronize`, auto-merge
  changes, labels, assignees, and edits are all handled.
- The REST Events API does not always include `html_url` on `pull_request`.
  The action constructs a canonical URL from the repository and PR number, so
  no `undefined` links are produced.

### Reviews

`PullRequestReviewEvent` shows approved, changes requested, dismissed, and
commented reviews with distinct emoji. Review comments and resolved threads
link to the discussion when GitHub provides a URL, and to the pull request
otherwise.

### Releases

Published and pre-released releases use the release name, falling back to the
tag name. Names are truncated to 60 characters and markdown-escaped, so a
release called `v1 & <script>` cannot inject HTML into your README.

### Pushes, branches, and tags

Single-commit pushes link directly to the commit. Multi-commit pushes link to
the comparison URL when available. Branch and tag names are URL-encoded per
path segment, so `feature/my branch` becomes `feature/my%20branch` without
breaking the link.

### Stars, forks, wikis, and collaborators

These are supported for users who opt into `FILTER_EVENTS: "*"`. `WatchEvent`
(stars) is intentionally excluded by default because it is noisy.

## Timestamps

Enable rendered dates with:

```yaml
with:
  SHOW_TIMESTAMPS: true
  TIMESTAMP_FORMAT: date
```

| Format     | Example                |
| ---------- | ---------------------- |
| `date`     | `2026-10-21`           |
| `datetime` | `2026-10-21 12:30 UTC` |
| `relative` | `2 hours ago`          |

Timestamps are appended as muted `<sub>` text:

```md
1. 🎉 Merged PR [#42](...) in [octocat/hello-world](...) · <sub>2026-10-21</sub>
```

`relative` timestamps change over time, so they can create a new commit on
every run. Prefer `date` for scheduled workflows unless you want that churn.

## Event API limits

- Only **public** events are available for arbitrary users.
- The events APIs return at most **300 events** from the last **90 days**
  (three pages of 100). The action fetches up to three pages per user.
- Some events are coalesced or omitted by GitHub (for example, rapid pushes may
  appear as one event).
- The newest events are returned first. The action sorts merged multi-user
  feeds by `created_at` descending and breaks ties by event id so the output is
  stable between runs.

## Formatting rules

Every generated line is:

- One line, with whitespace collapsed.
- Optionally numbered (`1.`, `2.`, ...).
- Truncated to at most 400 characters.
- Escaped so user-controlled text (release names, labels, branch names) cannot
  introduce HTML, markdown links, or workflow commands.
- Limited to `MAX_LINES` entries after filtering.

If an event is malformed or a formatter cannot build a meaningful line, the
event is skipped instead of rendering `undefined`.
