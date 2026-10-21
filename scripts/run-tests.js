#!/usr/bin/env node
"use strict";

/**
 * Run the Node.js test suite with a cross-platform file list.
 *
 * `node --test test/` is not portable across Node versions, and shell glob
 * expansion behaves differently on Windows. Collecting the files here keeps
 * `npm test` identical on every platform.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testDir = path.resolve(__dirname, "..", "test");
const files = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => path.join(testDir, file));

if (files.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
