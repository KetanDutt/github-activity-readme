"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * Create a temporary directory that is removed after the test.
 *
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "github-activity-readme-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} content
 * @returns {string}
 */
function writeFile(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/**
 * @param {string} dir
 * @param {Record<string, string>} [overrides]
 * @returns {Record<string, string>}
 */
function baseEnv(dir, overrides = {}) {
  return {
    GITHUB_WORKSPACE: dir,
    INPUT_GH_USERNAME: "octocat",
    GITHUB_TOKEN: "test-token",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    ...overrides,
  };
}

/**
 * Minimal @actions/core substitute.
 *
 * @returns {object}
 */
function fakeCore() {
  const logs = [];
  const warnings = [];
  const errors = [];
  const outputs = {};
  const secrets = [];
  const groups = [];
  const summaryParts = [];

  const summary = {
    addHeading(text) {
      summaryParts.push(`# ${text}`);
      return this;
    },
    addTable(rows) {
      summaryParts.push(rows);
      return this;
    },
    addRaw(text) {
      summaryParts.push(text);
      return this;
    },
    async write() {
      summaryParts.push("[[written]]");
    },
  };

  const core = {
    logs,
    warnings,
    errors,
    outputs,
    secrets,
    groups,
    summaryParts,
    summary,
    info(message) {
      logs.push(message);
    },
    debug() {},
    warning(message) {
      warnings.push(message);
    },
    error(message) {
      errors.push(message);
    },
    setSecret(secret) {
      secrets.push(secret);
    },
    setOutput(name, value) {
      outputs[name] = value;
    },
    startGroup(name) {
      groups.push(name);
    },
    endGroup() {
      groups.push(null);
    },
  };
  return core;
}

/**
 * @param {object} overrides
 * @returns {object}
 */
function makeEvent({
  id = 1,
  type,
  createdAt = "2026-10-21T10:00:00Z",
  repo = "octocat/hello-world",
  payload = {},
} = {}) {
  return {
    id: String(id),
    type,
    created_at: createdAt,
    repo: typeof repo === "string" ? { name: repo } : repo,
    payload,
  };
}

/**
 * @param {unknown} data
 * @param {object} [options]
 * @param {number} [options.status]
 * @param {Record<string, string|number>} [options.headers]
 * @returns {object}
 */
function fakeResponse(data, { status = 200, headers = {} } = {}) {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return normalized.get(String(name).toLowerCase()) ?? null;
      },
    },
    json: async () => data,
  };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {string}
 */
function git(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Create a git repository with one commit and an optional bare remote.
 *
 * @param {string} dir
 * @param {object} [options]
 * @param {string} [options.readme]
 * @param {boolean} [options.remote]
 * @param {string} [options.branch]
 * @param {string} [options.commitDate]
 * @returns {{remote: string|null, branch: string}}
 */
function initRepo(
  dir,
  {
    readme = "# Hello\n\n<!--START_SECTION:activity-->\n<!--END_SECTION:activity-->\n",
    remote = false,
    branch = "main",
    commitDate,
  } = {},
) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", branch]);
  writeFile(dir, "README.md", readme);
  git(dir, ["add", "README.md"]);

  const dateEnv = commitDate
    ? { GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate }
    : {};
  git(
    dir,
    [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Initial commit",
    ],
    dateEnv,
  );

  let remotePath = null;
  if (remote) {
    remotePath = `${dir}-remote.git`;
    git(path.dirname(dir), ["init", "--bare", remotePath]);
    git(dir, ["remote", "add", "origin", remotePath]);
    git(dir, ["push", "-u", "origin", branch]);
  }

  return { remote: remotePath, branch };
}

module.exports = {
  tempDir,
  writeFile,
  baseEnv,
  fakeCore,
  makeEvent,
  fakeResponse,
  git,
  initRepo,
};
