"use strict";

const { spawn } = require("node:child_process");

const { GitError } = require("./errors");
const { redactSecrets, sleep: defaultSleep } = require("./utils");

const OUTPUT_LIMIT_BYTES = 512 * 1024;
const BACKOFF_BASE_MS = 1_000;

/**
 * Run a git command without a shell.
 *
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {number[]} [options.allowExitCodes]
 * @param {string[]} [options.secrets]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runGit(
  args,
  {
    cwd = process.cwd(),
    env = {},
    timeoutMs = 60_000,
    allowExitCodes = [],
    secrets = [],
    onDebug,
  } = {},
) {
  const command = formatCommand(args);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    onDebug?.(`Running: ${redactSecrets(command, secrets)}`);

    let child;
    try {
      child = spawn("git", args, {
        cwd,
        env: {
          ...process.env,
          ...env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          PAGER: "cat",
          LC_ALL: process.env.LC_ALL || "C",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        killSignal: "SIGTERM",
        windowsHide: true,
      });
    } catch (error) {
      reject(
        new GitError(`Could not start git: ${error.message}`, {
          cause: error,
          command: redactSecrets(command, secrets),
        }),
      );
      return;
    }

    child.stdout?.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      const message =
        error.code === "ENOENT"
          ? "The git executable was not found."
          : `Could not run git: ${error.message}`;
      reject(
        new GitError(message, {
          cause: error,
          code: error.code,
          command: redactSecrets(command, secrets),
          stdout: redactSecrets(stdout, secrets),
          stderr: redactSecrets(stderr, secrets),
          hint:
            error.code === "ENOENT"
              ? "Install git and make sure it is available on PATH. GitHub-hosted runners include git."
              : undefined,
        }),
      );
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;

      const safeStdout = redactSecrets(stdout, secrets);
      const safeStderr = redactSecrets(stderr, secrets);
      const succeeded = code === 0 || allowExitCodes.includes(code);

      if (succeeded) {
        resolve({ code, stdout: safeStdout, stderr: safeStderr });
        return;
      }

      const output = (safeStderr.trim() || safeStdout.trim()).slice(0, 2000);
      const reason =
        signal === "SIGTERM"
          ? `timed out after ${timeoutMs}ms`
          : `exited with code ${code}`;
      reject(
        new GitError(
          `git ${args[0] || ""} ${reason}${output ? `: ${output}` : ""}`.trim(),
          {
            code,
            stdout: safeStdout,
            stderr: safeStderr,
            command: redactSecrets(command, secrets),
            hint: gitHintFor(output),
          },
        ),
      );
    });
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {Function} [options.run]
 * @param {string[]} [options.secrets]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {Promise<string|null>}
 */
async function getCurrentBranch({
  cwd,
  run = runGit,
  secrets = [],
  onDebug,
} = {}) {
  const result = await run(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    allowExitCodes: [1, 128],
    secrets,
    onDebug,
  });

  if (result.code !== 0) {
    return null;
  }
  const branch = result.stdout.trim();
  return branch || null;
}

/**
 * @param {object} options
 * @param {string} options.file
 * @param {object} [options.runGitOptions]
 * @returns {Promise<boolean>}
 */
async function hasStagedChanges(file, { run = runGit, ...options } = {}) {
  const result = await run(["diff", "--cached", "--quiet", "--", file], {
    ...options,
    allowExitCodes: [1],
  });
  return result.code === 1;
}

/**
 * Stage a single file. `--` prevents a filename that starts with `-` from
 * being interpreted as an option.
 *
 * @param {string} file
 * @param {object} [options]
 * @returns {Promise<void>}
 */
async function stageFile(file, { run = runGit, ...options } = {}) {
  await run(["add", "--", file], options);
}

/**
 * @param {object} [options]
 * @returns {Promise<string|null>}
 */
async function getHeadSha({ run = runGit, ...options } = {}) {
  try {
    const result = await run(["rev-parse", "HEAD"], options);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Commit changes to a single file (or create an empty commit).
 *
 * Only the target file is committed, so unrelated staged changes from earlier
 * workflow steps are not swept into the activity commit.
 *
 * @param {object} options
 * @param {string} options.file
 * @param {string} options.message
 * @param {string} options.name
 * @param {string} options.email
 * @param {boolean} [options.allowEmpty]
 * @param {string} [options.cwd]
 * @param {Function} [options.run]
 * @param {string[]} [options.secrets]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {Promise<{committed: boolean, sha: string|null}>}
 */
async function commitFile({
  file,
  message,
  name,
  email,
  allowEmpty = false,
  cwd,
  run = runGit,
  secrets = [],
  onDebug,
}) {
  const base = { cwd, secrets, onDebug };

  if (!allowEmpty) {
    await stageFile(file, { ...base, run });
    const staged = await hasStagedChanges(file, { ...base, run });
    if (!staged) {
      return { committed: false, sha: await getHeadSha({ ...base, run }) };
    }
  }

  const args = [
    "-c",
    `user.name=${name}`,
    "-c",
    `user.email=${email}`,
    "commit",
    ...(allowEmpty ? ["--allow-empty"] : ["--only"]),
    "-m",
    message,
    ...(allowEmpty ? [] : ["--", file]),
  ];

  await run(args, { ...base, timeoutMs: 120_000 });
  return { committed: true, sha: await getHeadSha({ ...base, run }) };
}

/**
 * Push the current commit to the branch checked out in the workflow.
 * If another run pushed in the meantime, rebase and retry.
 *
 * @param {object} options
 * @param {string} options.branch
 * @param {string} [options.cwd]
 * @param {number} [options.retries]
 * @param {Function} [options.run]
 * @param {Function} [options.sleep]
 * @param {string[]} [options.secrets]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {Promise<void>}
 */
async function pushBranch({
  branch,
  name,
  email,
  cwd,
  retries = 3,
  run = runGit,
  sleep = defaultSleep,
  secrets = [],
  onDebug,
}) {
  if (!branch) {
    throw new GitError(
      "Cannot push because the repository is in detached HEAD state.",
      {
        hint: "Use actions/checkout with a branch ref (the default for scheduled workflows) so the action can push to it.",
      },
    );
  }

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await run(["push", "origin", `HEAD:refs/heads/${branch}`], {
        cwd,
        timeoutMs: 120_000,
        secrets,
        onDebug,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isNonFastForward(error)) {
        throw error;
      }

      onDebug?.(
        `Push was rejected (attempt ${attempt + 1}/${retries + 1}); rebasing on origin/${branch}.`,
      );

      const identityArgs =
        name && email
          ? ["-c", `user.name=${name}`, "-c", `user.email=${email}`]
          : [];

      try {
        await run(
          [
            ...identityArgs,
            "pull",
            "--rebase",
            "--autostash",
            "origin",
            branch,
          ],
          { cwd, timeoutMs: 120_000, secrets, onDebug },
        );
      } catch (pullError) {
        await run(["rebase", "--abort"], {
          cwd,
          allowExitCodes: [1, 128],
          secrets,
          onDebug,
        }).catch(() => {});
        throw new GitError(
          `Could not rebase local changes on origin/${branch}: ${pullError.message}`,
          {
            cause: pullError,
            hint: "Another workflow run may have updated the same file. Re-run the workflow; if the conflict persists, commit or discard local changes.",
          },
        );
      }

      await sleep(BACKOFF_BASE_MS * (attempt + 1));
    }
  }

  throw lastError;
}

/**
 * @param {object} options
 * @param {string} options.file
 * @param {string} options.message
 * @param {string} options.name
 * @param {string} options.email
 * @param {string} options.branch
 * @param {boolean} [options.allowEmpty]
 * @param {number} [options.retries]
 * @param {string} [options.cwd]
 * @param {Function} [options.run]
 * @param {Function} [options.sleep]
 * @param {string[]} [options.secrets]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {Promise<{committed: boolean, pushed: boolean, sha: string|null}>}
 */
async function commitAndPush({
  file,
  message,
  name,
  email,
  branch,
  allowEmpty = false,
  retries = 3,
  cwd,
  run = runGit,
  sleep = defaultSleep,
  secrets = [],
  onDebug,
}) {
  const commit = await commitFile({
    file,
    message,
    name,
    email,
    allowEmpty,
    cwd,
    run,
    secrets,
    onDebug,
  });

  if (!commit.committed) {
    return { committed: false, pushed: false, sha: commit.sha };
  }

  try {
    await pushBranch({
      branch,
      name,
      email,
      cwd,
      retries,
      run,
      sleep,
      secrets,
      onDebug,
    });
  } catch (error) {
    if (error instanceof GitError) {
      error.committed = true;
    }
    throw error;
  }

  return { committed: true, pushed: true, sha: commit.sha };
}

/**
 * Age of the newest commit on the current branch, in days.
 *
 * @param {object} options
 * @param {Date} [options.now]
 * @param {string} [options.cwd]
 * @param {Function} [options.run]
 * @param {string[]} [options.secrets]
 * @returns {Promise<number|null>}
 */
async function getLastCommitAgeDays({
  now = new Date(),
  cwd,
  run = runGit,
  secrets = [],
} = {}) {
  let result;
  try {
    result = await run(["log", "-1", "--format=%ct"], {
      cwd,
      allowExitCodes: [128],
      secrets,
    });
  } catch {
    return null;
  }

  if (result.code !== 0) {
    return null;
  }

  const seconds = Number(result.stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return (now.getTime() / 1000 - seconds) / (60 * 60 * 24);
}

/**
 * @param {GitError} error
 * @returns {boolean}
 */
function isNonFastForward(error) {
  const text = `${error?.stderr || ""}\n${error?.stdout || ""}\n${error?.message || ""}`;
  return /non-fast-forward|fetch first|Updates were rejected|failed to push some refs|rejected/i.test(
    text,
  );
}

/**
 * @param {string} output
 * @returns {string|undefined}
 */
function gitHintFor(output) {
  if (
    /Permission denied|Authentication failed|could not read Username|terminal prompts disabled/i.test(
      output,
    )
  ) {
    return "The workflow token cannot push. Add `permissions: contents: write` and use actions/checkout with persist-credentials enabled.";
  }
  if (/protected branch|GH006|required status/i.test(output)) {
    return "The target branch is protected. Allow the GitHub Actions bot to push, or run the action against an unprotected branch.";
  }
  if (/pre-commit|husky|lint-staged|hook/i.test(output)) {
    return "A git hook rejected the commit. Fix the reported hook error or disable the hook for automated commits.";
  }
  return undefined;
}

/**
 * @param {string} current
 * @param {Buffer|string} chunk
 * @returns {string}
 */
function appendLimited(current, chunk) {
  const next = current + chunk.toString();
  return next.length > OUTPUT_LIMIT_BYTES
    ? next.slice(next.length - OUTPUT_LIMIT_BYTES)
    : next;
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function formatCommand(args) {
  return `git ${args
    .map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg))
    .join(" ")}`;
}

module.exports = {
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
};
