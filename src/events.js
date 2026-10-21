"use strict";

const {
  MAX_RELEASE_NAME_LENGTH,
  cleanText,
  escapeMarkdown,
  escapeInlineCode,
  timestampSuffix,
  isPlainObject,
} = require("./utils");

/**
 * Event types that can be rendered by this action, in alphabetical order.
 * Kept in sync with the serializers below and documented in docs/events.md.
 */
const DEFAULT_FILTER_EVENTS = Object.freeze([
  "IssueCommentEvent",
  "IssuesEvent",
  "PullRequestEvent",
  "ReleaseEvent",
]);

const eventFormatters = {
  CommitCommentEvent: formatCommitComment,
  CreateEvent: formatCreate,
  DeleteEvent: formatDelete,
  ForkEvent: formatFork,
  GollumEvent: formatGollum,
  IssueCommentEvent: formatIssueComment,
  IssuesEvent: formatIssue,
  MemberEvent: formatMember,
  PublicEvent: formatPublic,
  PullRequestEvent: formatPullRequest,
  PullRequestReviewCommentEvent: formatPullRequestReviewComment,
  PullRequestReviewEvent: formatPullRequestReview,
  PullRequestReviewThreadEvent: formatPullRequestReviewThread,
  PushEvent: formatPush,
  ReleaseEvent: formatRelease,
  WatchEvent: formatWatch,
};

const SUPPORTED_EVENT_TYPES = Object.freeze(
  Object.keys(eventFormatters).sort(),
);

/**
 * Convert an event into a single markdown list item (without the list number).
 *
 * @param {object} event - GitHub event from the REST API.
 * @param {object} options
 * @param {string} options.serverUrl - GitHub web base URL (supports GHES).
 * @param {boolean} [options.showTimestamps]
 * @param {"date"|"datetime"|"relative"} [options.timestampFormat]
 * @param {Date} [options.now]
 * @param {(message: string, error?: Error) => void} [options.onError]
 * @returns {string|null}
 */
function formatEvent(event, options = {}) {
  if (!isPlainObject(event) || typeof event.type !== "string") {
    return null;
  }

  const formatter = eventFormatters[event.type];
  if (!formatter) {
    return null;
  }

  const context = {
    serverUrl: normalizeServerUrl(options.serverUrl),
    now: options.now instanceof Date ? options.now : new Date(),
  };

  let description;
  try {
    description = formatter(event, context);
  } catch (error) {
    options.onError?.(`Could not format ${event.type} event.`, error);
    return null;
  }

  if (typeof description !== "string") {
    return null;
  }

  const line = cleanText(description.replace(/\s*\n\s*/g, " "), 400);
  if (!line) {
    return null;
  }

  return `${line}${timestampSuffix(event.created_at, {
    showTimestamps: Boolean(options.showTimestamps),
    timestampFormat: options.timestampFormat || "date",
    now: context.now,
  })}`;
}

/**
 * Format a list of events, dropping anything that cannot be represented.
 *
 * @param {object[]} events
 * @param {object} [options]
 * @returns {string[]}
 */
function formatActivityLines(events, options = {}) {
  const lines = [];
  for (const event of events) {
    const line = formatEvent(event, options);
    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

/**
 * Build the set of event types requested by FILTER_EVENTS.
 *
 * @param {string} rawFilter
 * @param {object} [options]
 * @param {(message: string) => void} [options.onWarning]
 * @returns {Set<string>}
 */
function resolveEventFilter(rawFilter, { onWarning } = {}) {
  const entries = String(rawFilter ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0 || entries.includes("*")) {
    return new Set(SUPPORTED_EVENT_TYPES);
  }

  const canonicalByLowerCase = new Map(
    SUPPORTED_EVENT_TYPES.map((type) => [type.toLowerCase(), type]),
  );
  const selected = new Set();

  for (const entry of entries) {
    const canonical = canonicalByLowerCase.get(entry.toLowerCase());
    if (canonical) {
      selected.add(canonical);
    } else {
      onWarning?.(
        `Unsupported event type "${entry}" in FILTER_EVENTS. Supported types: ${SUPPORTED_EVENT_TYPES.join(", ")}.`,
      );
    }
  }

  return selected;
}

/**
 * Compile EXCLUDE_REPOS glob patterns (`owner/repo`, `owner/anything`,
 * `anything/repo`).
 *
 * @param {string[]} patterns
 * @param {(message: string) => void} [onWarning]
 * @returns {Array<{pattern: string, regex: RegExp}>}
 */
function compileRepoPatterns(patterns, onWarning) {
  const compiled = [];

  for (const pattern of patterns) {
    if (!pattern.includes("/") && pattern !== "*") {
      onWarning?.(
        `Ignoring EXCLUDE_REPOS pattern "${pattern}". Patterns must look like "owner/repo", "owner/*", or "*/repo".`,
      );
      continue;
    }

    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    compiled.push({
      pattern,
      regex: new RegExp(`^${escaped}$`, "i"),
    });
  }

  return compiled;
}

/**
 * @param {string} repoName
 * @param {Array<{pattern: string, regex: RegExp}>} patterns
 * @returns {boolean}
 */
function isRepoExcluded(repoName, patterns) {
  return patterns.some(({ regex }) => regex.test(repoName));
}

/**
 * Apply the event type and repository filters.
 *
 * @param {object[]} events
 * @param {object} [options]
 * @param {Set<string>} [options.filter]
 * @param {Array<{pattern: string, regex: RegExp}>} [options.excludeRepos]
 * @returns {object[]}
 */
function selectEvents(events, { filter, excludeRepos = [] } = {}) {
  return events.filter((event) => {
    if (!event || !event.type || !eventFormatters[event.type]) {
      return false;
    }
    if (filter && !filter.has(event.type)) {
      return false;
    }
    const repoName = event.repo?.name;
    if (repoName && isRepoExcluded(repoName, excludeRepos)) {
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function formatIssueComment(event, context) {
  const payload = event.payload || {};
  const issue = payload.issue || {};
  const comment = payload.comment || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  if (!Number.isFinite(Number(issue.number))) {
    return null;
  }

  const fallbackUrl = safeUrl(issue.html_url) || repoUrl(event, context);
  const url = safeUrl(comment.html_url) || fallbackUrl;
  const ref = numberRef(issue.number, url);
  const noun = issue.pull_request ? "PR" : "issue";
  const action = payload.action || "created";

  const verbs = {
    created: "Commented on",
    edited: "Edited a comment on",
    deleted: "Deleted a comment on",
  };
  const verb = verbs[action] || "Commented on";

  return `🗣 ${verb} ${noun} ${ref} in ${repo}`;
}

function formatIssue(event, context) {
  const payload = event.payload || {};
  const issue = payload.issue || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  if (!Number.isFinite(Number(issue.number))) {
    return null;
  }

  const url =
    safeUrl(issue.html_url) ||
    `${repoUrl(event, context)}/issues/${issue.number}`;
  const ref = numberRef(issue.number, url);
  const action = payload.action || "updated";
  const detail = actionDetail(payload);

  switch (action) {
    case "opened":
      return `❗ Opened issue ${ref} in ${repo}`;
    case "reopened":
      return `🔓 Reopened issue ${ref} in ${repo}`;
    case "closed":
      return issue.state_reason === "not_planned"
        ? `🚫 Closed issue ${ref} in ${repo} as not planned`
        : `🔒 Closed issue ${ref} in ${repo}`;
    case "labeled":
      return `🏷️ Labeled issue ${ref} in ${repo}${detail}`;
    case "unlabeled":
      return `🏷️ Unlabeled issue ${ref} in ${repo}${detail}`;
    case "assigned":
      return `👤 Assigned issue ${ref} in ${repo}${detail}`;
    case "unassigned":
      return `👤 Unassigned issue ${ref} in ${repo}${detail}`;
    case "edited":
      return `✏️ Edited issue ${ref} in ${repo}`;
    case "pinned":
      return `📌 Pinned issue ${ref} in ${repo}`;
    case "unpinned":
      return `📌 Unpinned issue ${ref} in ${repo}`;
    case "transferred":
      return `➡️ Transferred issue ${ref} in ${repo}`;
    case "milestoned":
      return `🎯 Milestoned issue ${ref} in ${repo}`;
    case "demilestoned":
      return `🎯 Removed milestone from issue ${ref} in ${repo}`;
    case "locked":
      return `🔐 Locked issue ${ref} in ${repo}`;
    case "unlocked":
      return `🔓 Unlocked issue ${ref} in ${repo}`;
    case "deleted":
      return `🗑️ Deleted issue ${ref} in ${repo}`;
    default:
      return `ℹ️ ${humanizeAction(action)} issue ${ref} in ${repo}`;
  }
}

function formatPullRequest(event, context) {
  const payload = event.payload || {};
  const pr = payload.pull_request || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  if (!Number.isFinite(Number(pr.number))) {
    return null;
  }

  const fallbackUrl = `${repoUrl(event, context)}/pull/${pr.number}`;
  const url = safeUrl(pr.html_url) || fallbackUrl;
  const ref = numberRef(pr.number, url);
  const action = payload.action || "updated";
  const detail = actionDetail(payload);
  const isMerged = action === "merged" || pr.merged === true;

  switch (action) {
    case "opened":
      return `💪 Opened PR ${ref} in ${repo}`;
    case "closed":
      return isMerged
        ? `🎉 Merged PR ${ref} in ${repo}`
        : `❌ Closed PR ${ref} in ${repo}`;
    case "merged":
      return `🎉 Merged PR ${ref} in ${repo}`;
    case "reopened":
      return `🔓 Reopened PR ${ref} in ${repo}`;
    case "ready_for_review":
      return `👀 Marked PR ${ref} ready for review in ${repo}`;
    case "converted_to_draft":
      return `🚧 Converted PR ${ref} to draft in ${repo}`;
    case "review_requested":
      return `🔍 Requested a review on PR ${ref} in ${repo}${detail}`;
    case "review_request_removed":
      return `🔍 Removed a review request from PR ${ref} in ${repo}${detail}`;
    case "synchronize":
      return `🔃 Updated PR ${ref} in ${repo}`;
    case "auto_merge_enabled":
      return `✅ Enabled auto-merge on PR ${ref} in ${repo}`;
    case "auto_merge_disabled":
      return `⛔ Disabled auto-merge on PR ${ref} in ${repo}`;
    case "labeled":
      return `🏷️ Labeled PR ${ref} in ${repo}${detail}`;
    case "unlabeled":
      return `🏷️ Unlabeled PR ${ref} in ${repo}${detail}`;
    case "assigned":
      return `👤 Assigned PR ${ref} in ${repo}${detail}`;
    case "unassigned":
      return `👤 Unassigned PR ${ref} in ${repo}${detail}`;
    case "edited":
      return `✏️ Edited PR ${ref} in ${repo}`;
    default:
      return `ℹ️ ${humanizeAction(action)} PR ${ref} in ${repo}`;
  }
}

function formatPullRequestReview(event, context) {
  const payload = event.payload || {};
  const review = payload.review || {};
  const pr = payload.pull_request || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  const number = reviewNumber(pr, review);
  if (!number) {
    return null;
  }

  const prUrl =
    safeUrl(pr.html_url) || `${repoUrl(event, context)}/pull/${number}`;
  const url = safeUrl(review.html_url) || prUrl;
  const ref = numberRef(number, url);
  const state = review.state || payload.action;

  switch (state) {
    case "approved":
      return `✅ Approved PR ${ref} in ${repo}`;
    case "changes_requested":
      return `🟠 Requested changes on PR ${ref} in ${repo}`;
    case "dismissed":
      return `🚫 Dismissed a review on PR ${ref} in ${repo}`;
    case "commented":
      return `💬 Reviewed PR ${ref} in ${repo}`;
    default:
      return `🔍 Reviewed PR ${ref} in ${repo}`;
  }
}

function formatPullRequestReviewComment(event, context) {
  const payload = event.payload || {};
  const comment = payload.comment || {};
  const pr = payload.pull_request || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  const number = reviewNumber(pr, payload);
  if (!number) {
    return null;
  }

  const prUrl =
    safeUrl(pr.html_url) || `${repoUrl(event, context)}/pull/${number}`;
  const url = safeUrl(comment.html_url) || prUrl;
  const ref = numberRef(number, url);
  return `💬 Commented on a review of PR ${ref} in ${repo}`;
}

function formatPullRequestReviewThread(event, context) {
  const payload = event.payload || {};
  const pr = payload.pull_request || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  const number = reviewNumber(pr, payload);
  if (!number) {
    return null;
  }

  const prUrl =
    safeUrl(pr.html_url) || `${repoUrl(event, context)}/pull/${number}`;
  const ref = numberRef(number, prUrl);
  const action = payload.action || "updated";

  switch (action) {
    case "resolved":
      return `🧵 Resolved a review thread on PR ${ref} in ${repo}`;
    case "unresolved":
      return `🧵 Reopened a review thread on PR ${ref} in ${repo}`;
    case "outdated":
      return `🧵 Marked a review thread on PR ${ref} as outdated in ${repo}`;
    default:
      return `🧵 Updated a review thread on PR ${ref} in ${repo}`;
  }
}

function formatPush(event, context) {
  const payload = event.payload || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  const count = Number.isInteger(payload.size) ? payload.size : commits.length;
  const compareUrl = safeUrl(payload.compare);

  if (count === 1) {
    const sha = commits[0]?.sha;
    if (typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha)) {
      const shortSha = sha.slice(0, 7);
      return `⬆️ Pushed commit [${shortSha}](${repoUrl(event, context)}/commit/${sha}) to ${repo}`;
    }
    return `⬆️ Pushed 1 commit to ${repo}`;
  }

  if (count > 1) {
    const label = `${count} commits`;
    const commitsText = compareUrl ? `[${label}](${compareUrl})` : label;
    return `⬆️ Pushed ${commitsText} to ${repo}`;
  }

  return `⬆️ Pushed to ${repo}`;
}

function formatCreate(event, context) {
  const payload = event.payload || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  const refType = payload.ref_type;
  const ref = payload.ref;

  if (refType === "repository") {
    return `📦 Created repository ${repo}`;
  }

  if (refType === "branch") {
    return `🌱 Created branch ${ref ? refLink(event, context, ref) : "(unknown)"} in ${repo}`;
  }
  if (refType === "tag") {
    return `🏷️ Created tag ${ref ? refLink(event, context, ref) : "(unknown)"} in ${repo}`;
  }

  return `📦 Created ${escapeInlineCode(refType || "ref", 20)}${
    ref ? ` \`${escapeInlineCode(ref, 60)}\`` : ""
  } in ${repo}`;
}

function formatDelete(event, context) {
  const payload = event.payload || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  const refType = payload.ref_type || "ref";
  const ref = payload.ref;
  return `🗑️ Deleted ${escapeInlineCode(refType, 20)}${ref ? ` \`${escapeInlineCode(ref, 60)}\`` : ""} in ${repo}`;
}

function formatFork(event, context) {
  const payload = event.payload || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  const forkee = payload.forkee || {};
  const forkName = forkee.full_name;
  const forkUrl = safeUrl(forkee.html_url);
  if (forkName && forkUrl) {
    return `🍴 Forked ${repo} to [${escapeMarkdown(forkName)}](${forkUrl})`;
  }

  return `🍴 Forked ${repo}`;
}

function formatWatch(event, context) {
  const repo = repoLink(event, context);
  return repo ? `⭐ Starred ${repo}` : null;
}

function formatPublic(event, context) {
  const repo = repoLink(event, context);
  return repo ? `📣 Made ${repo} public` : null;
}

function formatCommitComment(event, context) {
  const payload = event.payload || {};
  const comment = payload.comment || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  const commitId =
    typeof comment.commit_id === "string" ? comment.commit_id : "";
  const shortSha = commitId.slice(0, 7);
  const url =
    safeUrl(comment.html_url) ||
    (commitId
      ? `${repoUrl(event, context)}/commit/${commitId}`
      : repoUrl(event, context));

  return shortSha
    ? `💬 Commented on commit [${shortSha}](${url}) in ${repo}`
    : `💬 Commented on a commit in ${repo}`;
}

function formatGollum(event, context) {
  const payload = event.payload || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  const pages = Array.isArray(payload.pages) ? payload.pages.length : 0;
  return pages > 1
    ? `📝 Updated ${pages} wiki pages in ${repo}`
    : `📝 Updated the wiki in ${repo}`;
}

function formatMember(event, context) {
  const payload = event.payload || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  const member = payload.member?.login;
  const who = member ? `@${escapeMarkdown(member, 40)}` : "a collaborator";
  const action = payload.action || "added";

  switch (action) {
    case "added":
      return `👥 Added ${who} as a collaborator in ${repo}`;
    case "removed":
      return `👥 Removed ${who} as a collaborator in ${repo}`;
    case "edited":
      return `👥 Changed collaborator permissions for ${who} in ${repo}`;
    default:
      return `👥 Updated collaborators in ${repo}`;
  }
}

function formatRelease(event, context) {
  const payload = event.payload || {};
  const release = payload.release || {};
  const repo = repoLink(event, context);
  if (!repo) {
    return null;
  }

  const name =
    cleanText(release.name, MAX_RELEASE_NAME_LENGTH) ||
    cleanText(release.tag_name, MAX_RELEASE_NAME_LENGTH) ||
    "release";
  const url =
    safeUrl(release.html_url) || `${repoUrl(event, context)}/releases`;
  const link = `[${escapeMarkdown(name, MAX_RELEASE_NAME_LENGTH)}](${url})`;
  const action = payload.action || "published";

  switch (action) {
    case "published":
    case "released":
      return `🚀 Published release ${link} in ${repo}`;
    case "prereleased":
      return `🧪 Published pre-release ${link} in ${repo}`;
    case "edited":
      return `✏️ Edited release ${link} in ${repo}`;
    case "deleted":
      return `🗑️ Deleted release ${link} in ${repo}`;
    case "created":
      return `📦 Created release ${link} in ${repo}`;
    default:
      return `🚀 ${humanizeAction(action)} release ${link} in ${repo}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @param {object} event
 * @param {{serverUrl: string}} context
 * @returns {string}
 */
function repoUrl(event, context) {
  const name = event?.repo?.name;
  return name ? `${context.serverUrl}/${name}` : context.serverUrl;
}

/**
 * @param {object} event
 * @param {{serverUrl: string}} context
 * @returns {string|null}
 */
function repoLink(event, context) {
  const name = event?.repo?.name;
  if (typeof name !== "string" || !name.trim()) {
    return null;
  }
  return `[${escapeMarkdown(name, 100)}](${context.serverUrl}/${name})`;
}

/**
 * @param {unknown} number
 * @param {string} url
 * @returns {string}
 */
function numberRef(number, url) {
  if (!Number.isFinite(Number(number))) {
    return `[#?](${url})`;
  }
  return `[#${Number(number)}](${url})`;
}

/**
 * @param {unknown} url
 * @returns {string|null}
 */
function safeUrl(url) {
  if (typeof url !== "string") {
    return null;
  }
  const trimmed = url.trim();
  return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null;
}

/**
 * @param {object} event
 * @param {{serverUrl: string}} context
 * @param {string} ref
 * @returns {string}
 */
function refLink(event, context, ref) {
  const label = escapeMarkdown(ref, 60);
  const url = `${repoUrl(event, context)}/tree/${encodeRefPath(ref)}`;
  return `[${label}](${url})`;
}

/**
 * Encode a branch or tag name for use in a URL path while preserving `/`.
 *
 * @param {string} ref
 * @returns {string}
 */
function encodeRefPath(ref) {
  return String(ref)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * @param {string} action
 * @returns {string}
 */
function humanizeAction(action) {
  const normalized = String(action || "updated")
    .replace(/_/g, " ")
    .trim();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/**
 * Extra context for label/assignee/reviewer changes.
 *
 * @param {object} payload
 * @returns {string}
 */
function actionDetail(payload) {
  const label = payload.label?.name;
  if (label) {
    return ` (label: "${escapeMarkdown(label, 40)}")`;
  }

  const assignee = payload.assignee?.login;
  if (assignee) {
    return ` (assignee: @${escapeMarkdown(assignee, 40)})`;
  }

  const reviewer = payload.requested_reviewer?.login;
  if (reviewer) {
    return ` (reviewer: @${escapeMarkdown(reviewer, 40)})`;
  }

  const milestone = payload.milestone?.title;
  if (milestone) {
    return ` (milestone: "${escapeMarkdown(milestone, 40)}")`;
  }

  return "";
}

/**
 * Resolve a pull request number from a review/comment event, falling back to
 * the pull request URL when the payload omits the number.
 *
 * @param {object} pr
 * @param {object} payload
 * @returns {number|null}
 */
function reviewNumber(pr, payload) {
  if (Number.isFinite(Number(pr?.number))) {
    return Number(pr.number);
  }

  const candidates = [
    payload?.review?.pull_request_url,
    payload?.pull_request_url,
    payload?.comment?.pull_request_url,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const match = candidate.match(/\/pulls?\/(\d+)\/?$/);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

/**
 * @param {string} serverUrl
 * @returns {string}
 */
function normalizeServerUrl(serverUrl) {
  const value =
    typeof serverUrl === "string" && serverUrl.trim()
      ? serverUrl.trim()
      : "https://github.com";
  return value.replace(/\/+$/, "");
}

module.exports = {
  DEFAULT_FILTER_EVENTS,
  SUPPORTED_EVENT_TYPES,
  formatEvent,
  formatActivityLines,
  resolveEventFilter,
  compileRepoPatterns,
  isRepoExcluded,
  selectEvents,
  repoUrl,
  repoLink,
  safeUrl,
  encodeRefPath,
  humanizeAction,
};
