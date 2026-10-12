import { ensure, GovernanceError } from "./contract.ts";
export interface API {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  list(path: string): Promise<unknown[]>;
}
export class ApiError extends GovernanceError {
  readonly status: number;
  constructor(status: number, method: string) {
    super(`GitHub ${method} failed (HTTP ${status}); response suppressed`);
    this.status = status;
  }
}
export class GitHub implements API {
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly token: string;
  constructor(
    token: string,
    options: {
      fetcher?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      timeout?: number;
    } = {},
  ) {
    this.token = token;
    ensure(
      token.length > 0 && !/\s/.test(token),
      "Credential is missing or malformed",
    );
    this.fetcher = options.fetcher ?? fetch;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.timeout = options.timeout ?? 15000;
  }
  private readonly timeout: number;
  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    ensure(
      /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[/?][A-Za-z0-9_./%?=&~-]*)?$/.test(
        path,
      ) && !path.includes(".."),
      "Unsafe API path",
    );
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher("https://api.github.com" + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: AbortSignal.timeout(this.timeout),
        });
      } catch {
        // A timed-out POST may already have committed. Reinspect on the next apply.
        if (method === "GET" && attempt < 3) {
          await this.sleep(250 * 2 ** attempt);
          continue;
        }
        throw new GovernanceError(
          `GitHub ${method} transport failure; response suppressed; rerun to inspect state`,
        );
      }
      if (response.ok) {
        if (response.status === 204) return null;
        try {
          return await response.json();
        } catch {
          throw new GovernanceError("Malformed GitHub JSON response");
        }
      }
      const retryAfter = response.headers.get("retry-after");
      const retryMs =
        retryAfter === null
          ? NaN
          : /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Date.parse(retryAfter) - this.now();
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (Number.isFinite(retryMs) ||
            response.headers.get("x-ratelimit-remaining") === "0"));
      const transient = response.status >= 500 && response.status <= 599;
      // Never blindly retry a mutation: especially POST could create duplicates.
      if (method === "GET" && attempt < 3 && (rateLimited || transient)) {
        const reset =
          Number(response.headers.get("x-ratelimit-reset")) * 1000 - this.now();
        const delay = Number.isFinite(retryMs)
          ? Math.max(0, retryMs)
          : rateLimited && reset > 0
            ? reset
            : 250 * 2 ** attempt;
        ensure(
          delay <= 30000,
          "GitHub retry delay exceeds bounded wait; retry later",
        );
        await this.sleep(delay);
        continue;
      }
      throw new ApiError(response.status, method);
    }
    throw new GovernanceError("GitHub retry limit reached");
  }
  async list(path: string): Promise<unknown[]> {
    const result: unknown[] = [];
    // Numeric same-origin pagination avoids following untrusted Link URLs.
    for (let page = 1; page <= 100; page++) {
      const items = await this.request(
        "GET",
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      ensure(
        Array.isArray(items) && items.length <= 100,
        "Malformed GitHub list response",
      );
      result.push(...items);
      if (items.length < 100) return result;
    }
    throw new GovernanceError("GitHub pagination limit reached");
  }
}
