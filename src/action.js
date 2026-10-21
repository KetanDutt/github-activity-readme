"use strict";

const fs = require("node:fs/promises");

const { ActionError, GitError } = require("./errors");
const { loadConfig } = require("./config");
const { createLogger } = require("./logger");
const { createGitHubClient, fetchActivity } = require("./github");
const { formatActivityLines } = require("./events");
const { buildSectionLines, replaceSection } = require("./section");
const git = require("./git");
const { escapeMarkdown, sleep: defaultSleep } = require("./utils");

/**
 * Run the action.
 *
 * Dependencies are injectable so the orchestration can be tested end-to-end in
 * a temporary git repository without touching the network.
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.cwd]
 * @param {object} [options.core] - @actions/core compatible logger.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {Date} [options.now]
 * @param {boolean} [options.requireToken]
 * @param {Function} [options.gitRun] - Custom `runGit` implementation.
 * @param {Function} [options.sleepFn]
 * @returns {Promise<object>}
 */
async function runAction({
  env = process.env,
  cwd = env.GITHUB_WORKSPACE || process.cwd(),
  core = createLogger(),
  fetchImpl = globalThis.fetch,
  now = new Date(),
  requireToken = true,
  gitRun,
  sleepFn,
} = {}) {
  const startedAt = Date.now();
  const config = loadConfig({ env, cwd, requireToken, now });
  const run = gitRun || git.runGit;
  const sleep = sleepFn || defaultSleep;
  const secrets = config.token ? [config.token] : [];

  if (config.token) {
    core.setSecret(config.token);
  }
  for (const warning of config.warnings) {
    core.warning(warning);
  }

  core.info(
    `GitHub Activity in README · ${config.usernames.map((user) => `@${user}`).join(", ")} · ${config.targetFile.relativePath} · max ${config.maxLines} line${config.maxLines === 1 ? "" : "s"}`,
  );

  const originalText = await fs.readFile(
    config.targetFile.absolutePath,
    "utf8",
  );
  const validation = replaceSection(originalText, {
    sectionName: config.sectionName,
    lines: [],
  });
  if (!validation.found) {
    throw new ActionError(
      `Couldn't find the section markers in ${config.targetFile.relativePath}.`,
      {
        hint: `Add <!--START_SECTION:${config.sectionName}--> and <!--END_SECTION:${config.sectionName}--> to the file. See https://github.com/KetanDutt/github-activity-readme#quick-start.`,
      },
    );
  }
  if (validation.insertedEndMarker) {
    core.warning(
      `The END marker for section "${config.sectionName}" is missing. It will be added after the activity list.`,
    );
  }

  if (!config.token) {
    core.warning(
      "No GitHub token was provided. Unauthenticated requests are limited to 60 per hour.",
    );
  }

  const activity = await fetchWithGroup(core, () => {
    const client = createGitHubClient({
      token: config.token,
      apiUrl: config.apiUrl,
      userAgent: config.userAgent,
      fetchImpl,
      timeoutMs: config.requestTimeoutMs,
      sleep,
      onDebug: (message) => core.debug(message),
    });

    return fetchActivity({
      client,
      usernames: config.usernames,
      filter: config.filterSet,
      excludeRepos: config.excludeRepos,
      maxLines: config.maxLines,
      maxPages: config.maxEventPages,
      onDebug: (message) => core.debug(message),
    });
  });

  core.info(
    `Scanned ${activity.scanned} public event${activity.scanned === 1 ? "" : "s"} across ${activity.pages} API page${activity.pages === 1 ? "" : "s"}; ${activity.events.length} matched.`,
  );

  const lines = formatActivityLines(activity.events, {
    serverUrl: config.serverUrl,
    showTimestamps: config.showTimestamps,
    timestampFormat: config.timestampFormat,
    now,
    onError: (message, error) =>
      core.debug(`${message} ${error?.message || ""}`),
  });
  const sectionLines = buildSectionLines(lines);

  if (sectionLines.length === 0) {
    core.info(
      activity.events.length === 0
        ? `No matching public activity found for ${config.usernames.map((user) => `@${user}`).join(", ")}.`
        : "Matching events were found, but none could be rendered as activity lines.",
    );
    return finishWithoutChanges({
      core,
      config,
      cwd,
      run,
      sleep,
      secrets,
      activityCount: 0,
      preview: [],
      dryRun: config.dryRun,
      startedAt,
    });
  }

  const updated = replaceSection(originalText, {
    sectionName: config.sectionName,
    lines: sectionLines,
  });

  if (!updated.changed) {
    core.info("The activity section is already up to date.");
    return finishWithoutChanges({
      core,
      config,
      cwd,
      run,
      sleep,
      secrets,
      activityCount: sectionLines.length,
      preview: sectionLines,
      dryRun: config.dryRun,
      startedAt,
    });
  }

  if (config.dryRun) {
    core.info("Dry run enabled; the file and repository were not changed.");
    core.info(`Preview:\n${sectionLines.join("\n")}`);
    await writeSummary(core, {
      config,
      result: "dry-run",
      lines: sectionLines,
      changed: false,
      dryRun: true,
      commitSha: null,
    });
    const result = {
      result: "dry-run",
      changed: false,
      wouldChange: true,
      activityCount: sectionLines.length,
      targetFile: config.targetFile.relativePath,
      commitSha: null,
      preview: sectionLines,
    };
    setOutputs(core, result);
    return result;
  }

  const branch = await git.getCurrentBranch({
    cwd: config.workspace,
    run,
    secrets,
    onDebug: (message) => core.debug(message),
  });
  if (!branch) {
    throw new ActionError(
      "The repository is in detached HEAD state, so there is no branch to push to.",
      {
        hint: "Use actions/checkout with a branch ref. Scheduled workflows check out the default branch automatically; pull_request checks check out a merge commit.",
      },
    );
  }

  await fs.writeFile(config.targetFile.absolutePath, updated.text, "utf8");

  let commitSha = null;
  try {
    const outcome = await git.commitAndPush({
      file: config.targetFile.relativePath,
      message: config.commit.message,
      name: config.commit.name,
      email: config.commit.email,
      branch,
      cwd: config.workspace,
      retries: config.pushRetries,
      run,
      sleep,
      secrets,
      onDebug: (message) => core.debug(message),
    });

    if (!outcome.committed) {
      await fs.writeFile(config.targetFile.absolutePath, originalText, "utf8");
      throw new ActionError(
        "The activity section changed, but git reported nothing to commit.",
        {
          hint: "Check whether a clean/smudge filter or another process reverted the file.",
        },
      );
    }

    commitSha = outcome.sha;
  } catch (error) {
    if (!(error instanceof GitError && error.committed)) {
      await fs
        .writeFile(config.targetFile.absolutePath, originalText, "utf8")
        .catch(() => {});
      core.warning(
        `The update was rolled back because the commit could not be created: ${config.targetFile.relativePath}`,
      );
    }
    throw error;
  }

  core.info(
    `Updated ${config.targetFile.relativePath} with ${sectionLines.length} activit${sectionLines.length === 1 ? "y" : "ies"} and pushed commit ${commitSha ? commitSha.slice(0, 7) : "(unknown)"} to ${branch}.`,
  );

  const result = {
    result: "updated",
    changed: true,
    wouldChange: true,
    activityCount: sectionLines.length,
    targetFile: config.targetFile.relativePath,
    commitSha,
    preview: sectionLines,
  };
  setOutputs(core, result);
  await writeSummary(core, {
    config,
    result: "updated",
    lines: sectionLines,
    changed: true,
    dryRun: false,
    commitSha,
    branch,
  });

  core.debug(`Finished in ${Date.now() - startedAt}ms.`);
  return result;
}

/**
 * Handle "no events" and "already up to date" flows, including the optional
 * empty commit that keeps long-idle scheduled workflows enabled.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
async function finishWithoutChanges({
  core,
  config,
  cwd,
  run,
  sleep,
  secrets,
  activityCount,
  preview,
  dryRun,
  startedAt,
}) {
  let resultName = dryRun ? "dry-run" : "unchanged";
  let commitSha = null;

  if (!dryRun && config.emptyCommitDays > 0) {
    const empty = await createEmptyCommitIfStale({
      core,
      config,
      cwd,
      run,
      sleep,
      secrets,
    });
    if (empty) {
      resultName = "empty-commit";
      commitSha = empty.sha;
    }
  }

  const result = {
    result: resultName,
    changed: false,
    wouldChange: false,
    activityCount,
    targetFile: config.targetFile.relativePath,
    commitSha,
    preview,
  };
  setOutputs(core, result);
  await writeSummary(core, {
    config,
    result: resultName,
    lines: preview,
    changed: false,
    dryRun,
    commitSha,
  });
  core.debug(`Finished in ${Date.now() - startedAt}ms.`);
  return result;
}

/**
 * @param {object} options
 * @returns {Promise<{sha: string|null}|null>}
 */
async function createEmptyCommitIfStale({
  core,
  config,
  cwd,
  run,
  sleep,
  secrets,
}) {
  const ageDays = await git.getLastCommitAgeDays({
    now: config.now,
    cwd: config.workspace,
    run,
    secrets,
  });

  if (ageDays === null) {
    core.warning(
      "Could not determine the age of the last commit; skipping the empty commit check.",
    );
    return null;
  }

  core.debug(
    `The last commit was ${ageDays.toFixed(1)} day(s) ago (threshold: ${config.emptyCommitDays}).`,
  );

  if (ageDays < config.emptyCommitDays) {
    core.info(
      `No update needed. The last commit was ${Math.max(0, Math.floor(ageDays))} day(s) ago; an empty commit is only created after ${config.emptyCommitDays} day(s) without commits.`,
    );
    return null;
  }

  const branch = await git.getCurrentBranch({
    cwd: config.workspace,
    run,
    secrets,
    onDebug: (message) => core.debug(message),
  });
  if (!branch) {
    core.warning(
      "The repository is in detached HEAD state; skipping the empty commit.",
    );
    return null;
  }

  core.info(
    `The last commit was ${Math.floor(ageDays)} day(s) ago; creating an empty commit to keep the scheduled workflow active.`,
  );

  const outcome = await git.commitAndPush({
    allowEmpty: true,
    message: config.commit.emptyMessage,
    name: config.commit.name,
    email: config.commit.email,
    branch,
    cwd: config.workspace,
    retries: config.pushRetries,
    run,
    sleep,
    secrets,
    onDebug: (message) => core.debug(message),
  });

  return { sha: outcome.sha };
}

/**
 * @param {object} core
 * @param {Function} fn
 * @returns {Promise<*>}
 */
async function fetchWithGroup(core, fn) {
  core.startGroup("Fetching GitHub activity");
  try {
    return await fn();
  } finally {
    core.endGroup();
  }
}

/**
 * Publish action outputs. All outputs are strings, matching GitHub's output
 * contract.
 *
 * @param {object} core
 * @param {object} result
 */
function setOutputs(core, result) {
  core.setOutput("changed", String(result.changed));
  core.setOutput("activity_count", String(result.activityCount));
  core.setOutput("target_file", result.targetFile);
  core.setOutput("result", result.result);
  core.setOutput("commit_sha", result.commitSha || "");
}

/**
 * Write a compact job summary. Failures are non-fatal: summaries are a UI
 * nicety, not part of the action's contract.
 *
 * @param {object} core
 * @param {object} options
 */
async function writeSummary(
  core,
  { config, result, lines, changed, dryRun, commitSha, branch },
) {
  const summary = core.summary;
  if (!summary || typeof summary.addHeading !== "function") {
    return;
  }

  try {
    summary.addHeading("GitHub Activity in README", 2);

    const commitUrl =
      commitSha && config.repoSlug
        ? `${config.serverUrl}/${config.repoSlug}/commit/${commitSha}`
        : null;
    const commitCell = commitSha
      ? commitUrl
        ? `[\`${commitSha.slice(0, 7)}\`](${commitUrl})`
        : `\`${commitSha.slice(0, 7)}\``
      : "—";

    summary.addTable([
      [
        { data: "Setting", header: true },
        { data: "Value", header: true },
      ],
      [
        "Users",
        config.usernames
          .map((user) => `@${escapeMarkdown(user, 40)}`)
          .join(", "),
      ],
      [
        "Target file",
        `\`${escapeMarkdown(config.targetFile.relativePath, 100)}\``,
      ],
      ["Event filter", escapeMarkdown(config.filterEventTypes.join(", "), 300)],
      ["Maximum lines", String(config.maxLines)],
      ["Timestamps", config.showTimestamps ? config.timestampFormat : "off"],
      [
        "Result",
        result === "dry-run" && changed === false
          ? "dry run (no changes written)"
          : result,
      ],
      ["Commit", commitCell],
    ]);

    if (lines.length > 0) {
      summary.addHeading(dryRun ? "Preview (dry run)" : "Activity", 3);
      summary.addRaw(lines.join("\n"), true);
    } else if (result === "unchanged" || dryRun) {
      summary.addRaw(
        "No matching public activity was found; the section was left unchanged.",
        true,
      );
    }

    if (branch) {
      summary.addRaw(`Branch: \`${escapeMarkdown(branch, 100)}\``, true);
    }

    await summary.write();
  } catch (error) {
    core.debug(`Could not write the job summary: ${error.message}`);
  }
}

module.exports = {
  runAction,
  finishWithoutChanges,
  createEmptyCommitIfStale,
  setOutputs,
  writeSummary,
};
