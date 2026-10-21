"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createGitHubClient,
  fetchActivity,
  getRateLimitInfo,
  headerValue,
  backoff,
  PER_PAGE,
} = require("../src/github");
const { GitHubApiError } = require("../src/errors");
const { fakeResponse } = require("./helpers");

function makeClient(fetchImpl, overrides = {}) {
  return createGitHubClient({
    token: "test-token",
    apiUrl: "https://api.github.com",
    userAgent: "github-activity-readme/test",
    fetchImpl,
    maxRetries: 2,
    sleep: async () => {},
    ...overrides,
  });
}

function event(
  id,
  type = "WatchEvent",
  createdAt = "2026-10-21T10:00:00Z",
  repo = "octocat/hello",
) {
  return {
    id: String(id),
    type,
    created_at: createdAt,
    repo: { name: repo },
    payload: {},
  };
}

test("GitHub client sends the expected URL and headers", async () => {
  const calls = [];
  const client = makeClient(async (url, options) => {
    calls.push({ url, options });
    return fakeResponse([event(1)]);
  });

  const events = await client.listPublicEvents("octo cat", 2, 50);
  assert.equal(events.length, 1);
  assert.equal(calls.length, 1);

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/users/octo%20cat/events/public");
  assert.equal(url.searchParams.get("per_page"), "50");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
  assert.equal(
    calls[0].options.headers["User-Agent"],
    "github-activity-readme/test",
  );
  assert.equal(calls[0].options.headers.Accept, "application/vnd.github+json");
  assert.ok(calls[0].options.signal);
});

test("GitHub client omits Authorization when no token is provided", async () => {
  let headers;
  const client = makeClient(
    async (_url, options) => {
      headers = options.headers;
      return fakeResponse([]);
    },
    { token: "" },
  );
  await client.listPublicEvents("octocat");
  assert.equal(headers.Authorization, undefined);
});

test("retries 5xx responses with exponential backoff", async () => {
  const delays = [];
  const responses = [
    fakeResponse({ message: "oops" }, { status: 500 }),
    fakeResponse({ message: "oops" }, { status: 502 }),
    fakeResponse([event(1)]),
  ];
  const client = makeClient(async () => responses.shift(), {
    sleep: async (ms) => delays.push(ms),
  });

  const events = await client.listPublicEvents("octocat");
  assert.equal(events.length, 1);
  assert.deepEqual(delays, [1_000, 2_000]);
});

test("retries network errors", async () => {
  let attempts = 0;
  const client = makeClient(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new TypeError("fetch failed");
    }
    return fakeResponse([event(2)]);
  });

  const events = await client.listPublicEvents("octocat");
  assert.equal(events[0].id, "2");
  assert.equal(attempts, 3);
});

test("gives a friendly error after exhausting network retries", async () => {
  const client = makeClient(async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(
    () => client.listPublicEvents("octocat"),
    (error) =>
      error instanceof GitHubApiError &&
      /Could not reach the GitHub API/.test(error.message),
  );
});

test("does not retry 401 and 404 responses", async () => {
  let attempts = 0;
  const unauthorized = makeClient(async () => {
    attempts += 1;
    return fakeResponse({ message: "Bad credentials" }, { status: 401 });
  });
  await assert.rejects(
    () => unauthorized.listPublicEvents("octocat"),
    /rejected the token/,
  );
  assert.equal(attempts, 1);

  attempts = 0;
  const missing = makeClient(async () => {
    attempts += 1;
    return fakeResponse({ message: "Not Found" }, { status: 404 });
  });
  await assert.rejects(() => missing.listPublicEvents("nobody"), /not found/);
  assert.equal(attempts, 1);
});

test("handles rate limits that reset within the wait window", async () => {
  const delays = [];
  let attempts = 0;
  const reset = Math.floor(Date.now() / 1000) + 5;
  const client = makeClient(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        return fakeResponse(
          { message: "API rate limit exceeded" },
          {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(reset),
            },
          },
        );
      }
      return fakeResponse([event(1)]);
    },
    { sleep: async (ms) => delays.push(ms) },
  );

  const events = await client.listPublicEvents("octocat");
  assert.equal(events.length, 1);
  assert.equal(attempts, 2);
  assert.ok(delays[0] >= 0 && delays[0] <= 5_000);
});

test("fails fast when the rate limit reset is too far away", async () => {
  let attempts = 0;
  const client = makeClient(async () => {
    attempts += 1;
    return fakeResponse(
      { message: "API rate limit exceeded" },
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3_600),
        },
      },
    );
  });

  await assert.rejects(
    () => client.listPublicEvents("octocat"),
    (error) =>
      error instanceof GitHubApiError &&
      error.code === "RATE_LIMITED" &&
      error.retryAt instanceof Date,
  );
  assert.equal(attempts, 1);
});

test("403 responses that are not rate limits are not retried", async () => {
  let attempts = 0;
  const client = makeClient(async () => {
    attempts += 1;
    return fakeResponse(
      { message: "Resource not accessible by integration" },
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "42" },
      },
    );
  });

  await assert.rejects(
    () => client.listPublicEvents("octocat"),
    (error) => error.code === "FORBIDDEN",
  );
  assert.equal(attempts, 1);
});

test("429 Retry-After is respected", async () => {
  const delays = [];
  let attempts = 0;
  const client = makeClient(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        return fakeResponse(
          { message: "slow down" },
          { status: 429, headers: { "retry-after": "1" } },
        );
      }
      return fakeResponse([]);
    },
    { sleep: async (ms) => delays.push(ms) },
  );

  await client.listPublicEvents("octocat");
  assert.equal(delays[0], 1_000);
});

test("invalid JSON and non-list responses produce clear errors", async () => {
  const invalidJson = makeClient(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError("bad json");
    },
  }));
  await assert.rejects(
    () => invalidJson.listPublicEvents("octocat"),
    /invalid JSON/,
  );

  const notAList = makeClient(async () => fakeResponse({ hello: "world" }));
  await assert.rejects(
    () => notAList.listPublicEvents("octocat"),
    /non-list response/,
  );
});

test("fetchActivity stops once maxLines is reached", async () => {
  const page = Array.from({ length: PER_PAGE }, (_, index) =>
    event(index + 1, index < 5 ? "WatchEvent" : "ForkEvent"),
  );
  let calls = 0;
  const client = {
    async listPublicEvents() {
      calls += 1;
      return page;
    },
  };

  const result = await fetchActivity({
    client,
    usernames: ["octocat"],
    filter: new Set(["WatchEvent"]),
    maxLines: 3,
    maxPages: 3,
  });

  assert.equal(calls, 1);
  assert.equal(result.events.length, 3);
  assert.equal(result.pages, 1);
  assert.equal(result.scanned, PER_PAGE);
});

test("fetchActivity paginates when noisy events starve the feed", async () => {
  const noisy = Array.from({ length: PER_PAGE }, (_, index) =>
    event(index + 1, "ForkEvent"),
  );
  const useful = Array.from({ length: 5 }, (_, index) =>
    event(1000 + index, "WatchEvent"),
  );
  const pages = [noisy, useful];
  let calls = 0;
  const client = {
    async listPublicEvents() {
      calls += 1;
      return pages.shift() ?? [];
    },
  };

  const result = await fetchActivity({
    client,
    usernames: ["octocat"],
    filter: new Set(["WatchEvent"]),
    maxLines: 5,
    maxPages: 3,
  });

  assert.equal(calls, 2);
  assert.equal(result.events.length, 5);
  assert.equal(result.pages, 2);
  assert.equal(result.scanned, PER_PAGE + 5);
});

test("fetchActivity respects maxPages and stops on a short page", async () => {
  const full = Array.from({ length: PER_PAGE }, (_, index) =>
    event(index + 1, "ForkEvent"),
  );
  let calls = 0;
  const client = {
    async listPublicEvents() {
      calls += 1;
      return full;
    },
  };

  const result = await fetchActivity({
    client,
    usernames: ["octocat"],
    filter: new Set(["WatchEvent"]),
    maxLines: 5,
    maxPages: 2,
  });
  assert.equal(calls, 2);
  assert.equal(result.events.length, 0);

  calls = 0;
  const short = {
    async listPublicEvents() {
      calls += 1;
      return [event(1, "WatchEvent")];
    },
  };
  const shortResult = await fetchActivity({
    client: short,
    usernames: ["octocat"],
    filter: new Set(["WatchEvent"]),
    maxLines: 5,
    maxPages: 3,
  });
  assert.equal(calls, 1);
  assert.equal(shortResult.events.length, 1);
});

test("fetchActivity merges multiple users, deduplicates, and sorts by date", async () => {
  const byUser = {
    alice: [
      event(1, "WatchEvent", "2026-10-20T10:00:00Z", "alice/a"),
      event(2, "WatchEvent", "2026-10-22T10:00:00Z", "alice/a"),
    ],
    bob: [
      event(3, "WatchEvent", "2026-10-21T10:00:00Z", "bob/b"),
      event(2, "WatchEvent", "2026-10-22T10:00:00Z", "alice/a"),
    ],
  };
  const client = {
    async listPublicEvents(username) {
      return byUser[username] ?? [];
    },
  };

  const result = await fetchActivity({
    client,
    usernames: ["alice", "bob"],
    filter: new Set(["WatchEvent"]),
    maxLines: 10,
    maxPages: 1,
  });

  assert.deepEqual(
    result.events.map((item) => item.id),
    ["2", "3", "1"],
  );
});

test("fetchActivity applies repository exclusions before trimming", async () => {
  const client = {
    async listPublicEvents() {
      return [
        event(1, "WatchEvent", "2026-10-21T10:00:00Z", "octocat/noise"),
        event(2, "WatchEvent", "2026-10-20T10:00:00Z", "octocat/keep"),
      ];
    },
  };

  const { compileRepoPatterns } = require("../src/events");
  const result = await fetchActivity({
    client,
    usernames: ["octocat"],
    filter: new Set(["WatchEvent"]),
    excludeRepos: compileRepoPatterns(["octocat/noise"]),
    maxLines: 5,
    maxPages: 1,
  });

  assert.deepEqual(
    result.events.map((item) => item.id),
    ["2"],
  );
});

test("getRateLimitInfo parses plain and Headers-like objects", () => {
  const reset = Math.floor(Date.now() / 1000) + 30;
  const info = getRateLimitInfo({
    "X-RateLimit-Remaining": "0",
    "x-ratelimit-reset": String(reset),
    "Retry-After": "2",
  });
  assert.equal(info.remaining, 0);
  assert.equal(info.waitMs, 2_000);
  assert.ok(info.resetAt instanceof Date);

  assert.equal(headerValue({ "X-Test": "a" }, "x-test"), "a");
  assert.equal(headerValue(null, "x-test"), null);
  assert.equal(headerValue(new Map(), "x-test"), null);
});

test("backoff is bounded", () => {
  assert.equal(backoff(0), 1_000);
  assert.equal(backoff(1), 2_000);
  assert.equal(backoff(10), 8_000);
});
