"use strict";

const { ActionError } = require("./src/errors");
const { runAction } = require("./src/action");
const { redactSecrets } = require("./src/utils");
const { createLogger } = require("./src/logger");

const core = createLogger();

runAction({ core }).catch((error) => {
  const token =
    process.env.INPUT_GITHUB_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    "";
  const secrets = token ? [token] : [];

  const message = redactSecrets(
    error instanceof ActionError
      ? error.message
      : `Unexpected error: ${error?.message || String(error)}`,
    secrets,
  );
  const hint = error instanceof ActionError ? error.hint : undefined;
  const fullMessage = hint ? `${message}\n\nHint: ${hint}` : message;

  core.setFailed(fullMessage);
  if (error?.stack) {
    core.debug(redactSecrets(error.stack, secrets));
  }
});
