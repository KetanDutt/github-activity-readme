"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
  isPlainObject,
} = require("../src/utils");
const { ConfigError } = require("../src/errors");

test("escapeMarkdown neutralises HTML and markdown control characters", () => {
  assert.equal(
    escapeMarkdown("a & <b> [c](d) *e* _f_"),
    "a &amp; &lt;b&gt; \\[c\\]\\(d\\) \\*e\\* \\_f\\_",
  );
  assert.equal(escapeMarkdown("line\nbreak"), "line break");
  assert.equal(escapeMarkdown(null), "");
});

test("cleanText collapses whitespace and truncates with an ellipsis", () => {
  assert.equal(cleanText("  a \t b \n c  "), "a b c");
  assert.equal(cleanText("abcdefgh", 5), "abcd…");
  assert.equal(cleanText(undefined), "");
});

test("escapeInlineCode removes backticks and newlines", () => {
  assert.equal(escapeInlineCode("a`b\nc"), "a'b c");
});

test("formatTimestamp renders date, datetime, and relative values in UTC", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  assert.equal(
    formatTimestamp("2026-10-20T23:59:00Z", "date", now),
    "2026-10-20",
  );
  assert.equal(
    formatTimestamp("2026-10-20T23:59:00Z", "datetime", now),
    "2026-10-20 23:59 UTC",
  );
  assert.equal(
    formatTimestamp("2026-10-20T09:00:00Z", "relative", now),
    "1 day ago",
  );
  assert.equal(formatTimestamp("not-a-date", "date", now), "");
});

test("formatRelativeTime handles every unit boundary", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const ago = (ms) => formatRelativeTime(new Date(now.getTime() - ms), now);

  assert.equal(ago(10_000), "just now");
  assert.equal(ago(5 * 60_000), "5 minutes ago");
  assert.equal(ago(1 * 60 * 60_000), "1 hour ago");
  assert.equal(ago(3 * 24 * 60 * 60_000), "3 days ago");
  assert.equal(ago(40 * 24 * 60 * 60_000), "1 month ago");
  assert.equal(ago(400 * 24 * 60 * 60_000), "1 year ago");
  assert.equal(ago(2 * 365 * 24 * 60 * 60_000), "2 years ago");
});

test("timestampSuffix is empty unless enabled", () => {
  const options = {
    showTimestamps: false,
    timestampFormat: "date",
    now: new Date("2026-10-21T12:00:00Z"),
  };
  assert.equal(timestampSuffix("2026-10-21T10:00:00Z", options), "");
  assert.equal(
    timestampSuffix("2026-10-21T10:00:00Z", {
      ...options,
      showTimestamps: true,
    }),
    " · <sub>2026-10-21</sub>",
  );
});

test("parseBoolean accepts common spellings and rejects junk", () => {
  for (const value of [true, "true", "TRUE", "1", "yes", "on"]) {
    assert.equal(parseBoolean(value, "FLAG"), true);
  }
  for (const value of [false, "false", "0", "no", "off", ""]) {
    assert.equal(parseBoolean(value, "FLAG"), false);
  }
  assert.throws(() => parseBoolean("maybe", "FLAG"), ConfigError);
});

test("parseInteger validates bounds and integral values", () => {
  assert.equal(parseInteger("5", "N", 1, 10, 3), 5);
  assert.equal(parseInteger("", "N", 1, 10, 3), 3);
  assert.throws(() => parseInteger("1.5", "N", 1, 10, 3), ConfigError);
  assert.throws(() => parseInteger("0", "N", 1, 10, 3), ConfigError);
  assert.throws(() => parseInteger("abc", "N", 1, 10, 3), ConfigError);
});

test("parseList trims, deduplicates case-insensitively, and keeps order", () => {
  assert.deepEqual(parseList("a, B , a,, b ,c"), ["a", "B", "c"]);
  assert.deepEqual(parseList(""), []);
});

test("compareEvents sorts newest first and breaks ties by id", () => {
  const events = [
    { id: "1", created_at: "2026-10-20T10:00:00Z" },
    { id: "3", created_at: "2026-10-21T10:00:00Z" },
    { id: "2", created_at: "2026-10-21T10:00:00Z" },
  ];
  assert.deepEqual(
    events.sort(compareEvents).map((event) => event.id),
    ["3", "2", "1"],
  );
});

test("dedupeById keeps the first occurrence", () => {
  assert.deepEqual(
    dedupeById([{ id: "1", value: "a" }, { id: "1", value: "b" }, { id: "2" }]),
    [{ id: "1", value: "a" }, { id: "2" }],
  );
});

test("redactSecrets removes exact tokens and GitHub token patterns", () => {
  const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const text = `token ${token} and github_pat_abcdefghijklmnopqrstuvwxyz and x-access-token:secret`;
  const redacted = redactSecrets(text, [token]);
  assert.ok(!redacted.includes(token));
  assert.ok(!redacted.includes("github_pat_abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!redacted.includes("x-access-token:secret"));
  assert.ok(redacted.includes("***"));
});

test("isPlainObject only accepts plain object-like values", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject("x"), false);
});
