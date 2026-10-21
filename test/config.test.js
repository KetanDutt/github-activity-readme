"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DEFAULTS,
  INPUT_NAMES,
  loadConfig,
  parseUsernames,
  resolveTargetFile,
  normalizeUrl,
  getInput,
} = require("../src/config");
const { ConfigError } = require("../src/errors");
const {
  DEFAULT_FILTER_EVENTS,
  SUPPORTED_EVENT_TYPES,
} = require("../src/events");
const { tempDir, writeFile, baseEnv } = require("./helpers");

function setup(t) {
  const dir = tempDir(t);
  writeFile(dir, "README.md", "# Hello\n");
  return dir;
}

test("loadConfig applies documented defaults", (t) => {
  const dir = setup(t);
  const config = loadConfig({ env: baseEnv(dir), cwd: dir });

  assert.deepEqual(config.usernames, ["octocat"]);
  assert.equal(config.maxLines, 5);
  assert.equal(config.targetFile.relativePath, "README.md");
  assert.equal(config.sectionName, "activity");
  assert.deepEqual(config.filterEventTypes, [...DEFAULT_FILTER_EVENTS].sort());
  assert.equal(config.showTimestamps, false);
  assert.equal(config.timestampFormat, "date");
  assert.equal(config.emptyCommitDays, 50);
  assert.equal(config.commit.name, "github-actions[bot]");
  assert.match(config.commit.email, /github-actions\[bot\]/);
  assert.equal(config.dryRun, false);
  assert.equal(config.token, "test-token");
  assert.equal(config.apiUrl, "https://api.github.com");
  assert.equal(config.serverUrl, "https://github.com");
  assert.equal(config.warnings.length, 0);
  assert.equal(config.maxEventPages, 3);
  assert.equal(config.pushRetries, 3);
});

test("documented defaults stay in sync with DEFAULTS", () => {
  assert.equal(DEFAULTS.MAX_LINES, 5);
  assert.equal(DEFAULTS.TARGET_FILE, "README.md");
  assert.equal(DEFAULTS.SECTION_NAME, "activity");
  assert.equal(DEFAULTS.EMPTY_COMMIT_DAYS, 50);
  assert.equal(DEFAULTS.FILTER_EVENTS, DEFAULT_FILTER_EVENTS.join(","));
});

test("GH_USERNAME supports a deduplicated comma separated list", (t) => {
  const dir = setup(t);
  const config = loadConfig({
    env: baseEnv(dir, { INPUT_GH_USERNAME: "octocat, OctoCat ,hubot" }),
    cwd: dir,
  });
  assert.deepEqual(config.usernames, ["octocat", "hubot"]);
});

test("GH_USERNAME falls back to repository metadata", (t) => {
  const dir = setup(t);

  const owner = loadConfig({
    env: baseEnv(dir, {
      INPUT_GH_USERNAME: "",
      GITHUB_REPOSITORY_OWNER: "octocat",
      GITHUB_REPOSITORY: "octocat/hello-world",
    }),
    cwd: dir,
  });
  assert.deepEqual(owner.usernames, ["octocat"]);

  const repo = loadConfig({
    env: baseEnv(dir, {
      INPUT_GH_USERNAME: "",
      GITHUB_REPOSITORY_OWNER: "",
      GITHUB_REPOSITORY: "hubot/hello-world",
    }),
    cwd: dir,
  });
  assert.deepEqual(repo.usernames, ["hubot"]);
});

test("username validation rejects empty, invalid, and excessive lists", (t) => {
  const dir = setup(t);

  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, {
          INPUT_GH_USERNAME: "",
          GITHUB_REPOSITORY_OWNER: "",
          GITHUB_REPOSITORY: "",
        }),
        cwd: dir,
      }),
    /GH_USERNAME is required/,
  );

  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { INPUT_GH_USERNAME: "-bad" }),
        cwd: dir,
      }),
    /Invalid GitHub username/,
  );

  const eleven = Array.from({ length: 11 }, (_, index) => `user${index}`).join(
    ",",
  );
  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { INPUT_GH_USERNAME: eleven }),
        cwd: dir,
      }),
    /at most 10/,
  );
});

test("MAX_LINES is validated", (t) => {
  const dir = setup(t);
  for (const value of ["0", "101", "abc", "1.5"]) {
    assert.throws(
      () =>
        loadConfig({
          env: baseEnv(dir, { INPUT_MAX_LINES: value }),
          cwd: dir,
        }),
      ConfigError,
    );
  }
  assert.equal(
    loadConfig({
      env: baseEnv(dir, { INPUT_MAX_LINES: "12" }),
      cwd: dir,
    }).maxLines,
    12,
  );
});

test("TARGET_FILE cannot escape the workspace or point at missing files", (t) => {
  const dir = setup(t);
  const outside = path.join(dir, "..", "outside.md");
  fs.writeFileSync(outside, "secret");
  t.after(() => fs.rmSync(outside, { force: true }));

  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { INPUT_TARGET_FILE: "../outside.md" }),
        cwd: dir,
      }),
    /outside the repository/,
  );
  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { INPUT_TARGET_FILE: outside }),
        cwd: dir,
      }),
    /must be a relative path/,
  );
  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { INPUT_TARGET_FILE: "MISSING.md" }),
        cwd: dir,
      }),
    /TARGET_FILE not found/,
  );
  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { INPUT_TARGET_FILE: "." }),
        cwd: dir,
      }),
    /not a file/,
  );
});

test("TARGET_FILE supports nested paths and rejects symlink escapes", (t) => {
  const dir = setup(t);
  writeFile(dir, "docs/README.md", "# Docs\n");

  const nested = loadConfig({
    env: baseEnv(dir, { INPUT_TARGET_FILE: "docs/README.md" }),
    cwd: dir,
  });
  assert.equal(nested.targetFile.relativePath, "docs/README.md");

  const outside = path.join(path.dirname(dir), "linked-outside.md");
  fs.writeFileSync(outside, "outside");
  t.after(() => fs.rmSync(outside, { force: true }));

  try {
    fs.symlinkSync(outside, path.join(dir, "linked.md"));
  } catch {
    t.skip("symlinks are not supported on this platform");
    return;
  }

  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { INPUT_TARGET_FILE: "linked.md" }),
        cwd: dir,
      }),
    /symlink that points outside/,
  );
});

test("SECTION_NAME is validated", (t) => {
  const dir = setup(t);
  for (const value of ["bad name", "-leading", "a".repeat(51), "activity/1"]) {
    assert.throws(
      () =>
        loadConfig({
          env: baseEnv(dir, { INPUT_SECTION_NAME: value }),
          cwd: dir,
        }),
      /Invalid SECTION_NAME/,
    );
  }
  assert.equal(
    loadConfig({
      env: baseEnv(dir, { INPUT_SECTION_NAME: "my_activity-2" }),
      cwd: dir,
    }).sectionName,
    "my_activity-2",
  );
});

test("FILTER_EVENTS supports wildcards, warnings, and rejects all-unknown lists", (t) => {
  const dir = setup(t);

  const all = loadConfig({
    env: baseEnv(dir, { INPUT_FILTER_EVENTS: "*" }),
    cwd: dir,
  });
  assert.equal(all.filterEventTypes.length, SUPPORTED_EVENT_TYPES.length);

  const warned = loadConfig({
    env: baseEnv(dir, { INPUT_FILTER_EVENTS: "WatchEvent,NopeEvent" }),
    cwd: dir,
  });
  assert.deepEqual(warned.filterEventTypes, ["WatchEvent"]);
  assert.equal(warned.warnings.length, 1);
  assert.match(warned.warnings[0], /NopeEvent/);

  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { INPUT_FILTER_EVENTS: "NopeEvent" }),
        cwd: dir,
      }),
    /does not contain any supported event types/,
  );
});

test("SHOW_TIMESTAMPS and TIMESTAMP_FORMAT are validated", (t) => {
  const dir = setup(t);
  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { INPUT_SHOW_TIMESTAMPS: "sometimes" }),
        cwd: dir,
      }),
    /SHOW_TIMESTAMPS/,
  );
  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { INPUT_TIMESTAMP_FORMAT: "unix" }),
        cwd: dir,
      }),
    /TIMESTAMP_FORMAT/,
  );
  const config = loadConfig({
    env: baseEnv(dir, {
      INPUT_SHOW_TIMESTAMPS: "true",
      INPUT_TIMESTAMP_FORMAT: "RELATIVE",
    }),
    cwd: dir,
  });
  assert.equal(config.showTimestamps, true);
  assert.equal(config.timestampFormat, "relative");
});

test("EMPTY_COMMIT_DAYS and DRY_RUN are parsed", (t) => {
  const dir = setup(t);
  const config = loadConfig({
    env: baseEnv(dir, {
      INPUT_EMPTY_COMMIT_DAYS: "0",
      INPUT_DRY_RUN: "yes",
    }),
    cwd: dir,
  });
  assert.equal(config.emptyCommitDays, 0);
  assert.equal(config.dryRun, true);

  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { INPUT_EMPTY_COMMIT_DAYS: "-1" }),
        cwd: dir,
      }),
    /EMPTY_COMMIT_DAYS/,
  );
});

test("commit identity and messages fall back to defaults", (t) => {
  const dir = setup(t);
  const config = loadConfig({
    env: baseEnv(dir, {
      INPUT_COMMIT_NAME: "",
      INPUT_COMMIT_EMAIL: "",
      INPUT_COMMIT_MSG: "",
      INPUT_EMPTY_COMMIT_MSG: "",
    }),
    cwd: dir,
  });
  assert.equal(config.commit.name, "github-actions[bot]");
  assert.equal(config.commit.message, DEFAULTS.COMMIT_MSG);
  assert.equal(config.commit.emptyMessage, DEFAULTS.EMPTY_COMMIT_MSG);

  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { INPUT_COMMIT_EMAIL: "not-an-email" }),
        cwd: dir,
      }),
    /Invalid COMMIT_EMAIL/,
  );
});

test("tokens come from inputs, env, or GH_TOKEN and can be optional", (t) => {
  const dir = setup(t);

  const fromInput = loadConfig({
    env: baseEnv(dir, {
      INPUT_GITHUB_TOKEN: "input-token",
      GITHUB_TOKEN: "env-token",
    }),
    cwd: dir,
  });
  assert.equal(fromInput.token, "input-token");

  const fromGhToken = loadConfig({
    env: baseEnv(dir, { GITHUB_TOKEN: "", GH_TOKEN: "gh-token" }),
    cwd: dir,
  });
  assert.equal(fromGhToken.token, "gh-token");

  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { GITHUB_TOKEN: "" }),
        cwd: dir,
      }),
    /No GitHub token/,
  );

  const optional = loadConfig({
    env: baseEnv(dir, { GITHUB_TOKEN: "" }),
    cwd: dir,
    requireToken: false,
  });
  assert.equal(optional.token, "");
});

test("API and server URLs are normalised and validated", (t) => {
  const dir = setup(t);
  const config = loadConfig({
    env: baseEnv(dir, {
      GITHUB_API_URL: "https://github.example.com/api/v3/",
      GITHUB_SERVER_URL: "https://github.example.com/",
    }),
    cwd: dir,
  });
  assert.equal(config.apiUrl, "https://github.example.com/api/v3");
  assert.equal(config.serverUrl, "https://github.example.com");

  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, { GITHUB_API_URL: "ftp://example.com" }),
        cwd: dir,
      }),
    /must use http or https/,
  );
  assert.throws(() => normalizeUrl("not a url", "GITHUB_API_URL"), ConfigError);
  assert.throws(
    () => normalizeUrl("https://user:pass@example.com", "GITHUB_API_URL"),
    /must not include credentials/,
  );
  assert.throws(
    () => normalizeUrl("https://example.com?token=x", "GITHUB_API_URL"),
    /must not include a query string/,
  );
});

test("EXCLUDE_REPOS patterns are compiled with warnings for invalid entries", (t) => {
  const dir = setup(t);
  const config = loadConfig({
    env: baseEnv(dir, {
      INPUT_EXCLUDE_REPOS: "octocat/*,invalid,someone/repo",
    }),
    cwd: dir,
  });
  assert.equal(config.excludeRepos.length, 2);
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0], /invalid/);
});

test("workspace must exist and GITHUB_WORKSPACE takes precedence", (t) => {
  const dir = setup(t);
  assert.throws(
    () =>
      loadConfig({
        env: baseEnv(dir, {
          GITHUB_WORKSPACE: path.join(dir, "does-not-exist"),
        }),
        cwd: dir,
      }),
    /Workspace directory not found/,
  );

  const config = loadConfig({ env: baseEnv(dir), cwd: "/" });
  assert.equal(config.workspace, dir);
});

test("getInput uppercases and normalises input names", () => {
  assert.equal(getInput({ INPUT_MAX_LINES: " 5 " }, "MAX_LINES"), "5");
  assert.equal(getInput({}, "MAX_LINES"), "");
});

test("parseUsernames rejects invalid values directly", () => {
  assert.deepEqual(parseUsernames({ INPUT_GH_USERNAME: "a,b" }), ["a", "b"]);
  assert.throws(() => parseUsernames({}), ConfigError);
});

test("resolveTargetFile returns a relative POSIX-style path", (t) => {
  const dir = setup(t);
  writeFile(dir, "sub/file.md", "x");
  const result = resolveTargetFile("sub/file.md", dir);
  assert.equal(result.relativePath, "sub/file.md");
  assert.equal(result.absolutePath, path.join(dir, "sub/file.md"));
});

test("every declared input has a value in DEFAULTS or is optional", () => {
  for (const name of INPUT_NAMES) {
    if (name === "GH_USERNAME" || name === "GITHUB_TOKEN") {
      continue;
    }
    assert.ok(
      Object.prototype.hasOwnProperty.call(DEFAULTS, name),
      `Missing default for ${name}`,
    );
  }
});
