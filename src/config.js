"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { ConfigError } = require("./errors");
const {
  DEFAULT_FILTER_EVENTS,
  SUPPORTED_EVENT_TYPES,
  resolveEventFilter,
  compileRepoPatterns,
} = require("./events");
const { parseBoolean, parseInteger, parseList } = require("./utils");

const { version: VERSION } = require("../package.json");

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
