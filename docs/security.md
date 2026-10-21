# Security

## Supported versions

Security fixes are applied to the latest `master`/release. The action is
versioned with semver; pin a tag or commit SHA if you need reproducibility.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

- Open a private [GitHub security advisory](https://github.com/KetanDutt/github-activity-readme/security/advisories/new), or
- Email `ketan6196@gmail.com`.

Include the affected version/commit, a description, and a minimal reproduction.
You can expect an acknowledgement within a few days. Please give us a reasonable
window to ship a fix before public disclosure.

## What the action can access

| Resource                   | Why                                                         |
| -------------------------- | ----------------------------------------------------------- |
| Public events REST API     | Render the activity feed.                                   |
| The checked-out repository | Read/write `TARGET_FILE`, create a commit, push the branch. |
| `GITHUB_TOKEN`             | API requests and git push (via checkout credentials).       |

It does **not**:

- Read repository secrets.
- Send data to third-party services.
- Install packages at runtime.
- Execute shell commands built from event data.

## Recommended workflow permissions

Use the minimum permissions the job needs:

```yaml
permissions:
  contents: write
```

`actions/checkout` persists credentials locally by default so the action can
push. If you disable that, provide your own credentials.

## Token handling

- The token is read from the `GITHUB_TOKEN`/`GH_TOKEN` environment variable or
  the optional `GITHUB_TOKEN` input.
- It is registered with `::add-mask::` immediately.
- It is redacted from error messages and git command logs.
- `Authorization` headers are never logged.
- The action does not write the token to disk.

## Untrusted content

Event payloads can contain arbitrary text: release names, labels, branch names,
collaborator logins, and repository names. The action treats all of it as
untrusted:

- Markdown special characters and HTML are escaped before interpolation.
- Inline code values have backticks removed.
- Display values are truncated (repository/release names, labels, etc.).
- Lines are collapsed to a single line and capped at 400 characters.
- Plain log lines beginning with `::` are prefixed with a space, preventing
  workflow-command injection through the runner's stdout parser.
- Workflow command messages are escaped (`%`, CR, LF).

## Path safety

`TARGET_FILE` is resolved against `GITHUB_WORKSPACE` and rejected if it escapes
the workspace, including through a symlink. Absolute paths are rejected. Git
commands receive the path after `--` so a filename starting with `-` cannot be
interpreted as an option.

## Command execution

Git is invoked with `spawn` and an argument array. There is no shell, so event
data cannot be interpolated into a command line. The only values passed to git
are:

- The validated target path.
- The user-supplied commit name/email/message.
- The current branch name (from `git symbolic-ref`).
- Fixed flags.

## Fork and pull-request safety

Do not run this action with a write token on untrusted `pull_request` workflows.
A `pull_request` checkout is detached, so the action will refuse to push, but
the safer pattern is to run it only on `schedule` or `workflow_dispatch` on a
trusted branch.

## Dependencies

- Zero runtime dependencies.
- Two development dependencies: `@vercel/ncc` (bundler) and `prettier`
  (formatting).
- `npm audit` is clean. Run `npm audit` before releases.
- `package-lock.json` is committed for reproducible installs.
- The committed `dist/index.js` is generated from reviewed source by ncc.

## Supply chain

- Pin third-party actions (including `actions/checkout`) to a commit SHA in
  highly sensitive repositories.
- Review changes to `dist/index.js` together with `src/`; a build artifact is
  code.
- Prefer the `master` branch only if you trust the maintainers to review every
  change, or pin a release tag/SHA.

## Denial of service

The action caps:

- `MAX_LINES` at 100.
- Git output capture at 512 KB (tail).
- API retries at three.
- Rate-limit waits at 30 seconds.

These limits keep a single workflow run bounded even if the API or repository
misbehaves.
