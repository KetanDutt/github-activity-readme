/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ 783:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const fs = __nccwpck_require__(455);

const { ActionError, GitError } = __nccwpck_require__(438);
const { loadConfig } = __nccwpck_require__(283);
const { createLogger } = __nccwpck_require__(33);
const { createGitHubClient, fetchActivity } = __nccwpck_require__(474);
const { formatActivityLines } = __nccwpck_require__(476);
const { buildSectionLines, replaceSection } = __nccwpck_require__(38);
const git = __nccwpck_require__(661);
const { escapeMarkdown, sleep: defaultSleep } = __nccwpck_require__(804);

/**
 * Run the action.
 *
 * Dependencies are injectable so the orchestration can be tested end-to-end in
 * a temporary git repository without touching the network.
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.cwd]
 * @param {object} [options.core] - @actions/core compatible logger.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {Date} [options.now]
 * @param {boolean} [options.requireToken]
 * @param {Function} [options.gitRun] - Custom `runGit` implementation.
 * @param {Function} [options.sleepFn]
 * @returns {Promise<object>}
 */
async function runAction({
  env = process.env,
  cwd = env.GITHUB_WORKSPACE || process.cwd(),
  core = createLogger(),
  fetchImpl = globalThis.fetch,
  now = new Date(),
  requireToken = true,
  gitRun,
  sleepFn,
} = {}) {
  const startedAt = Date.now();
  const config = loadConfig({ env, cwd, requireToken, now });
  const run = gitRun || git.runGit;
  const sleep = sleepFn || defaultSleep;
  const secrets = config.token ? [config.token] : [];

  if (config.token) {
    core.setSecret(config.token);
  }
  for (const warning of config.warnings) {
    core.warning(warning);
  }

  core.info(
    `GitHub Activity in README · ${config.usernames.map((user) => `@${user}`).join(", ")} · ${config.targetFile.relativePath} · max ${config.maxLines} line${config.maxLines === 1 ? "" : "s"}`,
  );

  const originalText = await fs.readFile(
    config.targetFile.absolutePath,
    "utf8",
  );
  const validation = replaceSection(originalText, {
    sectionName: config.sectionName,
    lines: [],
  });
  if (!validation.found) {
    throw new ActionError(
      `Couldn't find the section markers in ${config.targetFile.relativePath}.`,
      {
        hint: `Add <!--START_SECTION:${config.sectionName}--> and <!--END_SECTION:${config.sectionName}--> to the file. See https://github.com/KetanDutt/github-activity-readme#quick-start.`,
      },
    );
  }
  if (validation.insertedEndMarker) {
    core.warning(
      `The END marker for section "${config.sectionName}" is missing. It will be added after the activity list.`,
    );
  }

  if (!config.token) {
    core.warning(
      "No GitHub token was provided. Unauthenticated requests are limited to 60 per hour.",
    );
  }

  const activity = await fetchWithGroup(core, () => {
    const client = createGitHubClient({
      token: config.token,
      apiUrl: config.apiUrl,
      userAgent: config.userAgent,
      fetchImpl,
      timeoutMs: config.requestTimeoutMs,
      sleep,
      onDebug: (message) => core.debug(message),
    });

    return fetchActivity({
      client,
      usernames: config.usernames,
      filter: config.filterSet,
      excludeRepos: config.excludeRepos,
      maxLines: config.maxLines,
      maxPages: config.maxEventPages,
      onDebug: (message) => core.debug(message),
    });
  });

  core.info(
    `Scanned ${activity.scanned} public event${activity.scanned === 1 ? "" : "s"} across ${activity.pages} API page${activity.pages === 1 ? "" : "s"}; ${activity.events.length} matched.`,
  );

  const lines = formatActivityLines(activity.events, {
    serverUrl: config.serverUrl,
    showTimestamps: config.showTimestamps,
    timestampFormat: config.timestampFormat,
    now,
    onError: (message, error) =>
      core.debug(`${message} ${error?.message || ""}`),
  });
  const sectionLines = buildSectionLines(lines);

  if (sectionLines.length === 0) {
    core.info(
      activity.events.length === 0
        ? `No matching public activity found for ${config.usernames.map((user) => `@${user}`).join(", ")}.`
        : "Matching events were found, but none could be rendered as activity lines.",
    );
    return finishWithoutChanges({
      core,
      config,
      cwd,
      run,
      sleep,
      secrets,
      activityCount: 0,
      preview: [],
      dryRun: config.dryRun,
      startedAt,
    });
  }

  const updated = replaceSection(originalText, {
    sectionName: config.sectionName,
    lines: sectionLines,
  });

  if (!updated.changed) {
    core.info("The activity section is already up to date.");
    return finishWithoutChanges({
      core,
      config,
      cwd,
      run,
      sleep,
      secrets,
      activityCount: sectionLines.length,
      preview: sectionLines,
      dryRun: config.dryRun,
      startedAt,
    });
  }

  if (config.dryRun) {
    core.info("Dry run enabled; the file and repository were not changed.");
    core.info(`Preview:\n${sectionLines.join("\n")}`);
    await writeSummary(core, {
      config,
      result: "dry-run",
      lines: sectionLines,
      changed: false,
      dryRun: true,
      commitSha: null,
    });
    const result = {
      result: "dry-run",
      changed: false,
      wouldChange: true,
      activityCount: sectionLines.length,
      targetFile: config.targetFile.relativePath,
      commitSha: null,
      preview: sectionLines,
    };
    setOutputs(core, result);
    return result;
  }

  const branch = await git.getCurrentBranch({
    cwd: config.workspace,
    run,
    secrets,
    onDebug: (message) => core.debug(message),
  });
  if (!branch) {
    throw new ActionError(
      "The repository is in detached HEAD state, so there is no branch to push to.",
      {
        hint: "Use actions/checkout with a branch ref. Scheduled workflows check out the default branch automatically; pull_request checks check out a merge commit.",
      },
    );
  }

  await fs.writeFile(config.targetFile.absolutePath, updated.text, "utf8");

  let commitSha = null;
  try {
    const outcome = await git.commitAndPush({
      file: config.targetFile.relativePath,
      message: config.commit.message,
      name: config.commit.name,
      email: config.commit.email,
      branch,
      cwd: config.workspace,
      retries: config.pushRetries,
      run,
      sleep,
      secrets,
      onDebug: (message) => core.debug(message),
    });

    if (!outcome.committed) {
      await fs.writeFile(config.targetFile.absolutePath, originalText, "utf8");
      throw new ActionError(
        "The activity section changed, but git reported nothing to commit.",
        {
          hint: "Check whether a clean/smudge filter or another process reverted the file.",
        },
      );
    }

    commitSha = outcome.sha;
  } catch (error) {
    if (!(error instanceof GitError && error.committed)) {
      await fs
        .writeFile(config.targetFile.absolutePath, originalText, "utf8")
        .catch(() => {});
      core.warning(
        `The update was rolled back because the commit could not be created: ${config.targetFile.relativePath}`,
      );
    }
    throw error;
  }

  core.info(
    `Updated ${config.targetFile.relativePath} with ${sectionLines.length} activit${sectionLines.length === 1 ? "y" : "ies"} and pushed commit ${commitSha ? commitSha.slice(0, 7) : "(unknown)"} to ${branch}.`,
  );

  const result = {
    result: "updated",
    changed: true,
    wouldChange: true,
    activityCount: sectionLines.length,
    targetFile: config.targetFile.relativePath,
    commitSha,
    preview: sectionLines,
  };
  setOutputs(core, result);
  await writeSummary(core, {
    config,
    result: "updated",
    lines: sectionLines,
    changed: true,
    dryRun: false,
    commitSha,
    branch,
  });

  core.debug(`Finished in ${Date.now() - startedAt}ms.`);
  return result;
}

/**
 * Handle "no events" and "already up to date" flows, including the optional
 * empty commit that keeps long-idle scheduled workflows enabled.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
async function finishWithoutChanges({
  core,
  config,
  cwd,
  run,
  sleep,
  secrets,
  activityCount,
  preview,
  dryRun,
  startedAt,
}) {
  let resultName = dryRun ? "dry-run" : "unchanged";
  let commitSha = null;

  if (!dryRun && config.emptyCommitDays > 0) {
    const empty = await createEmptyCommitIfStale({
      core,
      config,
      cwd,
      run,
      sleep,
      secrets,
    });
    if (empty) {
      resultName = "empty-commit";
      commitSha = empty.sha;
    }
  }

  const result = {
    result: resultName,
    changed: false,
    wouldChange: false,
    activityCount,
    targetFile: config.targetFile.relativePath,
    commitSha,
    preview,
  };
  setOutputs(core, result);
  await writeSummary(core, {
    config,
    result: resultName,
    lines: preview,
    changed: false,
    dryRun,
    commitSha,
  });
  core.debug(`Finished in ${Date.now() - startedAt}ms.`);
  return result;
}

/**
 * @param {object} options
 * @returns {Promise<{sha: string|null}|null>}
 */
async function createEmptyCommitIfStale({
  core,
  config,
  cwd,
  run,
  sleep,
  secrets,
}) {
  const ageDays = await git.getLastCommitAgeDays({
    now: config.now,
    cwd: config.workspace,
    run,
    secrets,
  });

  if (ageDays === null) {
    core.warning(
      "Could not determine the age of the last commit; skipping the empty commit check.",
    );
    return null;
  }

  core.debug(
    `The last commit was ${ageDays.toFixed(1)} day(s) ago (threshold: ${config.emptyCommitDays}).`,
  );

  if (ageDays < config.emptyCommitDays) {
    core.info(
      `No update needed. The last commit was ${Math.max(0, Math.floor(ageDays))} day(s) ago; an empty commit is only created after ${config.emptyCommitDays} day(s) without commits.`,
    );
    return null;
  }

  const branch = await git.getCurrentBranch({
    cwd: config.workspace,
    run,
    secrets,
    onDebug: (message) => core.debug(message),
  });
  if (!branch) {
    core.warning(
      "The repository is in detached HEAD state; skipping the empty commit.",
    );
    return null;
  }

  core.info(
    `The last commit was ${Math.floor(ageDays)} day(s) ago; creating an empty commit to keep the scheduled workflow active.`,
  );

  const outcome = await git.commitAndPush({
    allowEmpty: true,
    message: config.commit.emptyMessage,
    name: config.commit.name,
    email: config.commit.email,
    branch,
    cwd: config.workspace,
    retries: config.pushRetries,
    run,
    sleep,
    secrets,
    onDebug: (message) => core.debug(message),
  });

  return { sha: outcome.sha };
}

/**
 * @param {object} core
 * @param {Function} fn
 * @returns {Promise<*>}
 */
async function fetchWithGroup(core, fn) {
  core.startGroup("Fetching GitHub activity");
  try {
    return await fn();
  } finally {
    core.endGroup();
  }
}

/**
 * Publish action outputs. All outputs are strings, matching GitHub's output
 * contract.
 *
 * @param {object} core
 * @param {object} result
 */
function setOutputs(core, result) {
  core.setOutput("changed", String(result.changed));
  core.setOutput("activity_count", String(result.activityCount));
  core.setOutput("target_file", result.targetFile);
  core.setOutput("result", result.result);
  core.setOutput("commit_sha", result.commitSha || "");
}

/**
 * Write a compact job summary. Failures are non-fatal: summaries are a UI
 * nicety, not part of the action's contract.
 *
 * @param {object} core
 * @param {object} options
 */
async function writeSummary(
  core,
  { config, result, lines, changed, dryRun, commitSha, branch },
) {
  const summary = core.summary;
  if (!summary || typeof summary.addHeading !== "function") {
    return;
  }

  try {
    summary.addHeading("GitHub Activity in README", 2);

    const commitUrl =
      commitSha && config.repoSlug
        ? `${config.serverUrl}/${config.repoSlug}/commit/${commitSha}`
        : null;
    const commitCell = commitSha
      ? commitUrl
        ? `[\`${commitSha.slice(0, 7)}\`](${commitUrl})`
        : `\`${commitSha.slice(0, 7)}\``
      : "—";

    summary.addTable([
      [
        { data: "Setting", header: true },
        { data: "Value", header: true },
      ],
      [
        "Users",
        config.usernames
          .map((user) => `@${escapeMarkdown(user, 40)}`)
          .join(", "),
      ],
      [
        "Target file",
        `\`${escapeMarkdown(config.targetFile.relativePath, 100)}\``,
      ],
      ["Event filter", escapeMarkdown(config.filterEventTypes.join(", "), 300)],
      ["Maximum lines", String(config.maxLines)],
      ["Timestamps", config.showTimestamps ? config.timestampFormat : "off"],
      [
        "Result",
        result === "dry-run" && changed === false
          ? "dry run (no changes written)"
          : result,
      ],
      ["Commit", commitCell],
    ]);

    if (lines.length > 0) {
      summary.addHeading(dryRun ? "Preview (dry run)" : "Activity", 3);
      summary.addRaw(lines.join("\n"), true);
    } else if (result === "unchanged" || dryRun) {
      summary.addRaw(
        "No matching public activity was found; the section was left unchanged.",
        true,
      );
    }

    if (branch) {
      summary.addRaw(`Branch: \`${escapeMarkdown(branch, 100)}\``, true);
    }

    await summary.write();
  } catch (error) {
    core.debug(`Could not write the job summary: ${error.message}`);
  }
}

module.exports = {
  runAction,
  finishWithoutChanges,
  createEmptyCommitIfStale,
  setOutputs,
  writeSummary,
};


/***/ }),

/***/ 283:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const fs = __nccwpck_require__(24);
const path = __nccwpck_require__(760);

const { ConfigError } = __nccwpck_require__(438);
const {
  DEFAULT_FILTER_EVENTS,
  SUPPORTED_EVENT_TYPES,
  resolveEventFilter,
  compileRepoPatterns,
} = __nccwpck_require__(476);
const { parseBoolean, parseInteger, parseList } = __nccwpck_require__(804);

const { version: VERSION } = __nccwpck_require__(330);

const DEFAULTS = Object.freeze({
  GH_USERNAME: "",
  COMMIT_NAME: "github-actions[bot]",
  COMMIT_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  COMMIT_MSG: ":zap: Update README with the recent activity",
  EMPTY_COMMIT_MSG: ":memo: Empty commit to keep the scheduled workflow active",
  MAX_LINES: 5,
  TARGET_FILE: "README.md",
  SECTION_NAME: "activity",
  SHOW_TIMESTAMPS: false,
  TIMESTAMP_FORMAT: "date",
  EMPTY_COMMIT_DAYS: 50,
  FILTER_EVENTS: DEFAULT_FILTER_EVENTS.join(","),
  EXCLUDE_REPOS: "",
  DRY_RUN: false,
});

const INPUT_NAMES = Object.freeze([
  "GH_USERNAME",
  "COMMIT_NAME",
  "COMMIT_EMAIL",
  "COMMIT_MSG",
  "EMPTY_COMMIT_MSG",
  "MAX_LINES",
  "TARGET_FILE",
  "SECTION_NAME",
  "SHOW_TIMESTAMPS",
  "TIMESTAMP_FORMAT",
  "EMPTY_COMMIT_DAYS",
  "FILTER_EVENTS",
  "EXCLUDE_REPOS",
  "DRY_RUN",
  "GITHUB_TOKEN",
]);

const TIMESTAMP_FORMATS = Object.freeze(["date", "datetime", "relative"]);
const MAX_USERNAMES = 10;
const MAX_EVENT_PAGES = 3;
const MAX_LINES_LIMIT = 100;

const USERNAME_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const SECTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/;

/**
 * Read a GitHub Actions input from the environment.
 * GitHub normalises input names to `INPUT_<UPPER_SNAKE_CASE>`.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} name
 * @returns {string}
 */
function getInput(env, name) {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const value = env[key];
  return value === undefined || value === null ? "" : String(value).trim();
}

/**
 * Load and validate every input used by the action. Validation happens before
 * any network or git operation so misconfiguration fails fast and clearly.
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.cwd]
 * @param {boolean} [options.requireToken]
 * @param {Date} [options.now]
 * @returns {object}
 */
function loadConfig({
  env = process.env,
  cwd = process.cwd(),
  requireToken = true,
  now = new Date(),
} = {}) {
  const warnings = [];

  const workspace = path.resolve(env.GITHUB_WORKSPACE || cwd);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new ConfigError(`Workspace directory not found: ${workspace}`, {
      hint: "Run the action from a checked out repository.",
    });
  }

  const usernames = parseUsernames(env);
  const maxLines = parseInteger(
    getInput(env, "MAX_LINES"),
    "MAX_LINES",
    1,
    MAX_LINES_LIMIT,
    DEFAULTS.MAX_LINES,
  );
  const targetFile = resolveTargetFile(
    getInput(env, "TARGET_FILE") || DEFAULTS.TARGET_FILE,
    workspace,
  );

  const sectionName = getInput(env, "SECTION_NAME") || DEFAULTS.SECTION_NAME;
  if (!SECTION_PATTERN.test(sectionName)) {
    throw new ConfigError(`Invalid SECTION_NAME "${sectionName}".`, {
      hint: "Use 1-50 characters: letters, numbers, dashes, and underscores, starting with a letter or number.",
    });
  }

  const rawFilter = getInput(env, "FILTER_EVENTS") || DEFAULTS.FILTER_EVENTS;
  const filterSet = resolveEventFilter(rawFilter, {
    onWarning: (message) => warnings.push(message),
  });
  if (filterSet.size === 0) {
    throw new ConfigError(
      `FILTER_EVENTS does not contain any supported event types (got "${rawFilter}").`,
      {
        hint: `Use a comma separated list of: ${SUPPORTED_EVENT_TYPES.join(", ")}, or "*" for all of them.`,
      },
    );
  }

  const showTimestamps = parseBoolean(
    getInput(env, "SHOW_TIMESTAMPS") || String(DEFAULTS.SHOW_TIMESTAMPS),
    "SHOW_TIMESTAMPS",
  );
  const timestampFormat = (
    getInput(env, "TIMESTAMP_FORMAT") || DEFAULTS.TIMESTAMP_FORMAT
  ).toLowerCase();
  if (!TIMESTAMP_FORMATS.includes(timestampFormat)) {
    throw new ConfigError(`Invalid TIMESTAMP_FORMAT "${timestampFormat}".`, {
      hint: `Choose one of: ${TIMESTAMP_FORMATS.join(", ")}.`,
    });
  }

  const emptyCommitDays = parseInteger(
    getInput(env, "EMPTY_COMMIT_DAYS"),
    "EMPTY_COMMIT_DAYS",
    0,
    3650,
    DEFAULTS.EMPTY_COMMIT_DAYS,
  );

  const excludeRepoPatterns = parseList(
    getInput(env, "EXCLUDE_REPOS") || DEFAULTS.EXCLUDE_REPOS,
  );
  const excludeRepos = compileRepoPatterns(excludeRepoPatterns, (message) =>
    warnings.push(message),
  );

  const commitName = getInput(env, "COMMIT_NAME") || DEFAULTS.COMMIT_NAME;
  const commitEmail = getInput(env, "COMMIT_EMAIL") || DEFAULTS.COMMIT_EMAIL;
  if (!commitEmail.includes("@")) {
    throw new ConfigError(`Invalid COMMIT_EMAIL "${commitEmail}".`, {
      hint: "Use an email address, for example 41898282+github-actions[bot]@users.noreply.github.com.",
    });
  }

  const token =
    getInput(env, "GITHUB_TOKEN") ||
    (env.GITHUB_TOKEN || "").trim() ||
    (env.GH_TOKEN || "").trim();
  if (requireToken && !token) {
    throw new ConfigError("No GitHub token was provided.", {
      hint: "Pass `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` in the workflow env or the action `with` block.",
    });
  }

  const apiUrl = normalizeUrl(
    env.GITHUB_API_URL || "https://api.github.com",
    "GITHUB_API_URL",
  );
  const serverUrl = normalizeUrl(
    env.GITHUB_SERVER_URL || "https://github.com",
    "GITHUB_SERVER_URL",
  );

  return {
    usernames,
    maxLines,
    targetFile,
    sectionName,
    filterSet,
    filterEventTypes: [...filterSet].sort(),
    showTimestamps,
    timestampFormat,
    emptyCommitDays,
    excludeRepos,
    commit: {
      name: commitName,
      email: commitEmail,
      message: getInput(env, "COMMIT_MSG") || DEFAULTS.COMMIT_MSG,
      emptyMessage:
        getInput(env, "EMPTY_COMMIT_MSG") || DEFAULTS.EMPTY_COMMIT_MSG,
    },
    dryRun: parseBoolean(
      getInput(env, "DRY_RUN") || String(DEFAULTS.DRY_RUN),
      "DRY_RUN",
    ),
    token,
    apiUrl,
    serverUrl,
    repoSlug: (env.GITHUB_REPOSITORY || "").trim(),
    userAgent: `github-activity-readme/${VERSION}`,
    requestTimeoutMs: 20_000,
    maxEventPages: MAX_EVENT_PAGES,
    pushRetries: 3,
    now,
    workspace,
    warnings,
  };
}

/**
 * Resolve TARGET_FILE and ensure it stays inside the workspace. Symlinks are
 * resolved so a link cannot point the action at a file outside the checkout.
 *
 * @param {string} rawPath
 * @param {string} workspace
 * @returns {{absolutePath: string, relativePath: string}}
 */
function resolveTargetFile(rawPath, workspace) {
  if (rawPath.includes("\0")) {
    throw new ConfigError("TARGET_FILE contains a null byte.");
  }
  if (path.isAbsolute(rawPath)) {
    throw new ConfigError(
      `TARGET_FILE must be a relative path, got "${rawPath}".`,
      {
        hint: "Use a path relative to the repository root, for example README.md.",
      },
    );
  }

  const absolutePath = path.resolve(workspace, rawPath);
  const relativePath = path.relative(workspace, absolutePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new ConfigError(
      `TARGET_FILE "${rawPath}" resolves outside the repository workspace.`,
    );
  }

  if (!fs.existsSync(absolutePath)) {
    throw new ConfigError(`TARGET_FILE not found: ${relativePath}`, {
      hint: "Check out the repository before running the action, or set TARGET_FILE to an existing file.",
    });
  }
  if (!fs.statSync(absolutePath).isFile()) {
    throw new ConfigError(`TARGET_FILE is not a file: ${relativePath}`);
  }

  let realFile;
  let realWorkspace;
  try {
    realFile = fs.realpathSync(absolutePath);
    realWorkspace = fs.realpathSync(workspace);
  } catch (error) {
    throw new ConfigError(`Could not resolve TARGET_FILE: ${relativePath}`, {
      cause: error,
    });
  }

  const realRelative = path.relative(realWorkspace, realFile);
  if (
    realRelative === ".." ||
    realRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelative)
  ) {
    throw new ConfigError(
      `TARGET_FILE "${rawPath}" is a symlink that points outside the repository.`,
    );
  }

  return {
    absolutePath: realFile,
    relativePath: relativePath.split(path.sep).join("/"),
  };
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
function parseUsernames(env) {
  const raw =
    getInput(env, "GH_USERNAME") ||
    String(env.GITHUB_REPOSITORY_OWNER || "").trim() ||
    String(env.GITHUB_REPOSITORY || "")
      .split("/")[0]
      .trim() ||
    "";

  const usernames = parseList(raw);
  if (usernames.length === 0) {
    throw new ConfigError("GH_USERNAME is required.", {
      hint: "Set GH_USERNAME to your GitHub username, or add the action to a repository so the default repository owner can be used.",
    });
  }
  if (usernames.length > MAX_USERNAMES) {
    throw new ConfigError(
      `GH_USERNAME contains ${usernames.length} usernames; at most ${MAX_USERNAMES} are supported.`,
    );
  }

  const invalid = usernames.filter((name) => !USERNAME_PATTERN.test(name));
  if (invalid.length > 0) {
    throw new ConfigError(
      `Invalid GitHub username${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`,
    );
  }

  return usernames;
}

/**
 * @param {string} value
 * @param {string} name
 * @returns {string}
 */
function normalizeUrl(value, name) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch (error) {
    throw new ConfigError(`Invalid ${name}: "${value}".`, { cause: error });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ConfigError(
      `Invalid ${name}: "${value}" must use http or https.`,
    );
  }
  if (url.username || url.password) {
    throw new ConfigError(
      `${name} must not include credentials; use the GITHUB_TOKEN input instead.`,
    );
  }
  if (url.search || url.hash) {
    throw new ConfigError(
      `${name} must not include a query string or fragment.`,
    );
  }
  return url.toString().replace(/\/+$/, "");
}

module.exports = {
  DEFAULTS,
  INPUT_NAMES,
  TIMESTAMP_FORMATS,
  MAX_EVENT_PAGES,
  MAX_LINES_LIMIT,
  getInput,
  loadConfig,
  parseUsernames,
  resolveTargetFile,
  normalizeUrl,
};


/***/ }),

/***/ 438:
/***/ ((module) => {



/**
 * Base class for all errors that are safe (and useful) to show to action users.
 * Anything that is not an `ActionError` is treated as an unexpected failure and
 * is reported with a generic message plus its stack trace in debug logs.
 */
class ActionError extends Error {
  /**
   * @param {string} message - Human readable error message.
   * @param {object} [options]
   * @param {string} [options.hint] - Actionable next step shown after the message.
   * @param {Error} [options.cause] - Original error, if any.
   * @param {string} [options.code] - Stable machine readable error code.
   */
  constructor(message, { hint, cause, code } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = new.target.name;
    this.hint = hint;
    this.code = code;
  }
}

class ConfigError extends ActionError {}

class SectionError extends ActionError {}

class GitHubApiError extends ActionError {
  constructor(message, { status, hint, cause, code, retryAt } = {}) {
    super(message, { hint, cause, code });
    this.status = status;
    this.retryAt = retryAt;
  }
}

class GitError extends ActionError {
  constructor(
    message,
    { code, stdout, stderr, command, committed, hint } = {},
  ) {
    super(message, {
      hint,
      code: code === undefined ? undefined : String(code),
    });
    this.exitCode = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.command = command;
    this.committed = Boolean(committed);
  }
}

module.exports = {
  ActionError,
  ConfigError,
  SectionError,
  GitHubApiError,
  GitError,
};


/***/ }),

/***/ 476:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const {
  MAX_RELEASE_NAME_LENGTH,
  cleanText,
  escapeMarkdown,
  escapeInlineCode,
  timestampSuffix,
  isPlainObject,
} = __nccwpck_require__(804);

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


/***/ }),

/***/ 661:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const { spawn } = __nccwpck_require__(421);

const { GitError } = __nccwpck_require__(438);
const { redactSecrets, sleep: defaultSleep } = __nccwpck_require__(804);

const OUTPUT_LIMIT_BYTES = 512 * 1024;
const BACKOFF_BASE_MS = 1_000;

/**
 * Run a git command without a shell.
 *
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {number[]} [options.allowExitCodes]
 * @param {string[]} [options.secrets]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runGit(
  args,
  {
    cwd = process.cwd(),
    env = {},
    timeoutMs = 60_000,
    allowExitCodes = [],
    secrets = [],
    onDebug,
  } = {},
) {
  const command = formatCommand(args);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    onDebug?.(`Running: ${redactSecrets(command, secrets)}`);

    let child;
    try {
      child = spawn("git", args, {
        cwd,
        env: {
          ...process.env,
          ...env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          PAGER: "cat",
          LC_ALL: process.env.LC_ALL || "C",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        killSignal: "SIGTERM",
        windowsHide: true,
      });
    } catch (error) {
      reject(
        new GitError(`Could not start git: ${error.message}`, {
          cause: error,
          command: redactSecrets(command, secrets),
        }),
      );
      return;
    }

    child.stdout?.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      const message =
        error.code === "ENOENT"
          ? "The git executable was not found."
          : `Could not run git: ${error.message}`;
      reject(
        new GitError(message, {
          cause: error,
          code: error.code,
          command: redactSecrets(command, secrets),
          stdout: redactSecrets(stdout, secrets),
          stderr: redactSecrets(stderr, secrets),
          hint:
            error.code === "ENOENT"
              ? "Install git and make sure it is available on PATH. GitHub-hosted runners include git."
              : undefined,
        }),
      );
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;

      const safeStdout = redactSecrets(stdout, secrets);
      const safeStderr = redactSecrets(stderr, secrets);
      const succeeded = code === 0 || allowExitCodes.includes(code);

      if (succeeded) {
        resolve({ code, stdout: safeStdout, stderr: safeStderr });
        return;
      }

      const output = (safeStderr.trim() || safeStdout.trim()).slice(0, 2000);
      const reason =
        signal === "SIGTERM"
          ? `timed out after ${timeoutMs}ms`
          : `exited with code ${code}`;
      reject(
        new GitError(
          `git ${args[0] || ""} ${reason}${output ? `: ${output}` : ""}`.trim(),
          {
            code,
            stdout: safeStdout,
            stderr: safeStderr,
            command: redactSecrets(command, secrets),
            hint: gitHintFor(output),
          },
        ),
      );
    });
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {Function} [options.run]
 * @param {string[]} [options.secrets]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {Promise<string|null>}
 */
async function getCurrentBranch({
  cwd,
  run = runGit,
  secrets = [],
  onDebug,
} = {}) {
  const result = await run(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    allowExitCodes: [1, 128],
    secrets,
    onDebug,
  });

  if (result.code !== 0) {
    return null;
  }
  const branch = result.stdout.trim();
  return branch || null;
}

/**
 * @param {object} options
 * @param {string} options.file
 * @param {object} [options.runGitOptions]
 * @returns {Promise<boolean>}
 */
async function hasStagedChanges(file, { run = runGit, ...options } = {}) {
  const result = await run(["diff", "--cached", "--quiet", "--", file], {
    ...options,
    allowExitCodes: [1],
  });
  return result.code === 1;
}

/**
 * Stage a single file. `--` prevents a filename that starts with `-` from
 * being interpreted as an option.
 *
 * @param {string} file
 * @param {object} [options]
 * @returns {Promise<void>}
 */
async function stageFile(file, { run = runGit, ...options } = {}) {
  await run(["add", "--", file], options);
}

/**
 * @param {object} [options]
 * @returns {Promise<string|null>}
 */
async function getHeadSha({ run = runGit, ...options } = {}) {
  try {
    const result = await run(["rev-parse", "HEAD"], options);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Commit changes to a single file (or create an empty commit).
 *
 * Only the target file is committed, so unrelated staged changes from earlier
 * workflow steps are not swept into the activity commit.
 *
 * @param {object} options
 * @param {string} options.file
 * @param {string} options.message
 * @param {string} options.name
 * @param {string} options.email
 * @param {boolean} [options.allowEmpty]
 * @param {string} [options.cwd]
 * @param {Function} [options.run]
 * @param {string[]} [options.secrets]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {Promise<{committed: boolean, sha: string|null}>}
 */
async function commitFile({
  file,
  message,
  name,
  email,
  allowEmpty = false,
  cwd,
  run = runGit,
  secrets = [],
  onDebug,
}) {
  const base = { cwd, secrets, onDebug };

  if (!allowEmpty) {
    await stageFile(file, { ...base, run });
    const staged = await hasStagedChanges(file, { ...base, run });
    if (!staged) {
      return { committed: false, sha: await getHeadSha({ ...base, run }) };
    }
  }

  const args = [
    "-c",
    `user.name=${name}`,
    "-c",
    `user.email=${email}`,
    "commit",
    ...(allowEmpty ? ["--allow-empty"] : ["--only"]),
    "-m",
    message,
    ...(allowEmpty ? [] : ["--", file]),
  ];

  await run(args, { ...base, timeoutMs: 120_000 });
  return { committed: true, sha: await getHeadSha({ ...base, run }) };
}

/**
 * Push the current commit to the branch checked out in the workflow.
 * If another run pushed in the meantime, rebase and retry.
 *
 * @param {object} options
 * @param {string} options.branch
 * @param {string} [options.cwd]
 * @param {number} [options.retries]
 * @param {Function} [options.run]
 * @param {Function} [options.sleep]
 * @param {string[]} [options.secrets]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {Promise<void>}
 */
async function pushBranch({
  branch,
  name,
  email,
  cwd,
  retries = 3,
  run = runGit,
  sleep = defaultSleep,
  secrets = [],
  onDebug,
}) {
  if (!branch) {
    throw new GitError(
      "Cannot push because the repository is in detached HEAD state.",
      {
        hint: "Use actions/checkout with a branch ref (the default for scheduled workflows) so the action can push to it.",
      },
    );
  }

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await run(["push", "origin", `HEAD:refs/heads/${branch}`], {
        cwd,
        timeoutMs: 120_000,
        secrets,
        onDebug,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isNonFastForward(error)) {
        throw error;
      }

      onDebug?.(
        `Push was rejected (attempt ${attempt + 1}/${retries + 1}); rebasing on origin/${branch}.`,
      );

      const identityArgs =
        name && email
          ? ["-c", `user.name=${name}`, "-c", `user.email=${email}`]
          : [];

      try {
        await run(
          [
            ...identityArgs,
            "pull",
            "--rebase",
            "--autostash",
            "origin",
            branch,
          ],
          { cwd, timeoutMs: 120_000, secrets, onDebug },
        );
      } catch (pullError) {
        await run(["rebase", "--abort"], {
          cwd,
          allowExitCodes: [1, 128],
          secrets,
          onDebug,
        }).catch(() => {});
        throw new GitError(
          `Could not rebase local changes on origin/${branch}: ${pullError.message}`,
          {
            cause: pullError,
            hint: "Another workflow run may have updated the same file. Re-run the workflow; if the conflict persists, commit or discard local changes.",
          },
        );
      }

      await sleep(BACKOFF_BASE_MS * (attempt + 1));
    }
  }

  throw lastError;
}

/**
 * @param {object} options
 * @param {string} options.file
 * @param {string} options.message
 * @param {string} options.name
 * @param {string} options.email
 * @param {string} options.branch
 * @param {boolean} [options.allowEmpty]
 * @param {number} [options.retries]
 * @param {string} [options.cwd]
 * @param {Function} [options.run]
 * @param {Function} [options.sleep]
 * @param {string[]} [options.secrets]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {Promise<{committed: boolean, pushed: boolean, sha: string|null}>}
 */
async function commitAndPush({
  file,
  message,
  name,
  email,
  branch,
  allowEmpty = false,
  retries = 3,
  cwd,
  run = runGit,
  sleep = defaultSleep,
  secrets = [],
  onDebug,
}) {
  const commit = await commitFile({
    file,
    message,
    name,
    email,
    allowEmpty,
    cwd,
    run,
    secrets,
    onDebug,
  });

  if (!commit.committed) {
    return { committed: false, pushed: false, sha: commit.sha };
  }

  try {
    await pushBranch({
      branch,
      name,
      email,
      cwd,
      retries,
      run,
      sleep,
      secrets,
      onDebug,
    });
  } catch (error) {
    if (error instanceof GitError) {
      error.committed = true;
    }
    throw error;
  }

  return { committed: true, pushed: true, sha: commit.sha };
}

/**
 * Age of the newest commit on the current branch, in days.
 *
 * @param {object} options
 * @param {Date} [options.now]
 * @param {string} [options.cwd]
 * @param {Function} [options.run]
 * @param {string[]} [options.secrets]
 * @returns {Promise<number|null>}
 */
async function getLastCommitAgeDays({
  now = new Date(),
  cwd,
  run = runGit,
  secrets = [],
} = {}) {
  let result;
  try {
    result = await run(["log", "-1", "--format=%ct"], {
      cwd,
      allowExitCodes: [128],
      secrets,
    });
  } catch {
    return null;
  }

  if (result.code !== 0) {
    return null;
  }

  const seconds = Number(result.stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return (now.getTime() / 1000 - seconds) / (60 * 60 * 24);
}

/**
 * @param {GitError} error
 * @returns {boolean}
 */
function isNonFastForward(error) {
  const text = `${error?.stderr || ""}\n${error?.stdout || ""}\n${error?.message || ""}`;
  return /non-fast-forward|fetch first|Updates were rejected|failed to push some refs|rejected/i.test(
    text,
  );
}

/**
 * @param {string} output
 * @returns {string|undefined}
 */
function gitHintFor(output) {
  if (
    /Permission denied|Authentication failed|could not read Username|terminal prompts disabled/i.test(
      output,
    )
  ) {
    return "The workflow token cannot push. Add `permissions: contents: write` and use actions/checkout with persist-credentials enabled.";
  }
  if (/protected branch|GH006|required status/i.test(output)) {
    return "The target branch is protected. Allow the GitHub Actions bot to push, or run the action against an unprotected branch.";
  }
  if (/pre-commit|husky|lint-staged|hook/i.test(output)) {
    return "A git hook rejected the commit. Fix the reported hook error or disable the hook for automated commits.";
  }
  return undefined;
}

/**
 * @param {string} current
 * @param {Buffer|string} chunk
 * @returns {string}
 */
function appendLimited(current, chunk) {
  const next = current + chunk.toString();
  return next.length > OUTPUT_LIMIT_BYTES
    ? next.slice(next.length - OUTPUT_LIMIT_BYTES)
    : next;
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function formatCommand(args) {
  return `git ${args
    .map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg))
    .join(" ")}`;
}

module.exports = {
  runGit,
  getCurrentBranch,
  hasStagedChanges,
  stageFile,
  getHeadSha,
  commitFile,
  pushBranch,
  commitAndPush,
  getLastCommitAgeDays,
  isNonFastForward,
  formatCommand,
  appendLimited,
};


/***/ }),

/***/ 474:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const { GitHubApiError } = __nccwpck_require__(438);
const { compareEvents, dedupeById, sleep: defaultSleep } = __nccwpck_require__(804);
const { selectEvents } = __nccwpck_require__(476);

const PER_PAGE = 100;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 8_000;

/**
 * Minimal GitHub REST client built on the Node.js fetch implementation.
 *
 * Using fetch instead of a full Octokit bundle keeps the action small and fast
 * while still supporting retries, rate-limit handling, timeouts, and GHES.
 *
 * @param {object} options
 * @param {string} [options.token]
 * @param {string} options.apiUrl
 * @param {string} options.userAgent
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxRetries]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {{request: Function, listPublicEvents: Function}}
 */
function createGitHubClient({
  token,
  apiUrl,
  userAgent,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  maxRetries = 3,
  sleep = defaultSleep,
  onDebug,
}) {
  if (typeof fetchImpl !== "function") {
    throw new GitHubApiError(
      "No fetch implementation is available. Node.js 18 or newer is required.",
    );
  }

  const baseUrl = String(apiUrl).replace(/\/+$/, "");

  /**
   * @param {string} pathname
   * @param {object} [options]
   * @param {Record<string, string|number>} [options.params]
   * @param {string} [options.context]
   * @returns {Promise<unknown>}
   */
  async function request(pathname, { params = {}, context = "" } = {}) {
    const url = new URL(
      `${baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`,
    );
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": userAgent || "github-activity-readme",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const label = context ? `${context}: ` : "";
    let attempt = 0;

    while (attempt <= maxRetries) {
      let response;
      try {
        response = await fetchImpl(url.toString(), {
          method: "GET",
          headers,
          signal: createTimeoutSignal(timeoutMs),
        });
      } catch (error) {
        if (attempt >= maxRetries) {
          throw new GitHubApiError(`${label}Could not reach the GitHub API.`, {
            cause: error,
            hint: "Check network connectivity, proxy settings, and GITHUB_API_URL. On self-hosted runners behind a proxy, set NODE_USE_ENV_PROXY=1.",
          });
        }
        const delay = backoff(attempt);
        onDebug?.(
          `${label}Network error, retrying in ${delay}ms (${attempt + 1}/${maxRetries}).`,
        );
        await sleep(delay);
        attempt += 1;
        continue;
      }

      if (response.ok) {
        try {
          return await response.json();
        } catch (error) {
          throw new GitHubApiError(
            `${label}GitHub API returned invalid JSON.`,
            {
              cause: error,
              status: response.status,
            },
          );
        }
      }

      const status = response.status;
      const errorBody = await readErrorBody(response);
      const apiMessage = errorBody.message ? ` ${errorBody.message}` : "";
      const hintSuffix = errorBody.documentation_url
        ? ` Documentation: ${errorBody.documentation_url}`
        : "";

      if (status === 401) {
        throw new GitHubApiError(
          `${label}GitHub rejected the token (401).${apiMessage}`,
          {
            status,
            code: "UNAUTHORIZED",
            hint: "Check that GITHUB_TOKEN is set, has not expired, and belongs to this repository/organization.",
          },
        );
      }

      if (status === 404) {
        throw new GitHubApiError(
          `${label}GitHub resource not found (404).${apiMessage}`,
          {
            status,
            code: "NOT_FOUND",
            hint: "Check GH_USERNAME. For private organization activity, the token must be able to see the repository and the organization may need to allow third-party access.",
          },
        );
      }

      if (status === 403 || status === 429) {
        const rateLimit = getRateLimitInfo(response.headers);
        const isRateLimited = status === 429 || rateLimit.remaining === 0;

        if (!isRateLimited) {
          throw new GitHubApiError(
            `${label}GitHub refused the request (${status}).${apiMessage}`,
            {
              status,
              code: "FORBIDDEN",
              hint: "Grant the workflow `permissions: contents: write` and make sure the token can read the requested public events.",
            },
          );
        }

        const waitMs = rateLimit.waitMs ?? BACKOFF_BASE_MS;
        if (waitMs <= MAX_RATE_LIMIT_WAIT_MS && attempt < maxRetries) {
          onDebug?.(
            `${label}Rate limited. Waiting ${waitMs}ms before retry (${attempt + 1}/${maxRetries}).`,
          );
          await sleep(waitMs);
          attempt += 1;
          continue;
        }

        throw new GitHubApiError(
          `${label}GitHub API rate limit exceeded.${apiMessage}`,
          {
            status,
            code: "RATE_LIMITED",
            retryAt: rateLimit.resetAt,
            hint: rateLimit.resetAt
              ? `The limit resets at ${rateLimit.resetAt.toISOString()}. The next scheduled run will pick up where this one stopped.`
              : "Wait for the rate limit to reset, or use a token with a higher limit.",
          },
        );
      }

      if (status >= 500 && attempt < maxRetries) {
        const delay = backoff(attempt);
        onDebug?.(
          `${label}GitHub API returned ${status}, retrying in ${delay}ms (${attempt + 1}/${maxRetries}).`,
        );
        await sleep(delay);
        attempt += 1;
        continue;
      }

      throw new GitHubApiError(
        `${label}GitHub API request failed (${status}).${apiMessage}${hintSuffix}`,
        { status, code: "HTTP_ERROR" },
      );
    }

    throw new GitHubApiError(
      `${label}GitHub API request failed after retries.`,
    );
  }

  /**
   * @param {string} username
   * @param {number} [page]
   * @param {number} [perPage]
   * @returns {Promise<object[]>}
   */
  async function listPublicEvents(username, page = 1, perPage = PER_PAGE) {
    const data = await request(
      `/users/${encodeURIComponent(username)}/events/public`,
      {
        params: { per_page: perPage, page },
        context: `Fetching public events for @${username}`,
      },
    );

    if (!Array.isArray(data)) {
      throw new GitHubApiError(
        `Unexpected non-list response while fetching events for @${username}.`,
        {
          hint: "The GitHub API returned a non-list response; this usually means GITHUB_API_URL points at a non-GitHub service.",
        },
      );
    }
    return data;
  }

  return { request, listPublicEvents };
}

/**
 * Fetch, filter, merge, sort, and trim recent activity for one or more users.
 *
 * Each user is fetched independently (in parallel) and up to `maxLines`
 * matching events are collected per user. Because every user contributes at
 * most `maxLines` events, the merged top `maxLines` is correct while keeping
 * the number of API requests low. Pagination refills the list when noisy or
 * filtered events would otherwise leave the section short.
 *
 * @param {object} options
 * @param {{listPublicEvents: Function}} options.client
 * @param {string[]} options.usernames
 * @param {Set<string>} options.filter
 * @param {Array<{pattern: string, regex: RegExp}>} [options.excludeRepos]
 * @param {number} [options.maxLines]
 * @param {number} [options.maxPages]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {Promise<{events: object[], scanned: number, pages: number}>}
 */
async function fetchActivity({
  client,
  usernames,
  filter,
  excludeRepos = [],
  maxLines = 5,
  maxPages = 3,
  onDebug,
}) {
  let scanned = 0;
  let pages = 0;

  const perUser = await Promise.all(
    usernames.map(async (username) => {
      const selected = [];

      for (let page = 1; page <= maxPages; page += 1) {
        const events = await client.listPublicEvents(username, page, PER_PAGE);
        pages += 1;
        scanned += events.length;
        selected.push(...selectEvents(events, { filter, excludeRepos }));

        onDebug?.(
          `@${username} page ${page}: ${events.length} events, ${selected.length} matching so far.`,
        );

        if (selected.length >= maxLines || events.length < PER_PAGE) {
          break;
        }
      }

      return selected;
    }),
  );

  const events = dedupeById(perUser.flat())
    .sort(compareEvents)
    .slice(0, maxLines);

  return { events, scanned, pages };
}

/**
 * @param {number} timeoutMs
 * @returns {AbortSignal|undefined}
 */
function createTimeoutSignal(timeoutMs) {
  if (
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
  ) {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

/**
 * @param {Headers|Record<string, string>|undefined} headers
 * @returns {{remaining: number|null, waitMs: number|null, resetAt: Date|null}}
 */
function getRateLimitInfo(headers) {
  const remainingRaw = headerValue(headers, "x-ratelimit-remaining");
  const remaining =
    remainingRaw === null || remainingRaw === "" ? null : Number(remainingRaw);

  const resetRaw = headerValue(headers, "x-ratelimit-reset");
  const resetSeconds = resetRaw === null ? NaN : Number(resetRaw);
  const resetAt = Number.isFinite(resetSeconds)
    ? new Date(resetSeconds * 1000)
    : null;

  const retryAfterRaw = headerValue(headers, "retry-after");
  let waitMs = null;
  if (retryAfterRaw !== null && retryAfterRaw !== "") {
    const seconds = Number(retryAfterRaw);
    if (Number.isFinite(seconds)) {
      waitMs = Math.max(0, seconds * 1000);
    }
  } else if (resetAt) {
    waitMs = Math.max(0, resetAt.getTime() - Date.now());
  }

  return {
    remaining: Number.isFinite(remaining) ? remaining : null,
    waitMs,
    resetAt,
  };
}

/**
 * @param {unknown} headers
 * @param {string} name
 * @returns {string|null}
 */
function headerValue(headers, name) {
  if (!headers) {
    return null;
  }
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value === undefined ? null : value;
  }
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? null : String(headers[key]);
}

/**
 * @param {Response} response
 * @returns {Promise<{message?: string, documentation_url?: string}>}
 */
async function readErrorBody(response) {
  try {
    if (typeof response.json === "function") {
      const data = await response.json();
      if (data && typeof data === "object") {
        return {
          message: typeof data.message === "string" ? data.message : undefined,
          documentation_url:
            typeof data.documentation_url === "string"
              ? data.documentation_url
              : undefined,
        };
      }
    }
  } catch {
    // The response body is optional; the status code is enough.
  }
  return {};
}

/**
 * @param {number} attempt
 * @returns {number}
 */
function backoff(attempt) {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

module.exports = {
  PER_PAGE,
  createGitHubClient,
  fetchActivity,
  getRateLimitInfo,
  headerValue,
  backoff,
};


/***/ }),

/***/ 33:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const fs = __nccwpck_require__(24);
const crypto = __nccwpck_require__(598);

/**
 * A tiny, dependency-free implementation of the GitHub Actions toolkit
 * interface used by this action.
 *
 * Replacing `@actions/core` removes ~1 MB of bundled HTTP/undici code from the
 * action, which makes startup faster and keeps the supply chain small. The
 * workflow command format is documented by GitHub:
 * https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {NodeJS.WritableStream} [options.stdout]
 * @param {NodeJS.WritableStream} [options.stderr]
 * @returns {object}
 */
function createLogger({
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const inActions = env.GITHUB_ACTIONS === "true";
  const summary = createSummary(env);

  /**
   * Write plain log output. Lines that begin with `::` are prefixed with a
   * space so untrusted content (for example a release name) cannot inject
   * workflow commands into the runner's stdout parser.
   *
   * @param {unknown} message
   */
  function writeLog(message) {
    const text = String(message ?? "");
    for (const line of text.split(/\r?\n/)) {
      stdout.write(`${line.startsWith("::") ? ` ${line}` : line}\n`);
    }
  }

  /**
   * @param {string} command
   * @param {unknown} message
   */
  function issueCommand(command, message) {
    if (!inActions) {
      return;
    }
    stdout.write(`::${command}::${escapeData(message)}\n`);
  }

  return {
    info: writeLog,
    debug(message) {
      if (inActions) {
        issueCommand("debug", message);
      } else if (env.RUNNER_DEBUG === "1") {
        writeLog(`[debug] ${message}`);
      }
    },
    warning(message) {
      if (inActions) {
        issueCommand("warning", message);
      } else {
        stderr.write(`Warning: ${String(message ?? "")}\n`);
      }
    },
    error(message) {
      if (inActions) {
        issueCommand("error", message);
      } else {
        stderr.write(`Error: ${String(message ?? "")}\n`);
      }
    },
    notice(message) {
      if (inActions) {
        issueCommand("notice", message);
      } else {
        writeLog(message);
      }
    },
    setSecret(secret) {
      if (!inActions || !secret) {
        return;
      }
      stdout.write(`::add-mask::${escapeData(secret)}\n`);
    },
    setOutput(name, value) {
      if (!env.GITHUB_OUTPUT) {
        return;
      }
      try {
        const delimiter = `ghadelimiter_${crypto.randomUUID()}`;
        fs.appendFileSync(
          env.GITHUB_OUTPUT,
          `${name}<<${delimiter}\n${String(value ?? "")}\n${delimiter}\n`,
          "utf8",
        );
      } catch (error) {
        this.warning(`Could not write the "${name}" output: ${error.message}`);
      }
    },
    setFailed(message) {
      this.error(message);
      process.exitCode = 1;
    },
    startGroup(name) {
      if (inActions) {
        issueCommand("group", name);
      } else {
        writeLog(name);
      }
    },
    endGroup() {
      if (inActions) {
        issueCommand("endgroup", "");
      }
    },
    summary,
  };
}

/**
 * Minimal job-summary builder compatible with `@actions/core`'s summary API
 * for the methods this action uses (addHeading/addTable/addRaw/write).
 *
 * @param {Record<string, string|undefined>} env
 * @returns {object}
 */
function createSummary(env) {
  let parts = [];

  return {
    addHeading(text, level = 1) {
      parts.push(`${"#".repeat(Math.min(6, Math.max(1, level)))} ${text}`);
      return this;
    },
    addTable(rows) {
      if (!Array.isArray(rows) || rows.length === 0) {
        return this;
      }

      const normalized = rows.map((row) =>
        (Array.isArray(row) ? row : [row]).map((cell) => {
          const value =
            cell && typeof cell === "object" && "data" in cell
              ? cell.data
              : cell;
          return String(value ?? "")
            .replace(/\r?\n/g, " ")
            .replace(/\|/g, "\\|");
        }),
      );

      const header = normalized[0];
      parts.push(
        [
          `| ${header.join(" | ")} |`,
          `| ${header.map(() => "---").join(" | ")} |`,
          ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
        ].join("\n"),
      );
      return this;
    },
    addRaw(text) {
      parts.push(String(text ?? ""));
      return this;
    },
    addEOL() {
      parts.push("");
      return this;
    },
    async write() {
      if (!env.GITHUB_STEP_SUMMARY || parts.length === 0) {
        parts = [];
        return this;
      }
      try {
        fs.appendFileSync(
          env.GITHUB_STEP_SUMMARY,
          `${parts.join("\n\n")}\n`,
          "utf8",
        );
      } catch {
        // A missing or read-only summary file is not worth failing the action.
      }
      parts = [];
      return this;
    },
  };
}

/**
 * Escape a workflow-command message.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeData(value) {
  return String(value ?? "")
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

/**
 * Escape a workflow-command property value.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

module.exports = {
  createLogger,
  createSummary,
  escapeData,
  escapeProperty,
};


/***/ }),

/***/ 38:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const { SectionError } = __nccwpck_require__(438);

const DEFAULT_SECTION_NAME = "activity";

/**
 * Find the START/END markers for a managed section, ignoring anything inside
 * fenced code blocks (where README authors often quote the marker syntax).
 *
 * @param {string[]} lines
 * @param {string} sectionName
 * @returns {{starts: number[], ends: number[]}}
 */
function findMarkers(lines, sectionName = DEFAULT_SECTION_NAME) {
  const startPattern = markerPattern("START", sectionName);
  const endPattern = markerPattern("END", sectionName);
  const starts = [];
  const ends = [];
  let fence = null;

  lines.forEach((line, index) => {
    if (fence) {
      const closing = line.trim().match(/^(`{3,}|~{3,})\s*$/);
      if (
        closing &&
        closing[1][0] === fence.character &&
        closing[1].length >= fence.length
      ) {
        fence = null;
      }
      return;
    }

    const opening = line.match(/^\s*(`{3,}|~{3,})/);
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      return;
    }

    if (startPattern.test(line)) {
      starts.push(index);
    } else if (endPattern.test(line)) {
      ends.push(index);
    }
  });

  return { starts, ends };
}

/**
 * Read the current contents of a managed section.
 *
 * @param {string} text
 * @param {string} [sectionName]
 * @returns {{found: boolean, startIndex: number, endIndex: number, body: string[]}}
 */
function readSection(text, sectionName = DEFAULT_SECTION_NAME) {
  const document = parseDocument(text);
  const { starts, ends } = findMarkers(document.lines, sectionName);

  if (starts.length === 0) {
    return { found: false, startIndex: -1, endIndex: -1, body: [] };
  }

  const startIndex = starts[0];
  const endIndex = ends.find((index) => index > startIndex);
  return {
    found: true,
    startIndex,
    endIndex: endIndex === undefined ? -1 : endIndex,
    body:
      endIndex === undefined
        ? []
        : document.lines.slice(startIndex + 1, endIndex),
  };
}

/**
 * Replace (or create) the managed activity section.
 *
 * The rest of the file - including a trailing newline, CRLF line endings, a
 * UTF-8 BOM, and blank lines around the section - is preserved. If the END
 * marker is missing it is inserted immediately after the generated list,
 * leaving any existing content below the section untouched.
 *
 * @param {string} text
 * @param {object} options
 * @param {string} [options.sectionName]
 * @param {string[]} options.lines - Already formatted activity lines.
 * @returns {{
 *   found: boolean,
 *   changed: boolean,
 *   text: string,
 *   startIndex: number,
 *   endIndex: number,
 *   insertedEndMarker: boolean
 * }}
 */
function replaceSection(
  text,
  { sectionName = DEFAULT_SECTION_NAME, lines: activityLines = [] } = {},
) {
  if (!sectionName || typeof sectionName !== "string") {
    throw new SectionError("A SECTION_NAME is required.");
  }

  const document = parseDocument(text);
  const { starts, ends } = findMarkers(document.lines, sectionName);

  if (starts.length === 0) {
    return {
      found: false,
      changed: false,
      text,
      startIndex: -1,
      endIndex: -1,
      insertedEndMarker: false,
    };
  }

  if (starts.length > 1) {
    throw new SectionError(
      `Found ${starts.length} START markers for section "${sectionName}" (lines ${starts
        .map((index) => index + 1)
        .join(", ")}).`,
      {
        hint: "Keep exactly one START/END marker pair per SECTION_NAME. Use multiple action steps with different SECTION_NAME values for multiple sections.",
      },
    );
  }
  if (ends.length > 1) {
    throw new SectionError(
      `Found ${ends.length} END markers for section "${sectionName}" (lines ${ends
        .map((index) => index + 1)
        .join(", ")}).`,
      {
        hint: "Keep exactly one START/END marker pair per SECTION_NAME.",
      },
    );
  }

  const startIndex = starts[0];
  const endIndex = ends[0];

  if (endIndex !== undefined && endIndex < startIndex) {
    throw new SectionError(
      `The END marker for section "${sectionName}" appears before its START marker.`,
      {
        hint: "Place <!--END_SECTION:activity--> after <!--START_SECTION:activity-->.",
      },
    );
  }

  if (endIndex === undefined) {
    const endMarker = `<!--END_SECTION:${sectionName}-->`;
    const newLines = [
      ...document.lines.slice(0, startIndex + 1),
      ...activityLines,
      endMarker,
      ...document.lines.slice(startIndex + 1),
    ];
    const nextText = serializeDocument(newLines, document);

    return {
      found: true,
      changed: nextText !== text,
      text: nextText,
      startIndex,
      endIndex: startIndex + 1 + activityLines.length,
      insertedEndMarker: true,
    };
  }

  const existing = document.lines.slice(startIndex + 1, endIndex);
  const leadingBlank = existing.length > 0 && existing[0].trim() === "";
  const trailingBlank =
    existing.length > (leadingBlank ? 1 : 0) &&
    existing[existing.length - 1].trim() === "";

  const replacement = [
    ...(leadingBlank ? [""] : []),
    ...activityLines,
    ...(trailingBlank ? [""] : []),
  ];

  const newLines = [
    ...document.lines.slice(0, startIndex + 1),
    ...replacement,
    ...document.lines.slice(endIndex),
  ];
  const nextText = serializeDocument(newLines, document);

  return {
    found: true,
    changed: nextText !== text,
    text: nextText,
    startIndex,
    endIndex,
    insertedEndMarker: false,
  };
}

/**
 * Add `1. `, `2. `, ... prefixes to activity lines.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function buildSectionLines(lines) {
  return lines.map((line, index) => `${index + 1}. ${line}`);
}

/**
 * @param {string} text
 * @returns {{bom: boolean, eol: string, trailingNewline: boolean, lines: string[]}}
 */
function parseDocument(text) {
  const value = typeof text === "string" ? text : "";
  const bom = value.startsWith("\uFEFF");
  const body = bom ? value.slice(1) : value;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = body.endsWith("\n");
  const lines = body.split(/\r?\n/);
  if (trailingNewline) {
    lines.pop();
  }
  return { bom, eol, trailingNewline, lines };
}

/**
 * @param {string[]} lines
 * @param {{bom: boolean, eol: string, trailingNewline: boolean}} document
 * @returns {string}
 */
function serializeDocument(lines, document) {
  const body =
    lines.join(document.eol) + (document.trailingNewline ? document.eol : "");
  return `${document.bom ? "\uFEFF" : ""}${body}`;
}

/**
 * @param {"START"|"END"} kind
 * @param {string} sectionName
 * @returns {RegExp}
 */
function markerPattern(kind, sectionName) {
  return new RegExp(
    `^\\s*<!--\\s*${kind}_SECTION\\s*:\\s*${escapeRegExp(sectionName)}\\s*-->\\s*$`,
    "i",
  );
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  DEFAULT_SECTION_NAME,
  findMarkers,
  readSection,
  replaceSection,
  buildSectionLines,
  parseDocument,
  serializeDocument,
};


/***/ }),

/***/ 804:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const MAX_DISPLAY_LENGTH = 80;
const MAX_RELEASE_NAME_LENGTH = 60;

/**
 * Collapse whitespace and control characters, then truncate a value.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
function cleanText(value, maxLength = MAX_DISPLAY_LENGTH) {
  if (value === null || value === undefined) {
    return "";
  }

  const normalized = String(value)
    // Control characters (including newlines and tabs) have no place in a
    // single line markdown list item.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/**
 * Escape text so that untrusted values (release names, labels, ...) cannot
 * introduce HTML or markdown into the generated section.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
function escapeMarkdown(value, maxLength = MAX_DISPLAY_LENGTH) {
  return cleanText(value, maxLength)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]()~|])/g, "\\$1");
}

/**
 * Escape text for use inside an inline code span.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
function escapeInlineCode(value, maxLength = MAX_DISPLAY_LENGTH) {
  return cleanText(value, maxLength).replace(/`/g, "'");
}

/**
 * Format a short, human friendly, markdown-safe date.
 *
 * @param {string|number|Date} value
 * @param {"date"|"datetime"|"relative"} format
 * @param {Date} [now]
 * @returns {string}
 */
function formatTimestamp(value, format = "date", now = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  switch (format) {
    case "datetime": {
      const iso = date.toISOString(); // 2026-10-21T12:34:56.000Z
      return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
    }
    case "relative":
      return formatRelativeTime(date, now);
    case "date":
    default:
      return date.toISOString().slice(0, 10);
  }
}

/**
 * Render a "<sub>…</sub>" timestamp suffix, or an empty string when disabled.
 *
 * @param {string|number|Date} value
 * @param {object} options
 * @param {boolean} options.showTimestamps
 * @param {"date"|"datetime"|"relative"} options.timestampFormat
 * @param {Date} options.now
 * @returns {string}
 */
function timestampSuffix(value, { showTimestamps, timestampFormat, now }) {
  if (!showTimestamps) {
    return "";
  }
  const formatted = formatTimestamp(value, timestampFormat, now);
  return formatted ? ` · <sub>${escapeMarkdown(formatted, 40)}</sub>` : "";
}

/**
 * @param {Date} date
 * @param {Date} now
 * @returns {string}
 */
function formatRelativeTime(date, now = new Date()) {
  const elapsedMs = now.getTime() - date.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return "just now";
  }

  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 45) {
    return "just now";
  }

  const units = [
    { limit: 90, divisor: 60, singular: "minute" },
    { limit: 45 * 60, divisor: 60, singular: "minute" },
    { limit: 90 * 60, divisor: 60 * 60, singular: "hour" },
    { limit: 22 * 60 * 60, divisor: 60 * 60, singular: "hour" },
    { limit: 36 * 60 * 60, divisor: 24 * 60 * 60, singular: "day" },
    { limit: 26 * 24 * 60 * 60, divisor: 24 * 60 * 60, singular: "day" },
    {
      limit: 45 * 24 * 60 * 60,
      divisor: 30 * 24 * 60 * 60,
      singular: "month",
    },
    {
      limit: 320 * 24 * 60 * 60,
      divisor: 30 * 24 * 60 * 60,
      singular: "month",
    },
    {
      limit: 548 * 24 * 60 * 60,
      divisor: 365 * 24 * 60 * 60,
      singular: "year",
    },
  ];

  for (const unit of units) {
    if (seconds < unit.limit) {
      const count = Math.max(1, Math.round(seconds / unit.divisor));
      return `${count} ${unit.singular}${count === 1 ? "" : "s"} ago`;
    }
  }

  const years = Math.max(1, Math.round(seconds / (365 * 24 * 60 * 60)));
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/**
 * Parse a GitHub Actions style boolean input.
 *
 * @param {unknown} value
 * @param {string} name - Name used in error messages.
 * @returns {boolean}
 */
function parseBoolean(value, name) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off", ""].includes(normalized)) {
    return false;
  }

  const { ConfigError } = __nccwpck_require__(438);
  throw new ConfigError(
    `Invalid value for ${name}: "${value}". Use true or false.`,
  );
}

/**
 * Parse an integer input within an inclusive range.
 *
 * @param {unknown} value
 * @param {string} name
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function parseInteger(value, name, min, max, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const parsed = Number(String(value).trim());
  const { ConfigError } = __nccwpck_require__(438);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(
      `Invalid value for ${name}: "${value}". Use an integer.`,
    );
  }
  if (parsed < min || parsed > max) {
    throw new ConfigError(
      `Invalid value for ${name}: ${parsed}. Use an integer between ${min} and ${max}.`,
    );
  }

  return parsed;
}

/**
 * Parse a comma separated list, trimming entries and removing duplicates.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function parseList(value) {
  if (value === null || value === undefined) {
    return [];
  }

  const seen = new Set();
  const result = [];
  for (const part of String(value).split(",")) {
    const item = part.trim();
    const key = item.toLowerCase();
    if (!item || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * Compare two GitHub events, newest first. Ties are broken by id so output is
 * stable between runs (important to avoid noisy commits).
 *
 * @param {{created_at?: string, id?: string|number}} a
 * @param {{created_at?: string, id?: string|number}} b
 * @returns {number}
 */
function compareEvents(a, b) {
  const aTime = Date.parse(a?.created_at ?? "");
  const bTime = Date.parse(b?.created_at ?? "");
  const safeATime = Number.isNaN(aTime) ? 0 : aTime;
  const safeBTime = Number.isNaN(bTime) ? 0 : bTime;

  if (safeATime !== safeBTime) {
    return safeBTime - safeATime;
  }

  return compareIdsDescending(a?.id, b?.id);
}

/**
 * @param {string|number|undefined} a
 * @param {string|number|undefined} b
 * @returns {number}
 */
function compareIdsDescending(a, b) {
  const aId = Number(a);
  const bId = Number(b);
  if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) {
    return bId - aId;
  }
  return String(b ?? "").localeCompare(String(a ?? ""));
}

/**
 * Remove duplicate events by id, keeping the first occurrence.
 *
 * @template T
 * @param {T[]} events
 * @returns {T[]}
 */
function dedupeById(events) {
  const seen = new Set();
  const result = [];
  for (const event of events) {
    const id = event?.id;
    if (id !== undefined && id !== null) {
      const key = String(id);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    result.push(event);
  }
  return result;
}

/**
 * Remove credentials and tokens from text that is about to be logged.
 *
 * @param {unknown} value
 * @param {string[]} [secrets] - Exact secret values (for example the token).
 * @returns {string}
 */
function redactSecrets(value, secrets = []) {
  let text = String(value ?? "");

  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      text = text.split(secret).join("***");
    }
  }

  return text
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_***")
    .replace(/(x-access-token:)[^@\s]+/gi, "$1***")
    .replace(/(Authorization:\s*(?:Bearer|token)\s+)\S+/gi, "$1***")
    .replace(/https:\/\/[^/@\s]+@github\.com/gi, "https://***@github.com");
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

module.exports = {
  MAX_DISPLAY_LENGTH,
  MAX_RELEASE_NAME_LENGTH,
  cleanText,
  escapeMarkdown,
  escapeInlineCode,
  formatTimestamp,
  formatRelativeTime,
  timestampSuffix,
  parseBoolean,
  parseInteger,
  parseList,
  compareEvents,
  dedupeById,
  redactSecrets,
  sleep,
  isPlainObject,
};


/***/ }),

/***/ 421:
/***/ ((module) => {

module.exports = require("node:child_process");

/***/ }),

/***/ 598:
/***/ ((module) => {

module.exports = require("node:crypto");

/***/ }),

/***/ 24:
/***/ ((module) => {

module.exports = require("node:fs");

/***/ }),

/***/ 455:
/***/ ((module) => {

module.exports = require("node:fs/promises");

/***/ }),

/***/ 760:
/***/ ((module) => {

module.exports = require("node:path");

/***/ }),

/***/ 330:
/***/ ((module) => {

module.exports = /*#__PURE__*/JSON.parse('{"name":"github-activity-readme","version":"0.6.0","private":true,"description":"Keep a README section in sync with your recent public GitHub activity.","main":"index.js","keywords":["github-actions","github-action","readme","activity","profile","automation"],"author":"Ketan Dutt","contributors":["James George (https://github.com/jamesgeorge007)"],"license":"SEE LICENSE IN LICENSE","repository":{"type":"git","url":"https://github.com/KetanDutt/github-activity-readme.git"},"bugs":{"url":"https://github.com/KetanDutt/github-activity-readme/issues"},"homepage":"https://github.com/KetanDutt/github-activity-readme#readme","engines":{"node":">=20"},"files":["action.yml","dist","docs","index.js","src","LICENSE","README.md"],"scripts":{"test":"node scripts/run-tests.js","format":"prettier --write .","format:check":"prettier --check .","build":"ncc build index.js -o dist","preview":"node scripts/preview.js","verify":"npm run format:check && npm test && npm run build"},"dependencies":{},"devDependencies":{"@vercel/ncc":"^0.38.4","prettier":"^3.7.4"}}');

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};


const { ActionError } = __nccwpck_require__(438);
const { runAction } = __nccwpck_require__(783);
const { redactSecrets } = __nccwpck_require__(804);
const { createLogger } = __nccwpck_require__(33);

const core = createLogger();

runAction({ core }).catch((error) => {
  const token =
    process.env.INPUT_GITHUB_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    "";
  const secrets = token ? [token] : [];

  const message = redactSecrets(
    error instanceof ActionError
      ? error.message
      : `Unexpected error: ${error?.message || String(error)}`,
    secrets,
  );
  const hint = error instanceof ActionError ? error.hint : undefined;
  const fullMessage = hint ? `${message}\n\nHint: ${hint}` : message;

  core.setFailed(fullMessage);
  if (error?.stack) {
    core.debug(redactSecrets(error.stack, secrets));
  }
});

module.exports = __webpack_exports__;
/******/ })()
;