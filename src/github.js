"use strict";

const { GitHubApiError } = require("./errors");
const { compareEvents, dedupeById, sleep: defaultSleep } = require("./utils");
const { selectEvents } = require("./events");

const PER_PAGE = 100;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 8_000;

/**
 * Minimal GitHub REST client built on the Node.js fetch implementation.
 *
 * Using fetch instead of a full Octokit bundle keeps the action small and fast
 * while still supporting retries, rate-limit handling, timeouts, and GHES.
 *
 * @param {object} options
 * @param {string} [options.token]
 * @param {string} options.apiUrl
 * @param {string} options.userAgent
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxRetries]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {{request: Function, listPublicEvents: Function}}
 */
function createGitHubClient({
  token,
  apiUrl,
  userAgent,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  maxRetries = 3,
  sleep = defaultSleep,
  onDebug,
}) {
  if (typeof fetchImpl !== "function") {
    throw new GitHubApiError(
      "No fetch implementation is available. Node.js 18 or newer is required.",
    );
  }

  const baseUrl = String(apiUrl).replace(/\/+$/, "");

  /**
   * @param {string} pathname
   * @param {object} [options]
   * @param {Record<string, string|number>} [options.params]
   * @param {string} [options.context]
   * @returns {Promise<unknown>}
   */
  async function request(pathname, { params = {}, context = "" } = {}) {
    const url = new URL(
      `${baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`,
    );
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": userAgent || "github-activity-readme",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const label = context ? `${context}: ` : "";
    let attempt = 0;

    while (attempt <= maxRetries) {
      let response;
      try {
        response = await fetchImpl(url.toString(), {
          method: "GET",
          headers,
          signal: createTimeoutSignal(timeoutMs),
        });
      } catch (error) {
        if (attempt >= maxRetries) {
          throw new GitHubApiError(`${label}Could not reach the GitHub API.`, {
            cause: error,
            hint: "Check network connectivity, proxy settings, and GITHUB_API_URL. On self-hosted runners behind a proxy, set NODE_USE_ENV_PROXY=1.",
          });
        }
        const delay = backoff(attempt);
        onDebug?.(
          `${label}Network error, retrying in ${delay}ms (${attempt + 1}/${maxRetries}).`,
        );
        await sleep(delay);
        attempt += 1;
        continue;
      }

      if (response.ok) {
        try {
          return await response.json();
        } catch (error) {
          throw new GitHubApiError(
            `${label}GitHub API returned invalid JSON.`,
            {
              cause: error,
              status: response.status,
            },
          );
        }
      }

      const status = response.status;
      const errorBody = await readErrorBody(response);
      const apiMessage = errorBody.message ? ` ${errorBody.message}` : "";
      const hintSuffix = errorBody.documentation_url
        ? ` Documentation: ${errorBody.documentation_url}`
        : "";

      if (status === 401) {
        throw new GitHubApiError(
          `${label}GitHub rejected the token (401).${apiMessage}`,
          {
            status,
            code: "UNAUTHORIZED",
            hint: "Check that GITHUB_TOKEN is set, has not expired, and belongs to this repository/organization.",
          },
        );
      }

      if (status === 404) {
        throw new GitHubApiError(
          `${label}GitHub resource not found (404).${apiMessage}`,
          {
            status,
            code: "NOT_FOUND",
            hint: "Check GH_USERNAME. For private organization activity, the token must be able to see the repository and the organization may need to allow third-party access.",
          },
        );
      }

      if (status === 403 || status === 429) {
        const rateLimit = getRateLimitInfo(response.headers);
        const isRateLimited = status === 429 || rateLimit.remaining === 0;

        if (!isRateLimited) {
          throw new GitHubApiError(
            `${label}GitHub refused the request (${status}).${apiMessage}`,
            {
              status,
              code: "FORBIDDEN",
              hint: "Grant the workflow `permissions: contents: write` and make sure the token can read the requested public events.",
            },
          );
        }

        const waitMs = rateLimit.waitMs ?? BACKOFF_BASE_MS;
        if (waitMs <= MAX_RATE_LIMIT_WAIT_MS && attempt < maxRetries) {
          onDebug?.(
            `${label}Rate limited. Waiting ${waitMs}ms before retry (${attempt + 1}/${maxRetries}).`,
          );
          await sleep(waitMs);
          attempt += 1;
          continue;
        }

        throw new GitHubApiError(
          `${label}GitHub API rate limit exceeded.${apiMessage}`,
          {
            status,
            code: "RATE_LIMITED",
            retryAt: rateLimit.resetAt,
            hint: rateLimit.resetAt
              ? `The limit resets at ${rateLimit.resetAt.toISOString()}. The next scheduled run will pick up where this one stopped.`
              : "Wait for the rate limit to reset, or use a token with a higher limit.",
          },
        );
      }

      if (status >= 500 && attempt < maxRetries) {
        const delay = backoff(attempt);
        onDebug?.(
          `${label}GitHub API returned ${status}, retrying in ${delay}ms (${attempt + 1}/${maxRetries}).`,
        );
        await sleep(delay);
        attempt += 1;
        continue;
      }

      throw new GitHubApiError(
        `${label}GitHub API request failed (${status}).${apiMessage}${hintSuffix}`,
        { status, code: "HTTP_ERROR" },
      );
    }

    throw new GitHubApiError(
      `${label}GitHub API request failed after retries.`,
    );
  }

  /**
   * @param {string} username
   * @param {number} [page]
   * @param {number} [perPage]
   * @returns {Promise<object[]>}
   */
  async function listPublicEvents(username, page = 1, perPage = PER_PAGE) {
    const data = await request(
      `/users/${encodeURIComponent(username)}/events/public`,
      {
        params: { per_page: perPage, page },
        context: `Fetching public events for @${username}`,
      },
    );

    if (!Array.isArray(data)) {
      throw new GitHubApiError(
        `Unexpected non-list response while fetching events for @${username}.`,
        {
          hint: "The GitHub API returned a non-list response; this usually means GITHUB_API_URL points at a non-GitHub service.",
        },
      );
    }
    return data;
  }

  return { request, listPublicEvents };
}

/**
 * Fetch, filter, merge, sort, and trim recent activity for one or more users.
 *
 * Each user is fetched independently (in parallel) and up to `maxLines`
 * matching events are collected per user. Because every user contributes at
 * most `maxLines` events, the merged top `maxLines` is correct while keeping
 * the number of API requests low. Pagination refills the list when noisy or
 * filtered events would otherwise leave the section short.
 *
 * @param {object} options
 * @param {{listPublicEvents: Function}} options.client
 * @param {string[]} options.usernames
 * @param {Set<string>} options.filter
 * @param {Array<{pattern: string, regex: RegExp}>} [options.excludeRepos]
 * @param {number} [options.maxLines]
 * @param {number} [options.maxPages]
 * @param {(message: string) => void} [options.onDebug]
 * @returns {Promise<{events: object[], scanned: number, pages: number}>}
 */
async function fetchActivity({
  client,
  usernames,
  filter,
  excludeRepos = [],
  maxLines = 5,
  maxPages = 3,
  onDebug,
}) {
  let scanned = 0;
  let pages = 0;

  const perUser = await Promise.all(
    usernames.map(async (username) => {
      const selected = [];

      for (let page = 1; page <= maxPages; page += 1) {
        const events = await client.listPublicEvents(username, page, PER_PAGE);
        pages += 1;
        scanned += events.length;
        selected.push(...selectEvents(events, { filter, excludeRepos }));

        onDebug?.(
          `@${username} page ${page}: ${events.length} events, ${selected.length} matching so far.`,
        );

        if (selected.length >= maxLines || events.length < PER_PAGE) {
          break;
        }
      }

      return selected;
    }),
  );

  const events = dedupeById(perUser.flat())
    .sort(compareEvents)
    .slice(0, maxLines);

  return { events, scanned, pages };
}

/**
 * @param {number} timeoutMs
 * @returns {AbortSignal|undefined}
 */
function createTimeoutSignal(timeoutMs) {
  if (
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
  ) {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

/**
 * @param {Headers|Record<string, string>|undefined} headers
 * @returns {{remaining: number|null, waitMs: number|null, resetAt: Date|null}}
 */
function getRateLimitInfo(headers) {
  const remainingRaw = headerValue(headers, "x-ratelimit-remaining");
  const remaining =
    remainingRaw === null || remainingRaw === "" ? null : Number(remainingRaw);

  const resetRaw = headerValue(headers, "x-ratelimit-reset");
  const resetSeconds = resetRaw === null ? NaN : Number(resetRaw);
  const resetAt = Number.isFinite(resetSeconds)
    ? new Date(resetSeconds * 1000)
    : null;

  const retryAfterRaw = headerValue(headers, "retry-after");
  let waitMs = null;
  if (retryAfterRaw !== null && retryAfterRaw !== "") {
    const seconds = Number(retryAfterRaw);
    if (Number.isFinite(seconds)) {
      waitMs = Math.max(0, seconds * 1000);
    }
  } else if (resetAt) {
    waitMs = Math.max(0, resetAt.getTime() - Date.now());
  }

  return {
    remaining: Number.isFinite(remaining) ? remaining : null,
    waitMs,
    resetAt,
  };
}

/**
 * @param {unknown} headers
 * @param {string} name
 * @returns {string|null}
 */
function headerValue(headers, name) {
  if (!headers) {
    return null;
  }
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value === undefined ? null : value;
  }
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? null : String(headers[key]);
}

/**
 * @param {Response} response
 * @returns {Promise<{message?: string, documentation_url?: string}>}
 */
async function readErrorBody(response) {
  try {
    if (typeof response.json === "function") {
      const data = await response.json();
      if (data && typeof data === "object") {
        return {
          message: typeof data.message === "string" ? data.message : undefined,
          documentation_url:
            typeof data.documentation_url === "string"
              ? data.documentation_url
              : undefined,
        };
      }
    }
  } catch {
    // The response body is optional; the status code is enough.
  }
  return {};
}

/**
 * @param {number} attempt
 * @returns {number}
 */
function backoff(attempt) {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

module.exports = {
  PER_PAGE,
  createGitHubClient,
  fetchActivity,
  getRateLimitInfo,
  headerValue,
  backoff,
};
