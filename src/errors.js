"use strict";

/**
 * Base class for all errors that are safe (and useful) to show to action users.
 * Anything that is not an `ActionError` is treated as an unexpected failure and
 * is reported with a generic message plus its stack trace in debug logs.
 */
class ActionError extends Error {
  /**
   * @param {string} message - Human readable error message.
   * @param {object} [options]
   * @param {string} [options.hint] - Actionable next step shown after the message.
   * @param {Error} [options.cause] - Original error, if any.
   * @param {string} [options.code] - Stable machine readable error code.
   */
  constructor(message, { hint, cause, code } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = new.target.name;
    this.hint = hint;
    this.code = code;
  }
}

class ConfigError extends ActionError {}

class SectionError extends ActionError {}

class GitHubApiError extends ActionError {
  constructor(message, { status, hint, cause, code, retryAt } = {}) {
    super(message, { hint, cause, code });
    this.status = status;
    this.retryAt = retryAt;
  }
}

class GitError extends ActionError {
  constructor(
    message,
    { code, stdout, stderr, command, committed, hint } = {},
  ) {
    super(message, {
      hint,
      code: code === undefined ? undefined : String(code),
    });
    this.exitCode = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.command = command;
    this.committed = Boolean(committed);
  }
}

module.exports = {
  ActionError,
  ConfigError,
  SectionError,
  GitHubApiError,
  GitError,
};
