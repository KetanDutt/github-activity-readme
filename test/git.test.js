"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
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
} = require("../src/git");
const { GitError } = require("../src/errors");
const { tempDir, writeFile, git, initRepo } = require("./helpers");

function repo(t, options = {}) {
  const dir = tempDir(t);
  const { remote, branch } = initRepo(dir, options);
  if (remote) {
    t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  }
  return { dir, remote, branch };
}

test("getCurrentBranch returns the checked out branch and null when detached", async (t) => {
  const { dir } = repo(t);
  assert.equal(await getCurrentBranch({ cwd: dir }), "main");

  git(dir, ["checkout", "--detach", "HEAD"]);
  assert.equal(await getCurrentBranch({ cwd: dir }), null);
});

test("commitFile commits only the target file and returns its sha", async (t) => {
  const { dir } = repo(t);
  writeFile(dir, "README.md", "# Updated\n");

  const result = await commitFile({
    file: "README.md",
    message: "Update README",
    name: "Activity Bot",
    email: "bot@example.com",
    cwd: dir,
  });

  assert.equal(result.committed, true);
  assert.match(result.sha, /^[0-9a-f]{40}$/);
  assert.equal(git(dir, ["log", "-1", "--format=%s"]), "Update README");
  assert.equal(
    git(dir, ["log", "-1", "--format=%an <%ae>"]),
    "Activity Bot <bot@example.com>",
  );
  assert.deepEqual(
    git(dir, ["show", "--name-only", "--format=", "HEAD"]).split("\n"),
    ["README.md"],
  );
});

test("commitFile returns committed=false when the file has not changed", async (t) => {
  const { dir } = repo(t);
  const before = git(dir, ["rev-parse", "HEAD"]);

  const result = await commitFile({
    file: "README.md",
    message: "Should not commit",
    name: "Bot",
    email: "bot@example.com",
    cwd: dir,
  });

  assert.equal(result.committed, false);
  assert.equal(git(dir, ["rev-parse", "HEAD"]), before);
});

test("commitFile does not sweep unrelated staged files into the commit", async (t) => {
  const { dir } = repo(t);
  writeFile(dir, "other.txt", "other");
  git(dir, ["add", "other.txt"]);
  writeFile(dir, "README.md", "# Updated\n");

  await commitFile({
    file: "README.md",
    message: "Only README",
    name: "Bot",
    email: "bot@example.com",
    cwd: dir,
  });

  assert.deepEqual(
    git(dir, ["show", "--name-only", "--format=", "HEAD"]).split("\n"),
    ["README.md"],
  );
  assert.deepEqual(git(dir, ["diff", "--cached", "--name-only"]).split("\n"), [
    "other.txt",
  ]);
});

test("commitFile can commit a newly added target file", async (t) => {
  const { dir } = repo(t);
  writeFile(dir, "docs/activity.md", "new file\n");

  const result = await commitFile({
    file: "docs/activity.md",
    message: "Add activity file",
    name: "Bot",
    email: "bot@example.com",
    cwd: dir,
  });

  assert.equal(result.committed, true);
  assert.deepEqual(
    git(dir, ["show", "--name-only", "--format=", "HEAD"]).split("\n"),
    ["docs/activity.md"],
  );
});

test("commitFile can create an empty commit", async (t) => {
  const { dir } = repo(t);
  const beforeCount = Number(git(dir, ["rev-list", "--count", "HEAD"]));

  const result = await commitFile({
    file: "README.md",
    message: "Empty commit",
    name: "Bot",
    email: "bot@example.com",
    allowEmpty: true,
    cwd: dir,
  });

  assert.equal(result.committed, true);
  assert.equal(
    Number(git(dir, ["rev-list", "--count", "HEAD"])),
    beforeCount + 1,
  );
});

test("stageFile and hasStagedChanges use pathspec-safe arguments", async (t) => {
  const { dir } = repo(t);
  assert.equal(await hasStagedChanges("README.md", { cwd: dir }), false);

  writeFile(dir, "-leading-dash.md", "hello");
  await stageFile("-leading-dash.md", { cwd: dir });
  assert.equal(await hasStagedChanges("-leading-dash.md", { cwd: dir }), true);
});

test("getHeadSha and getLastCommitAgeDays work for old commits", async (t) => {
  const { dir } = repo(t, { commitDate: "2020-01-01T00:00:00Z" });

  assert.equal(await getHeadSha({ cwd: dir }), git(dir, ["rev-parse", "HEAD"]));
  const age = await getLastCommitAgeDays({
    cwd: dir,
    now: new Date("2026-10-21T00:00:00Z"),
  });
  assert.ok(age > 1_000, `expected an old commit, got ${age} days`);
});

test("getLastCommitAgeDays returns null for a repository without commits", async (t) => {
  const dir = tempDir(t);
  git(dir, ["init", "-b", "main"]);
  assert.equal(await getLastCommitAgeDays({ cwd: dir }), null);
});

test("commitAndPush pushes to the current branch of a remote", async (t) => {
  const { dir, remote, branch } = repo(t, { remote: true });
  writeFile(dir, "README.md", "# Pushed\n");

  const result = await commitAndPush({
    file: "README.md",
    message: "Push README",
    name: "Bot",
    email: "bot@example.com",
    branch,
    cwd: dir,
  });

  assert.equal(result.committed, true);
  assert.equal(result.pushed, true);
  assert.equal(
    git(remote, ["log", "-1", "--format=%s", branch]),
    "Push README",
  );
  assert.equal(git(dir, ["status", "--porcelain"]), "");
});

test("pushBranch rebases and retries after a non-fast-forward rejection", async () => {
  const calls = [];
  const delays = [];
  let pushes = 0;

  const run = async (args) => {
    calls.push(args);
    if (args[0] === "push") {
      pushes += 1;
      if (pushes === 1) {
        throw new GitError("push rejected", {
          code: 1,
          stderr: "! [rejected] main -> main (non-fast-forward)",
          command: "git push",
        });
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  await pushBranch({
    branch: "main",
    name: "Activity Bot",
    email: "bot@example.com",
    run,
    sleep: async (ms) => delays.push(ms),
    retries: 2,
  });

  assert.equal(pushes, 2);
  const pullCall = calls.find((args) => args.includes("pull"));
  assert.deepEqual(pullCall.slice(0, 6), [
    "-c",
    "user.name=Activity Bot",
    "-c",
    "user.email=bot@example.com",
    "pull",
    "--rebase",
  ]);
  assert.equal(delays.length, 1);
});

test("pushBranch does not retry authentication failures", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    throw new GitError("permission denied", {
      code: 128,
      stderr: "fatal: could not read Username: terminal prompts disabled",
      command: "git push",
      hint: "grant contents write",
    });
  };

  await assert.rejects(
    () => pushBranch({ branch: "main", run }),
    /permission denied/,
  );
  assert.equal(calls.filter((args) => args[0] === "push").length, 1);
  assert.equal(
    calls.some((args) => args.includes("pull")),
    false,
  );
});

test("pushBranch rejects a missing branch", async () => {
  await assert.rejects(() => pushBranch({ branch: "" }), /detached HEAD/);
});

test("runGit rejects failed commands with a GitError", async (t) => {
  const { dir } = repo(t);
  await assert.rejects(
    () => runGit(["rev-parse", "does-not-exist"], { cwd: dir }),
    (error) => error instanceof GitError && error.exitCode !== 0,
  );
});

test("runGit redacts secrets from commands and output", async (t) => {
  const { dir } = repo(t);
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  await assert.rejects(
    () =>
      runGit(["rev-parse", secret], {
        cwd: dir,
        secrets: [secret],
      }),
    (error) => {
      assert.ok(error instanceof GitError);
      assert.ok(!error.command.includes(secret));
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

test("helper predicates and formatting are stable", () => {
  assert.equal(
    isNonFastForward({
      stderr: "! [rejected] main -> main (fetch first)",
      message: "",
    }),
    true,
  );
  assert.equal(
    isNonFastForward({ stderr: "permission denied", message: "" }),
    false,
  );

  assert.equal(
    formatCommand(["commit", "-m", "hello world"]),
    'git commit -m "hello world"',
  );
  assert.equal(appendLimited("abc", Buffer.from("def")), "abcdef");
  assert.equal(
    appendLimited("x".repeat(600_000), Buffer.from("tail")).endsWith("tail"),
    true,
  );
});
