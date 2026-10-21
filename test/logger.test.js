"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createLogger,
  createSummary,
  escapeData,
  escapeProperty,
} = require("../src/logger");
const { tempDir } = require("./helpers");

function streams() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: { write: (chunk) => out.push(String(chunk)) },
    stderr: { write: (chunk) => err.push(String(chunk)) },
  };
}

test("workflow command data is escaped", () => {
  assert.equal(escapeData("a%b\r\nc"), "a%25b%0D%0Ac");
  assert.equal(escapeProperty("a:b,c"), "a%3Ab%2Cc");
  assert.equal(escapeData(undefined), "");
});

test("logger emits workflow commands inside Actions", () => {
  const io = streams();
  const logger = createLogger({
    env: { GITHUB_ACTIONS: "true" },
    stdout: io.stdout,
    stderr: io.stderr,
  });

  logger.warning("careful\nnow");
  logger.debug("details");
  logger.setSecret("s3cret");
  logger.startGroup("Group");
  logger.endGroup();

  assert.deepEqual(io.out, [
    "::warning::careful%0Anow\n",
    "::debug::details\n",
    "::add-mask::s3cret\n",
    "::group::Group\n",
    "::endgroup::\n",
  ]);
});

test("logger avoids workflow command injection in plain logs", () => {
  const io = streams();
  loggerLog(io).info("::add-mask::not-a-secret\nnormal line");
  assert.deepEqual(io.out, [" ::add-mask::not-a-secret\n", "normal line\n"]);
});

function loggerLog(io) {
  return createLogger({
    env: { GITHUB_ACTIONS: "true" },
    stdout: io.stdout,
    stderr: io.stderr,
  });
}

test("logger degrades gracefully outside Actions", () => {
  const io = streams();
  const logger = createLogger({
    env: {},
    stdout: io.stdout,
    stderr: io.stderr,
  });

  logger.info("hello");
  logger.debug("hidden");
  logger.warning("warn");
  logger.error("bad");
  logger.setSecret("secret");
  logger.startGroup("group");
  logger.endGroup();

  assert.deepEqual(io.out, ["hello\n", "group\n"]);
  assert.deepEqual(io.err, ["Warning: warn\n", "Error: bad\n"]);
});

test("RUNNER_DEBUG enables debug logs outside Actions", () => {
  const io = streams();
  const logger = createLogger({
    env: { RUNNER_DEBUG: "1" },
    stdout: io.stdout,
    stderr: io.stderr,
  });
  logger.debug("details");
  assert.deepEqual(io.out, ["[debug] details\n"]);
});

test("setOutput writes a delimiter-safe output file", (t) => {
  const dir = tempDir(t);
  const outputFile = path.join(dir, "output");
  fs.writeFileSync(outputFile, "");
  const io = streams();
  const logger = createLogger({
    env: { GITHUB_ACTIONS: "true", GITHUB_OUTPUT: outputFile },
    stdout: io.stdout,
    stderr: io.stderr,
  });

  logger.setOutput("changed", "true");
  logger.setOutput("preview", "line 1\nline 2");

  const content = fs.readFileSync(outputFile, "utf8");
  assert.match(
    content,
    /^changed<<ghadelimiter_[0-9a-f-]+\ntrue\nghadelimiter_/,
  );
  assert.match(content, /preview<<ghadelimiter_[0-9a-f-]+\nline 1\nline 2\n/);
});

test("setOutput is a no-op without GITHUB_OUTPUT", () => {
  const io = streams();
  const logger = createLogger({
    env: {},
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.doesNotThrow(() => logger.setOutput("x", "y"));
});

test("summary builds markdown tables and writes the summary file", async (t) => {
  const dir = tempDir(t);
  const summaryFile = path.join(dir, "summary.md");
  const summary = createSummary({ GITHUB_STEP_SUMMARY: summaryFile });

  await summary
    .addHeading("Title", 2)
    .addTable([
      [
        { data: "Name", header: true },
        { data: "Value", header: true },
      ],
      ["a|b", "line\nbreak"],
    ])
    .addRaw("**raw**")
    .write();

  const content = fs.readFileSync(summaryFile, "utf8");
  assert.match(content, /^## Title/);
  assert.match(content, /\| a\\\|b \| line break \|/);
  assert.match(content, /\*\*raw\*\*/);
});

test("summary is silent without a summary file", async () => {
  const summary = createSummary({});
  await summary.addHeading("x").addRaw("y").write();
  assert.ok(summary);
});

test("setFailed marks the process as failed", () => {
  const io = streams();
  const logger = createLogger({
    env: {},
    stdout: io.stdout,
    stderr: io.stderr,
  });
  const previous = process.exitCode;
  try {
    logger.setFailed("boom");
    assert.equal(process.exitCode, 1);
    assert.deepEqual(io.err, ["Error: boom\n"]);
  } finally {
    process.exitCode = previous;
  }
});
