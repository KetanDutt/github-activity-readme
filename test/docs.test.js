"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const markdownFiles = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  ...fs
    .readdirSync(path.join(root, "docs"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => `docs/${file}`),
];

const LINK_PATTERN = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

test("all relative documentation links resolve to real files", () => {
  const broken = [];

  for (const file of markdownFiles) {
    const absoluteFile = path.join(root, file);
    const content = stripCode(fs.readFileSync(absoluteFile, "utf8"));

    for (const match of content.matchAll(LINK_PATTERN)) {
      const target = match[1];
      if (
        /^(?:https?:|mailto:|tel:|#)/i.test(target) ||
        target.startsWith("<")
      ) {
        continue;
      }

      const withoutAnchor = target.split("#")[0];
      if (!withoutAnchor) {
        continue;
      }

      const resolved = path.resolve(path.dirname(absoluteFile), withoutAnchor);
      if (!fs.existsSync(resolved)) {
        broken.push(`${file}: ${target}`);
      }
    }
  }

  assert.deepEqual(broken, []);
});

function stripCode(markdown) {
  let inFence = false;
  const withoutFences = markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(`{3,}|~{3,})/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");

  return withoutFences.replace(/`[^`\n]*`/g, "");
}

test("the README banner exists", () => {
  assert.equal(
    fs.existsSync(path.join(root, "docs", "assets", "banner.svg")),
    true,
  );
});

test("every documentation guide is linked from the docs index", () => {
  const index = fs.readFileSync(path.join(root, "docs", "README.md"), "utf8");
  for (const file of fs
    .readdirSync(path.join(root, "docs"))
    .filter((entry) => entry.endsWith(".md") && entry !== "README.md")) {
    assert.match(
      index,
      new RegExp(`\\(${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`),
      `${file} is not linked from docs/README.md`,
    );
  }
});

test("documented inputs and event counts match the implementation", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const events = require("../src/events");
  const { INPUT_NAMES } = require("../src/config");

  for (const name of INPUT_NAMES) {
    assert.match(
      readme,
      new RegExp(`\`${name}\``),
      `README does not mention ${name}`,
    );
  }

  assert.match(
    readme,
    new RegExp(`${events.SUPPORTED_EVENT_TYPES.length} event types`),
  );
  for (const type of events.SUPPORTED_EVENT_TYPES) {
    assert.match(
      readme,
      new RegExp(`\`${type}\``),
      `README does not mention ${type}`,
    );
  }
});
