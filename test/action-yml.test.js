"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { INPUT_NAMES, DEFAULTS } = require("../src/config");
const { SUPPORTED_EVENT_TYPES } = require("../src/events");

const root = path.resolve(__dirname, "..");
const actionYml = fs.readFileSync(path.join(root, "action.yml"), "utf8");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

function parseInputs(text) {
  const inputs = {};
  let inInputs = false;
  let current = null;

  for (const line of text.split("\n")) {
    if (line === "inputs:") {
      inInputs = true;
      continue;
    }
    if (inInputs && /^[a-z]+:/.test(line)) {
      inInputs = false;
    }
    if (!inInputs) {
      continue;
    }
    const header = line.match(/^  ([A-Z0-9_]+):$/);
    if (header) {
      current = header[1];
      inputs[current] = {};
      continue;
    }
    const property = line.match(/^    (description|default|required):\s*(.*)$/);
    if (current && property) {
      inputs[current][property[1]] = property[2].replace(/^"|"$/g, "");
    }
  }

  return inputs;
}

const inputs = parseInputs(actionYml);

test("action.yml declares every supported input", () => {
  for (const name of INPUT_NAMES) {
    assert.ok(inputs[name], `Missing input ${name} in action.yml`);
  }
});

test("action.yml defaults match the code defaults", () => {
  assert.equal(inputs.MAX_LINES.default, String(DEFAULTS.MAX_LINES));
  assert.equal(inputs.TARGET_FILE.default, DEFAULTS.TARGET_FILE);
  assert.equal(inputs.SECTION_NAME.default, DEFAULTS.SECTION_NAME);
  assert.equal(
    inputs.SHOW_TIMESTAMPS.default,
    String(DEFAULTS.SHOW_TIMESTAMPS),
  );
  assert.equal(inputs.TIMESTAMP_FORMAT.default, DEFAULTS.TIMESTAMP_FORMAT);
  assert.equal(
    inputs.EMPTY_COMMIT_DAYS.default,
    String(DEFAULTS.EMPTY_COMMIT_DAYS),
  );
  assert.equal(inputs.FILTER_EVENTS.default, DEFAULTS.FILTER_EVENTS);
  assert.equal(inputs.DRY_RUN.default, String(DEFAULTS.DRY_RUN));
  assert.equal(inputs.COMMIT_NAME.default, DEFAULTS.COMMIT_NAME);
  assert.equal(inputs.COMMIT_EMAIL.default, DEFAULTS.COMMIT_EMAIL);
  assert.equal(inputs.COMMIT_MSG.default, DEFAULTS.COMMIT_MSG);
  assert.equal(inputs.EMPTY_COMMIT_MSG.default, DEFAULTS.EMPTY_COMMIT_MSG);
  assert.equal(inputs.GH_USERNAME.default, "${{ github.repository_owner }}");
});

test("the default filter only contains supported event types", () => {
  for (const type of DEFAULTS.FILTER_EVENTS.split(",")) {
    assert.ok(
      SUPPORTED_EVENT_TYPES.includes(type.trim()),
      `Default filter contains unsupported event type: ${type}`,
    );
  }
});

test("the action runs on the node24 runtime and the built entrypoint", () => {
  assert.match(actionYml, /^runs:\n  using: node24\n  main: dist\/index\.js$/m);
});

test("outputs are declared", () => {
  for (const output of [
    "changed",
    "activity_count",
    "target_file",
    "result",
    "commit_sha",
  ]) {
    assert.match(actionYml, new RegExp(`^  ${output}:$`, "m"));
  }
});

test("package metadata is production ready", () => {
  assert.equal(packageJson.name, "github-activity-readme");
  assert.equal(packageJson.main, "index.js");
  assert.equal(packageJson.license, "SEE LICENSE IN LICENSE");
  assert.equal(
    packageJson.repository.url,
    "https://github.com/KetanDutt/github-activity-readme.git",
  );
  assert.ok(packageJson.engines.node);
  assert.deepEqual(Object.keys(packageJson.dependencies), []);
  assert.match(packageJson.scripts.test, /run-tests\.js/);
  assert.match(packageJson.scripts.build, /ncc build/);
  assert.match(
    fs.readFileSync(path.join(root, "scripts", "run-tests.js"), "utf8"),
    /--test/,
  );
});

test("the no-CI policy is preserved", () => {
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows")), false);
  assert.equal(fs.existsSync(path.join(root, ".github")), false);

  for (const candidate of [
    ".circleci",
    ".gitlab-ci.yml",
    ".travis.yml",
    "azure-pipelines.yml",
    "Jenkinsfile",
  ]) {
    assert.equal(
      fs.existsSync(path.join(root, candidate)),
      false,
      `Unexpected CI configuration: ${candidate}`,
    );
  }
});

test("the built action exists and is a single bundle", () => {
  const dist = path.join(root, "dist", "index.js");
  assert.equal(fs.existsSync(dist), true);
  assert.ok(fs.statSync(dist).size > 10_000);
});
