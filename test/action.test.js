"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { runAction } = require("../src/action");
const { ActionError, ConfigError, GitHubApiError } = require("../src/errors");
const {
  tempDir,
  writeFile,
  baseEnv,
  fakeCore,
  makeEvent,
  fakeResponse,
  git,
  initRepo,
} = require("./helpers");

const README =
  "# Hello\n\n<!--START_SECTION:activity-->\n<!--END_SECTION:activity-->\n";
const NOW = new Date("2026-10-21T12:00:00Z");

function setup(t, { readme = README, remote = true, commitDate } = {}) {
  const dir = tempDir(t);
  const { remote: remotePath, branch } = initRepo(dir, {
    readme,
    remote,
    commitDate,
  });
  if (remotePath) {
    t.after(() => fs.rmSync(remotePath, { recursive: true, force: true }));
  }
  return { dir, remote: remotePath, branch, core: fakeCore() };
}

function fetchEvents(events) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    return fakeResponse(events);
  };
  fn.calls = calls;
  return fn;
}

function run(dir, core, fetchImpl, overrides = {}) {
  return runAction({
    env: baseEnv(dir, overrides.env),
    cwd: dir,
    core,
    fetchImpl,
    now: NOW,
    requireToken: true,
    sleepFn: async () => {},
    ...overrides.options,
  });
}

function mergedPr(id = 1) {
  return makeEvent({
    id,
    type: "PullRequestEvent",
    repo: "octocat/hello-world",
    payload: {
      action: "closed",
      pull_request: { number: 5, merged: true },
    },
  });
}

test("runAction updates the README, commits, pushes, and sets outputs", async (t) => {
  const { dir, remote, branch, core } = setup(t);
  const fetchImpl = fetchEvents([mergedPr()]);

  const result = await run(dir, core, fetchImpl);

  assert.equal(result.result, "updated");
  assert.equal(result.changed, true);
  assert.equal(result.activityCount, 1);

  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /1\. 🎉 Merged PR \[#5\]/);
  assert.match(readme, /<!--END_SECTION:activity-->/);

  assert.equal(git(dir, ["status", "--porcelain"]), "");
  assert.match(
    git(remote, ["log", "-1", "--format=%s", branch]),
    /Update README/,
  );
  assert.equal(
    git(dir, ["log", "-1", "--format=%an <%ae>"]),
    "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
  );

  assert.equal(core.outputs.changed, "true");
  assert.equal(core.outputs.activity_count, "1");
  assert.equal(core.outputs.target_file, "README.md");
  assert.equal(core.outputs.result, "updated");
  assert.match(core.outputs.commit_sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(core.secrets, ["test-token"]);
  assert.deepEqual(core.groups, ["Fetching GitHub activity", null]);
  assert.ok(core.summaryParts.includes("[[written]]"));
  assert.match(JSON.stringify(core.summaryParts), /Merged PR/);
});

test("runAction is idempotent when the section is already up to date", async (t) => {
  const { dir, core } = setup(t);
  const fetchImpl = fetchEvents([mergedPr()]);

  await run(dir, core, fetchImpl);
  const before = git(dir, ["rev-parse", "HEAD"]);

  const result = await run(dir, core, fetchImpl);

  assert.equal(result.result, "unchanged");
  assert.equal(result.changed, false);
  assert.equal(result.activityCount, 1);
  assert.equal(git(dir, ["rev-parse", "HEAD"]), before);
  assert.equal(core.outputs.result, "unchanged");
  assert.equal(core.outputs.changed, "false");
});

test("dry run renders a preview without writing or committing", async (t) => {
  const { dir, core } = setup(t);
  const fetchImpl = fetchEvents([mergedPr()]);
  const before = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  const beforeHead = git(dir, ["rev-parse", "HEAD"]);

  const result = await run(dir, core, fetchImpl, {
    env: { INPUT_DRY_RUN: "true" },
  });

  assert.equal(result.result, "dry-run");
  assert.equal(result.changed, false);
  assert.equal(result.wouldChange, true);
  assert.equal(result.preview.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), before);
  assert.equal(git(dir, ["rev-parse", "HEAD"]), beforeHead);
  assert.ok(core.logs.some((line) => /Dry run enabled/.test(line)));
});

test("no matching events leave the section untouched", async (t) => {
  const { dir, core } = setup(t);
  const before = git(dir, ["rev-parse", "HEAD"]);

  const result = await run(dir, core, fetchEvents([]));

  assert.equal(result.result, "unchanged");
  assert.equal(result.activityCount, 0);
  assert.equal(git(dir, ["rev-parse", "HEAD"]), before);
  assert.ok(core.logs.some((line) => /No matching public activity/.test(line)));
});

test("an empty commit keeps a stale scheduled workflow active", async (t) => {
  const { dir, remote, branch, core } = setup(t, {
    commitDate: "2026-01-01T00:00:00Z",
  });
  const beforeCount = Number(git(dir, ["rev-list", "--count", "HEAD"]));

  const result = await run(dir, core, fetchEvents([]), {
    env: { INPUT_EMPTY_COMMIT_DAYS: "50" },
  });

  assert.equal(result.result, "empty-commit");
  assert.equal(result.changed, false);
  assert.equal(
    Number(git(dir, ["rev-list", "--count", "HEAD"])),
    beforeCount + 1,
  );
  assert.match(
    git(remote, ["log", "-1", "--format=%s", branch]),
    /Empty commit to keep the scheduled workflow active/,
  );
  assert.equal(core.outputs.result, "empty-commit");
});

test("a recently committed repository does not create an empty commit", async (t) => {
  const { dir, core } = setup(t);
  const before = git(dir, ["rev-parse", "HEAD"]);

  const result = await run(dir, core, fetchEvents([]), {
    env: { INPUT_EMPTY_COMMIT_DAYS: "50" },
  });

  assert.equal(result.result, "unchanged");
  assert.equal(git(dir, ["rev-parse", "HEAD"]), before);
});

test("an empty END marker is inserted when only START exists", async (t) => {
  const { dir, core } = setup(t, {
    readme: "# Hello\n<!--START_SECTION:activity-->\n",
  });

  const result = await run(dir, core, fetchEvents([mergedPr()]));

  assert.equal(result.result, "updated");
  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /1\. 🎉 Merged PR/);
  assert.match(readme, /<!--END_SECTION:activity-->/);
  assert.ok(core.warnings.some((line) => /END marker/.test(line)));
});

test("missing markers fail before any network request", async (t) => {
  const { dir, core } = setup(t, { readme: "# No markers\n" });
  const fetchImpl = fetchEvents([mergedPr()]);

  await assert.rejects(
    () => run(dir, core, fetchImpl),
    (error) =>
      error instanceof ActionError &&
      /Couldn't find the section markers/.test(error.message),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("detached HEAD fails without modifying the file", async (t) => {
  const { dir, core } = setup(t);
  git(dir, ["checkout", "--detach", "HEAD"]);
  const before = fs.readFileSync(path.join(dir, "README.md"), "utf8");

  await assert.rejects(
    () => run(dir, core, fetchEvents([mergedPr()])),
    /detached HEAD/,
  );
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), before);
});

test("a failing git hook rolls the file back", async (t) => {
  const { dir, core } = setup(t);
  const hook = path.join(dir, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const before = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  const beforeHead = git(dir, ["rev-parse", "HEAD"]);

  await assert.rejects(
    () => run(dir, core, fetchEvents([mergedPr()])),
    /pre-commit|exited with code/i,
  );

  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), before);
  assert.equal(git(dir, ["rev-parse", "HEAD"]), beforeHead);
});

test("API failures do not modify the README and close the log group", async (t) => {
  const { dir, core } = setup(t);
  const before = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  const fetchImpl = async () =>
    fakeResponse({ message: "Not Found" }, { status: 404 });

  await assert.rejects(
    () => run(dir, core, fetchImpl),
    (error) => error instanceof GitHubApiError,
  );

  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), before);
  assert.deepEqual(core.groups, ["Fetching GitHub activity", null]);
});

test("multiple usernames are merged into one section", async (t) => {
  const { dir, core } = setup(t);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/users/alice/")) {
      return fakeResponse([
        makeEvent({
          id: 1,
          type: "WatchEvent",
          repo: "alice/one",
        }),
      ]);
    }
    return fakeResponse([
      makeEvent({
        id: 2,
        type: "WatchEvent",
        repo: "bob/two",
      }),
    ]);
  };

  const result = await run(dir, core, fetchImpl, {
    env: {
      INPUT_GH_USERNAME: "alice,bob",
      INPUT_FILTER_EVENTS: "*",
    },
  });

  assert.equal(result.result, "updated");
  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /Starred \[alice\/one\]/);
  assert.match(readme, /Starred \[bob\/two\]/);
  assert.equal(calls.length, 2);
});

test("timestamps are written when enabled", async (t) => {
  const { dir, core } = setup(t);

  await run(dir, core, fetchEvents([mergedPr()]), {
    env: {
      INPUT_SHOW_TIMESTAMPS: "true",
      INPUT_TIMESTAMP_FORMAT: "date",
    },
  });

  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /<sub>2026-10-21<\/sub>/);
});

test("config errors are raised before reading or modifying files", async (t) => {
  const dir = tempDir(t);
  writeFile(dir, "README.md", README);
  const core = fakeCore();

  await assert.rejects(
    () =>
      runAction({
        env: baseEnv(dir, { INPUT_MAX_LINES: "0" }),
        cwd: dir,
        core,
        fetchImpl: fetchEvents([]),
      }),
    ConfigError,
  );
  assert.equal(core.logs.length, 0);
});
