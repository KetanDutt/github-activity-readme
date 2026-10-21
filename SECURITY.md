# Security Policy

## Supported versions

Security fixes land on the latest release and on `master`. Pin a tag or commit
SHA if you need a frozen version.

## Reporting a vulnerability

Please do **not** open a public issue.

- Preferred: open a private [GitHub security advisory](https://github.com/KetanDutt/github-activity-readme/security/advisories/new).
- Alternative: email `ketan6196@gmail.com` with the affected version, a
  description, and a minimal reproduction.

Please allow a reasonable window to ship a fix before public disclosure.

## Scope

The action reads public GitHub events, edits one file in the checkout, and
pushes a commit with the workflow token. It has no runtime dependencies and
does not send data to third parties.

The full threat model, token handling, escaping strategy, and path-safety rules
are documented in [docs/security.md](docs/security.md).
