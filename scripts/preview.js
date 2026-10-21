#!/usr/bin/env node
"use strict";

/**
 * Render the activity section locally without writing files or touching git.
 *
 * Usage:
 *   npm run preview -- --username octocat
 *   npm run preview -- --username octocat --file README.md --max-lines 10
 *   GITHUB_TOKEN=*** npm run preview -- --username octocat --show-timestamps
 */

const path = require("node:path");
const { parseArgs } = require("node:util");

const { runAction } = require("../src/action");
const { ActionError } = require("../src/errors");

const OPTIONS = {
  username: { type: "string", short: "u" },
  token: { type: "string" },
  file: { type: "string", default: "README.md" },
  section: { type: "string", default: "activity" },
  "max-lines": { type: "string", default: "5" },
  filter: { type: "string" },
  "exclude-repos": { type: "string" },
  "show-timestamps": { type: "boolean", default: false },
  "timestamp-format": { type: "string", default: "date" },
  verbose: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

function usage() {
  process.stdout.write(`GitHub Activity in README — local preview

Usage:
  npm run preview -- --username <name> [options]

Options:
  -u, --username <name>        GitHub username (comma separated for multiple)
      --file <path>            Target markdown file (default: README.md)
      --section <name>         Section name (default: activity)
      --max-lines <n>          Maximum activity lines (default: 5)
      --filter <events>        Comma separated event types, or "*" for all
      --exclude-repos <list>   Comma separated owner/repo glob patterns
      --show-timestamps        Append dates to each line
      --timestamp-format <f>   date | datetime | relative (default: date)
      --token <token>          GitHub token (prefer the GITHUB_TOKEN env var)
      --verbose                Show debug logs
  -h, --help                   Show this help

The preview never writes files or commits. It needs a markdown file containing
<!--START_SECTION:activity-->.
`);
}

function createConsoleCore(verbose) {
  const passThrough = () => {};
  return {
    info: (message) => console.log(message),
    debug: verbose
      ? (message) => console.log(`[debug] ${message}`)
      : passThrough,
    warning: (message) => console.warn(`Warning: ${message}`),
    error: (message) => console.error(message),
    setSecret: passThrough,
    setOutput: passThrough,
    startGroup: passThrough,
    endGroup: passThrough,
    summary: {
      addHeading() {
        return this;
      },
      addTable() {
        return this;
      },
      addRaw() {
        return this;
      },
      async write() {},
    },
  };
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: OPTIONS, allowPositionals: false }));
  } catch (error) {
    console.error(`${error.message}\n`);
    usage();
    process.exitCode = 1;
    return;
  }

  if (values.help) {
    usage();
    return;
  }
  if (!values.username) {
    console.error("Missing required option: --username\n");
    usage();
    process.exitCode = 1;
    return;
  }

  const workspace = process.cwd();
  const env = {
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    INPUT_GH_USERNAME: values.username,
    INPUT_TARGET_FILE: values.file,
    INPUT_SECTION_NAME: values.section,
    INPUT_MAX_LINES: values["max-lines"],
    INPUT_SHOW_TIMESTAMPS: String(values["show-timestamps"]),
    INPUT_TIMESTAMP_FORMAT: values["timestamp-format"],
    INPUT_DRY_RUN: "true",
  };

  if (values.filter) {
    env.INPUT_FILTER_EVENTS = values.filter;
  }
  if (values["exclude-repos"]) {
    env.INPUT_EXCLUDE_REPOS = values["exclude-repos"];
  }
  if (values.token) {
    env.GITHUB_TOKEN = values.token;
  }

  const result = await runAction({
    env,
    cwd: workspace,
    requireToken: false,
    core: createConsoleCore(values.verbose),
  });

  console.log("\n--- Generated section (dry run) ---");
  if (result.preview.length === 0) {
    console.log("(no matching activity)");
  } else {
    console.log(result.preview.join("\n"));
  }
  console.log(
    `\nFile: ${path.resolve(workspace, values.file)} · ${result.activityCount} line(s) · no changes written`,
  );
}

main().catch((error) => {
  if (error instanceof ActionError) {
    console.error(`Error: ${error.message}`);
    if (error.hint) {
      console.error(`Hint: ${error.hint}`);
    }
  } else {
    console.error(error?.stack || error?.message || String(error));
  }
  process.exitCode = 1;
});
