"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_FILTER_EVENTS,
  SUPPORTED_EVENT_TYPES,
  formatEvent,
  formatActivityLines,
  resolveEventFilter,
  compileRepoPatterns,
  isRepoExcluded,
  selectEvents,
  encodeRefPath,
} = require("../src/events");

const NOW = new Date("2026-10-21T12:00:00Z");
const CONTEXT = {
  serverUrl: "https://github.com",
  now: NOW,
};

function event(type, payload, overrides = {}) {
  const { repo = "octocat/hello-world", ...rest } = overrides;
  return {
    id: "1",
    type,
    created_at: "2026-10-21T10:00:00Z",
    repo: typeof repo === "string" ? { name: repo } : repo,
    payload,
    ...rest,
  };
}

test("PullRequestEvent distinguishes merged, closed, and reopened", () => {
  const merged = formatEvent(
    event("PullRequestEvent", {
      action: "closed",
      pull_request: { number: 12, merged: true },
    }),
    CONTEXT,
  );
  assert.match(merged, /^🎉 Merged PR \[#12\]/);
  assert.match(merged, /https:\/\/github\.com\/octocat\/hello-world\/pull\/12/);

  const closed = formatEvent(
    event("PullRequestEvent", {
      action: "closed",
      pull_request: { number: 12, merged: false },
    }),
    CONTEXT,
  );
  assert.match(closed, /^❌ Closed PR/);

  const mergedAction = formatEvent(
    event("PullRequestEvent", {
      action: "merged",
      pull_request: { number: 13, merged: true },
    }),
    CONTEXT,
  );
  assert.match(mergedAction, /^🎉 Merged PR/);

  const opened = formatEvent(
    event("PullRequestEvent", {
      action: "opened",
      pull_request: { number: 14 },
    }),
    CONTEXT,
  );
  assert.match(opened, /^💪 Opened PR/);
});

test("PullRequestEvent renders the less common actions without undefined URLs", () => {
  const cases = [
    ["reopened", /^🔓 Reopened PR/],
    ["ready_for_review", /^👀 Marked PR/],
    ["converted_to_draft", /^🚧 Converted PR/],
    ["review_requested", /^🔍 Requested a review on PR/],
    ["review_request_removed", /^🔍 Removed a review request from PR/],
    ["synchronize", /^🔃 Updated PR/],
    ["auto_merge_enabled", /^✅ Enabled auto-merge/],
    ["labeled", /^🏷️ Labeled PR/],
    ["assigned", /^👤 Assigned PR/],
    ["edited", /^✏️ Edited PR/],
    ["queued", /^ℹ️ Queued PR/],
  ];

  for (const [action, pattern] of cases) {
    const line = formatEvent(
      event("PullRequestEvent", {
        action,
        pull_request: { number: 7, html_url: "https://github.com/o/r/pull/7" },
        label: { name: "bug" },
        assignee: { login: "octocat" },
      }),
      CONTEXT,
    );
    assert.match(line, pattern);
    assert.doesNotMatch(line, /undefined/);
    assert.match(line, /https:\/\/github\.com\/o\/r\/pull\/7/);
  }
});

test("IssuesEvent covers common actions, labels, and not-planned closures", () => {
  const issue = {
    number: 3,
    html_url: "https://github.com/octocat/hello-world/issues/3",
  };
  const reopened = formatEvent(
    event("IssuesEvent", { action: "reopened", issue }),
    CONTEXT,
  );
  assert.match(reopened, /^🔓 Reopened issue \[#3\]/);

  const notPlanned = formatEvent(
    event("IssuesEvent", {
      action: "closed",
      issue: { ...issue, state_reason: "not_planned" },
    }),
    CONTEXT,
  );
  assert.match(notPlanned, /^🚫 Closed issue/);
  assert.match(notPlanned, /as not planned/);

  const labeled = formatEvent(
    event("IssuesEvent", { action: "labeled", issue, label: { name: "bug" } }),
    CONTEXT,
  );
  assert.match(labeled, /^🏷️ Labeled issue/);
  assert.match(labeled, /label: "bug"/);

  const assigned = formatEvent(
    event("IssuesEvent", {
      action: "assigned",
      issue,
      assignee: { login: "octocat" },
    }),
    CONTEXT,
  );
  assert.match(assigned, /assignee: @octocat/);

  const unknown = formatEvent(
    event("IssuesEvent", { action: "demilestoned", issue }),
    CONTEXT,
  );
  assert.match(unknown, /^🎯 Removed milestone/);
});

test("IssueCommentEvent links to the comment and names PRs correctly", () => {
  const line = formatEvent(
    event("IssueCommentEvent", {
      action: "created",
      issue: {
        number: 10,
        html_url: "https://github.com/o/r/issues/10",
        pull_request: { url: "https://api.github.com/repos/o/r/pulls/10" },
      },
      comment: { html_url: "https://github.com/o/r/pull/10#issuecomment-1" },
    }),
    CONTEXT,
  );
  assert.match(line, /^🗣 Commented on PR \[#10\]/);
  assert.match(line, /pull\/10#issuecomment-1/);

  const edited = formatEvent(
    event("IssueCommentEvent", {
      action: "edited",
      issue: { number: 10, html_url: "https://github.com/o/r/issues/10" },
      comment: {},
    }),
    CONTEXT,
  );
  assert.match(edited, /^🗣 Edited a comment on issue/);
  assert.match(edited, /issues\/10/);
});

test("ReleaseEvent escapes names and falls back to the tag and repo releases URL", () => {
  const line = formatEvent(
    event("ReleaseEvent", {
      action: "published",
      release: {
        name: "v1 & <script>",
        html_url: "https://github.com/o/r/releases/tag/v1",
      },
    }),
    CONTEXT,
  );
  assert.match(line, /^🚀 Published release/);
  assert.match(line, /v1 &amp; &lt;script&gt;/);
  assert.doesNotMatch(line, /<script>/);

  const fallback = formatEvent(
    event("ReleaseEvent", {
      action: "prereleased",
      release: { tag_name: "v2.0.0-beta" },
    }),
    CONTEXT,
  );
  assert.match(fallback, /^🧪 Published pre-release/);
  assert.match(
    fallback,
    /\[v2\.0\.0-beta\]\(https:\/\/github\.com\/octocat\/hello-world\/releases\)/,
  );
});

test("PushEvent renders commit links and plural counts", () => {
  const single = formatEvent(
    event("PushEvent", {
      size: 1,
      commits: [{ sha: "abcdef1234567890" }],
      compare: "https://github.com/o/r/compare/a...b",
    }),
    CONTEXT,
  );
  assert.match(single, /^⬆️ Pushed commit \[abcdef1\]/);
  assert.match(single, /commit\/abcdef1234567890/);

  const multiple = formatEvent(
    event("PushEvent", {
      size: 3,
      commits: [{}, {}, {}],
      compare: "https://github.com/o/r/compare/a...b",
    }),
    CONTEXT,
  );
  assert.match(multiple, /^⬆️ Pushed \[3 commits\]/);
  assert.match(multiple, /compare\/a\.\.\.b/);

  const empty = formatEvent(
    event("PushEvent", { size: 0, commits: [], ref: "refs/heads/old" }),
    CONTEXT,
  );
  assert.match(empty, /^⬆️ Pushed to/);
});

test("Create, Delete, and Fork events describe refs safely", () => {
  const branch = formatEvent(
    event("CreateEvent", { ref_type: "branch", ref: "feature/my branch" }),
    CONTEXT,
  );
  assert.match(branch, /^🌱 Created branch/);
  assert.match(branch, /feature\/my%20branch/);

  const tag = formatEvent(
    event("CreateEvent", { ref_type: "tag", ref: "v1.0.0" }),
    CONTEXT,
  );
  assert.match(tag, /^🏷️ Created tag/);
  assert.match(tag, /tree\/v1\.0\.0/);

  const repository = formatEvent(
    event("CreateEvent", { ref_type: "repository", ref: null }),
    CONTEXT,
  );
  assert.match(repository, /^📦 Created repository/);

  const deleted = formatEvent(
    event("DeleteEvent", { ref_type: "branch", ref: "old-branch" }),
    CONTEXT,
  );
  assert.match(deleted, /^🗑️ Deleted branch `old-branch`/);

  const fork = formatEvent(
    event("ForkEvent", {
      forkee: {
        full_name: "someone/hello-world",
        html_url: "https://github.com/someone/hello-world",
      },
    }),
    CONTEXT,
  );
  assert.match(fork, /^🍴 Forked/);
  assert.match(fork, /someone\/hello-world/);
});

test("Watch, Public, Gollum, Member, and CommitComment events are supported", () => {
  const watch = formatEvent(
    event("WatchEvent", { action: "started" }),
    CONTEXT,
  );
  assert.match(watch, /^⭐ Starred/);

  const publicEvent = formatEvent(event("PublicEvent", {}), CONTEXT);
  assert.match(publicEvent, /^📣 Made/);

  const wiki = formatEvent(
    event("GollumEvent", { pages: [{}, {}, {}] }),
    CONTEXT,
  );
  assert.match(wiki, /^📝 Updated 3 wiki pages/);

  const member = formatEvent(
    event("MemberEvent", { action: "added", member: { login: "octocat" } }),
    CONTEXT,
  );
  assert.match(member, /^👥 Added @octocat/);

  const commitComment = formatEvent(
    event("CommitCommentEvent", {
      comment: {
        commit_id: "abcdef1234567890",
        html_url: "https://github.com/o/r/commit/abcdef#commitcomment-1",
      },
    }),
    CONTEXT,
  );
  assert.match(commitComment, /^💬 Commented on commit \[abcdef1\]/);
});

test("Review events render states and fall back to the PR URL", () => {
  const base = {
    pull_request: { number: 9, html_url: "https://github.com/o/r/pull/9" },
  };

  const approved = formatEvent(
    event("PullRequestReviewEvent", {
      action: "created",
      ...base,
      review: { state: "approved" },
    }),
    CONTEXT,
  );
  assert.match(approved, /^✅ Approved PR/);

  const changes = formatEvent(
    event("PullRequestReviewEvent", {
      action: "created",
      ...base,
      review: { state: "changes_requested" },
    }),
    CONTEXT,
  );
  assert.match(changes, /^🟠 Requested changes/);

  const dismissed = formatEvent(
    event("PullRequestReviewEvent", {
      action: "dismissed",
      ...base,
      review: { state: "dismissed" },
    }),
    CONTEXT,
  );
  assert.match(dismissed, /^🚫 Dismissed a review/);

  const reviewComment = formatEvent(
    event("PullRequestReviewCommentEvent", {
      ...base,
      comment: { html_url: "https://github.com/o/r/pull/9#discussion_r1" },
    }),
    CONTEXT,
  );
  assert.match(reviewComment, /^💬 Commented on a review of PR/);
  assert.match(reviewComment, /discussion_r1/);

  const resolved = formatEvent(
    event("PullRequestReviewThreadEvent", {
      action: "resolved",
      ...base,
    }),
    CONTEXT,
  );
  assert.match(resolved, /^🧵 Resolved a review thread/);
});

test("timestamps are appended only when enabled", () => {
  const input = event("WatchEvent", { action: "started" });
  assert.doesNotMatch(formatEvent(input, CONTEXT), /<sub>/);

  const dated = formatEvent(input, {
    ...CONTEXT,
    showTimestamps: true,
    timestampFormat: "relative",
  });
  assert.match(dated, / · <sub>2 hours ago<\/sub>$/);
});

test("GHES server URLs are used for constructed links", () => {
  const line = formatEvent(
    event("PullRequestEvent", {
      action: "opened",
      pull_request: { number: 2 },
    }),
    { serverUrl: "https://github.example.com", now: NOW },
  );
  assert.match(
    line,
    /https:\/\/github\.example\.com\/octocat\/hello-world\/pull\/2/,
  );
});

test("malformed events are skipped instead of rendering undefined", () => {
  assert.equal(formatEvent(null, CONTEXT), null);
  assert.equal(
    formatEvent({ type: "UnknownEvent", payload: {} }, CONTEXT),
    null,
  );
  assert.equal(
    formatEvent(
      event("PullRequestEvent", { action: "opened", pull_request: {} }),
      CONTEXT,
    ),
    null,
  );
  assert.equal(
    formatEvent(event("IssuesEvent", { action: "opened", issue: {} }), CONTEXT),
    null,
  );
  assert.equal(
    formatEvent(
      event("ReleaseEvent", { action: "published", release: {} }, { repo: {} }),
      CONTEXT,
    ),
    null,
  );
});

test("formatActivityLines drops unformattable events", () => {
  const lines = formatActivityLines(
    [
      event("WatchEvent", { action: "started" }),
      { type: "NopeEvent" },
      event("PublicEvent", {}),
    ],
    CONTEXT,
  );
  assert.equal(lines.length, 2);
});

test("resolveEventFilter understands defaults, wildcards, and typos", () => {
  assert.deepEqual(
    [...resolveEventFilter(DEFAULT_FILTER_EVENTS.join(","))].sort(),
    [...DEFAULT_FILTER_EVENTS].sort(),
  );
  assert.equal(resolveEventFilter("*").size, SUPPORTED_EVENT_TYPES.length);
  assert.equal(resolveEventFilter("").size, SUPPORTED_EVENT_TYPES.length);
  assert.equal(resolveEventFilter("issuecommentevent").size, 1);

  const warnings = [];
  const selected = resolveEventFilter("WatchEvent,NotARealEvent", {
    onWarning: (message) => warnings.push(message),
  });
  assert.deepEqual([...selected], ["WatchEvent"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /NotARealEvent/);
});

test("repository glob patterns support owner and repo wildcards", () => {
  const warnings = [];
  const patterns = compileRepoPatterns(
    ["octocat/*", "*/hello-world", "someone/other", "not-a-pattern"],
    (message) => warnings.push(message),
  );
  assert.equal(patterns.length, 3);
  assert.equal(warnings.length, 1);

  assert.equal(isRepoExcluded("octocat/anything", patterns), true);
  assert.equal(isRepoExcluded("someone/hello-world", patterns), true);
  assert.equal(isRepoExcluded("someone/other", patterns), true);
  assert.equal(isRepoExcluded("someone/else", patterns), false);
  assert.equal(isRepoExcluded("OCTOCAT/repo", patterns), true);
});

test("selectEvents applies type and repository filters", () => {
  const patterns = compileRepoPatterns(["octocat/ignored"]);
  const events = [
    event("WatchEvent", {}, { repo: "octocat/kept" }),
    event("IssuesEvent", {}, { repo: "octocat/ignored" }),
    event("IssuesEvent", {}, { repo: "octocat/kept" }),
    event("ForkEvent", {}, { repo: "octocat/kept" }),
  ];
  const selected = selectEvents(events, {
    filter: new Set(["IssuesEvent", "WatchEvent"]),
    excludeRepos: patterns,
  });
  assert.equal(selected.length, 2);
  assert.deepEqual(
    selected.map((item) => item.type),
    ["WatchEvent", "IssuesEvent"],
  );
});

test("encodeRefPath preserves slashes and encodes each segment", () => {
  assert.equal(encodeRefPath("feature/my branch"), "feature/my%20branch");
  assert.equal(encodeRefPath("release/1.0.0"), "release/1.0.0");
});
