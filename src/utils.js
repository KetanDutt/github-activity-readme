"use strict";

const MAX_DISPLAY_LENGTH = 80;
const MAX_RELEASE_NAME_LENGTH = 60;

/**
 * Collapse whitespace and control characters, then truncate a value.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
function cleanText(value, maxLength = MAX_DISPLAY_LENGTH) {
  if (value === null || value === undefined) {
    return "";
  }

  const normalized = String(value)
    // Control characters (including newlines and tabs) have no place in a
    // single line markdown list item.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/**
 * Escape text so that untrusted values (release names, labels, ...) cannot
 * introduce HTML or markdown into the generated section.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
function escapeMarkdown(value, maxLength = MAX_DISPLAY_LENGTH) {
  return cleanText(value, maxLength)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]()~|])/g, "\\$1");
}

/**
 * Escape text for use inside an inline code span.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
function escapeInlineCode(value, maxLength = MAX_DISPLAY_LENGTH) {
  return cleanText(value, maxLength).replace(/`/g, "'");
}

/**
 * Format a short, human friendly, markdown-safe date.
 *
 * @param {string|number|Date} value
 * @param {"date"|"datetime"|"relative"} format
 * @param {Date} [now]
 * @returns {string}
 */
function formatTimestamp(value, format = "date", now = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  switch (format) {
    case "datetime": {
      const iso = date.toISOString(); // 2026-10-21T12:34:56.000Z
      return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
    }
    case "relative":
      return formatRelativeTime(date, now);
    case "date":
    default:
      return date.toISOString().slice(0, 10);
  }
}

/**
 * Render a "<sub>…</sub>" timestamp suffix, or an empty string when disabled.
 *
 * @param {string|number|Date} value
 * @param {object} options
 * @param {boolean} options.showTimestamps
 * @param {"date"|"datetime"|"relative"} options.timestampFormat
 * @param {Date} options.now
 * @returns {string}
 */
function timestampSuffix(value, { showTimestamps, timestampFormat, now }) {
  if (!showTimestamps) {
    return "";
  }
  const formatted = formatTimestamp(value, timestampFormat, now);
  return formatted ? ` · <sub>${escapeMarkdown(formatted, 40)}</sub>` : "";
}

/**
 * @param {Date} date
 * @param {Date} now
 * @returns {string}
 */
function formatRelativeTime(date, now = new Date()) {
  const elapsedMs = now.getTime() - date.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return "just now";
  }

  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 45) {
    return "just now";
  }

  const units = [
    { limit: 90, divisor: 60, singular: "minute" },
    { limit: 45 * 60, divisor: 60, singular: "minute" },
    { limit: 90 * 60, divisor: 60 * 60, singular: "hour" },
    { limit: 22 * 60 * 60, divisor: 60 * 60, singular: "hour" },
    { limit: 36 * 60 * 60, divisor: 24 * 60 * 60, singular: "day" },
    { limit: 26 * 24 * 60 * 60, divisor: 24 * 60 * 60, singular: "day" },
    {
      limit: 45 * 24 * 60 * 60,
      divisor: 30 * 24 * 60 * 60,
      singular: "month",
    },
    {
      limit: 320 * 24 * 60 * 60,
      divisor: 30 * 24 * 60 * 60,
      singular: "month",
    },
    {
      limit: 548 * 24 * 60 * 60,
      divisor: 365 * 24 * 60 * 60,
      singular: "year",
    },
  ];

  for (const unit of units) {
    if (seconds < unit.limit) {
      const count = Math.max(1, Math.round(seconds / unit.divisor));
      return `${count} ${unit.singular}${count === 1 ? "" : "s"} ago`;
    }
  }

  const years = Math.max(1, Math.round(seconds / (365 * 24 * 60 * 60)));
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/**
 * Parse a GitHub Actions style boolean input.
 *
 * @param {unknown} value
 * @param {string} name - Name used in error messages.
 * @returns {boolean}
 */
function parseBoolean(value, name) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off", ""].includes(normalized)) {
    return false;
  }

  const { ConfigError } = require("./errors");
  throw new ConfigError(
    `Invalid value for ${name}: "${value}". Use true or false.`,
  );
}

/**
 * Parse an integer input within an inclusive range.
 *
 * @param {unknown} value
 * @param {string} name
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function parseInteger(value, name, min, max, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const parsed = Number(String(value).trim());
  const { ConfigError } = require("./errors");
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(
      `Invalid value for ${name}: "${value}". Use an integer.`,
    );
  }
  if (parsed < min || parsed > max) {
    throw new ConfigError(
      `Invalid value for ${name}: ${parsed}. Use an integer between ${min} and ${max}.`,
    );
  }

  return parsed;
}

/**
 * Parse a comma separated list, trimming entries and removing duplicates.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function parseList(value) {
  if (value === null || value === undefined) {
    return [];
  }

  const seen = new Set();
  const result = [];
  for (const part of String(value).split(",")) {
    const item = part.trim();
    const key = item.toLowerCase();
    if (!item || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * Compare two GitHub events, newest first. Ties are broken by id so output is
 * stable between runs (important to avoid noisy commits).
 *
 * @param {{created_at?: string, id?: string|number}} a
 * @param {{created_at?: string, id?: string|number}} b
 * @returns {number}
 */
function compareEvents(a, b) {
  const aTime = Date.parse(a?.created_at ?? "");
  const bTime = Date.parse(b?.created_at ?? "");
  const safeATime = Number.isNaN(aTime) ? 0 : aTime;
  const safeBTime = Number.isNaN(bTime) ? 0 : bTime;

  if (safeATime !== safeBTime) {
    return safeBTime - safeATime;
  }

  return compareIdsDescending(a?.id, b?.id);
}

/**
 * @param {string|number|undefined} a
 * @param {string|number|undefined} b
 * @returns {number}
 */
function compareIdsDescending(a, b) {
  const aId = Number(a);
  const bId = Number(b);
  if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) {
    return bId - aId;
  }
  return String(b ?? "").localeCompare(String(a ?? ""));
}

/**
 * Remove duplicate events by id, keeping the first occurrence.
 *
 * @template T
 * @param {T[]} events
 * @returns {T[]}
 */
function dedupeById(events) {
  const seen = new Set();
  const result = [];
  for (const event of events) {
    const id = event?.id;
    if (id !== undefined && id !== null) {
      const key = String(id);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    result.push(event);
  }
  return result;
}

/**
 * Remove credentials and tokens from text that is about to be logged.
 *
 * @param {unknown} value
 * @param {string[]} [secrets] - Exact secret values (for example the token).
 * @returns {string}
 */
function redactSecrets(value, secrets = []) {
  let text = String(value ?? "");

  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      text = text.split(secret).join("***");
    }
  }

  return text
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_***")
    .replace(/(x-access-token:)[^@\s]+/gi, "$1***")
    .replace(/(Authorization:\s*(?:Bearer|token)\s+)\S+/gi, "$1***")
    .replace(/https:\/\/[^/@\s]+@github\.com/gi, "https://***@github.com");
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

module.exports = {
  MAX_DISPLAY_LENGTH,
  MAX_RELEASE_NAME_LENGTH,
  cleanText,
  escapeMarkdown,
  escapeInlineCode,
  formatTimestamp,
  formatRelativeTime,
  timestampSuffix,
  parseBoolean,
  parseInteger,
  parseList,
  compareEvents,
  dedupeById,
  redactSecrets,
  sleep,
  isPlainObject,
};
