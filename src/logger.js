"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");

/**
 * A tiny, dependency-free implementation of the GitHub Actions toolkit
 * interface used by this action.
 *
 * Replacing `@actions/core` removes ~1 MB of bundled HTTP/undici code from the
 * action, which makes startup faster and keeps the supply chain small. The
 * workflow command format is documented by GitHub:
 * https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {NodeJS.WritableStream} [options.stdout]
 * @param {NodeJS.WritableStream} [options.stderr]
 * @returns {object}
 */
function createLogger({
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const inActions = env.GITHUB_ACTIONS === "true";
  const summary = createSummary(env);

  /**
   * Write plain log output. Lines that begin with `::` are prefixed with a
   * space so untrusted content (for example a release name) cannot inject
   * workflow commands into the runner's stdout parser.
   *
   * @param {unknown} message
   */
  function writeLog(message) {
    const text = String(message ?? "");
    for (const line of text.split(/\r?\n/)) {
      stdout.write(`${line.startsWith("::") ? ` ${line}` : line}\n`);
    }
  }

  /**
   * @param {string} command
   * @param {unknown} message
   */
  function issueCommand(command, message) {
    if (!inActions) {
      return;
    }
    stdout.write(`::${command}::${escapeData(message)}\n`);
  }

  return {
    info: writeLog,
    debug(message) {
      if (inActions) {
        issueCommand("debug", message);
      } else if (env.RUNNER_DEBUG === "1") {
        writeLog(`[debug] ${message}`);
      }
    },
    warning(message) {
      if (inActions) {
        issueCommand("warning", message);
      } else {
        stderr.write(`Warning: ${String(message ?? "")}\n`);
      }
    },
    error(message) {
      if (inActions) {
        issueCommand("error", message);
      } else {
        stderr.write(`Error: ${String(message ?? "")}\n`);
      }
    },
    notice(message) {
      if (inActions) {
        issueCommand("notice", message);
      } else {
        writeLog(message);
      }
    },
    setSecret(secret) {
      if (!inActions || !secret) {
        return;
      }
      stdout.write(`::add-mask::${escapeData(secret)}\n`);
    },
    setOutput(name, value) {
      if (!env.GITHUB_OUTPUT) {
        return;
      }
      try {
        const delimiter = `ghadelimiter_${crypto.randomUUID()}`;
        fs.appendFileSync(
          env.GITHUB_OUTPUT,
          `${name}<<${delimiter}\n${String(value ?? "")}\n${delimiter}\n`,
          "utf8",
        );
      } catch (error) {
        this.warning(`Could not write the "${name}" output: ${error.message}`);
      }
    },
    setFailed(message) {
      this.error(message);
      process.exitCode = 1;
    },
    startGroup(name) {
      if (inActions) {
        issueCommand("group", name);
      } else {
        writeLog(name);
      }
    },
    endGroup() {
      if (inActions) {
        issueCommand("endgroup", "");
      }
    },
    summary,
  };
}

/**
 * Minimal job-summary builder compatible with `@actions/core`'s summary API
 * for the methods this action uses (addHeading/addTable/addRaw/write).
 *
 * @param {Record<string, string|undefined>} env
 * @returns {object}
 */
function createSummary(env) {
  let parts = [];

  return {
    addHeading(text, level = 1) {
      parts.push(`${"#".repeat(Math.min(6, Math.max(1, level)))} ${text}`);
      return this;
    },
    addTable(rows) {
      if (!Array.isArray(rows) || rows.length === 0) {
        return this;
      }

      const normalized = rows.map((row) =>
        (Array.isArray(row) ? row : [row]).map((cell) => {
          const value =
            cell && typeof cell === "object" && "data" in cell
              ? cell.data
              : cell;
          return String(value ?? "")
            .replace(/\r?\n/g, " ")
            .replace(/\|/g, "\\|");
        }),
      );

      const header = normalized[0];
      parts.push(
        [
          `| ${header.join(" | ")} |`,
          `| ${header.map(() => "---").join(" | ")} |`,
          ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
        ].join("\n"),
      );
      return this;
    },
    addRaw(text) {
      parts.push(String(text ?? ""));
      return this;
    },
    addEOL() {
      parts.push("");
      return this;
    },
    async write() {
      if (!env.GITHUB_STEP_SUMMARY || parts.length === 0) {
        parts = [];
        return this;
      }
      try {
        fs.appendFileSync(
          env.GITHUB_STEP_SUMMARY,
          `${parts.join("\n\n")}\n`,
          "utf8",
        );
      } catch {
        // A missing or read-only summary file is not worth failing the action.
      }
      parts = [];
      return this;
    },
  };
}

/**
 * Escape a workflow-command message.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeData(value) {
  return String(value ?? "")
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

/**
 * Escape a workflow-command property value.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

module.exports = {
  createLogger,
  createSummary,
  escapeData,
  escapeProperty,
};
