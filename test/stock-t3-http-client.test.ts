import { describe, expect, test } from "bun:test";

import {
  StockT3HttpError,
  createStockT3HttpClient,
} from "../src/stockT3HttpClient";

const descriptor = {
  environmentId: "env-1",
  label: "local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "stock",
  capabilities: { repositoryIdentity: false },
};

describe("stock T3 HTTP client", () => {
  test("records redacted endpoint/status traces and actual request counters", async () => {
    const client = createStockT3HttpClient({
      baseUrl: "http://stock.invalid",
      bearerToken: "must-not-appear",
      fetch: async (input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        return Response.json(descriptor, { status: 200 });
      },
    });

    await client.getDescriptor();

    expect(client.observations()).toEqual({
      requestCount: 1,
      inFlight: 0,
      peakInFlight: 1,
      endpointStatusTrace: [
        { method: "GET", path: "/.well-known/t3/environment", status: 200 },
      ],
    });
    expect(JSON.stringify(client.observations())).not.toContain("must-not-appear");
  });
  test("uses only descriptor, shell, detail, dispatch, and token HTTP routes", async () => {
    const requests: Request[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/.well-known/t3/environment")) {
        return Response.json(descriptor);
      }
      if (request.url.endsWith("/api/orchestration/shell")) {
        return Response.json({
          snapshotSequence: 0,
          projects: [],
          threads: [],
          updatedAt: "2026-07-31T18:00:00.000Z",
        });
      }
      if (request.url.endsWith("/api/orchestration/threads/thread%2Fone")) {
        return new Response(
          JSON.stringify({ code: "not_found", reason: "thread_not_found", traceId: "x" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      if (request.url.endsWith("/api/orchestration/dispatch")) {
        return Response.json({ sequence: 9 });
      }
      if (request.url.endsWith("/oauth/token")) {
        return Response.json({ accessToken: "short-lived", tokenType: "Bearer", expiresIn: 60 });
      }
      throw new Error(`unexpected route ${request.url}`);
    };
    const client = createStockT3HttpClient({
      baseUrl: "http://127.0.0.1:3774///",
      bearerToken: "bearer-secret",
      fetch,
    });

    await client.getDescriptor();
    await client.getShell();
    expect(await client.getThread("thread/one")).toBeUndefined();
    expect(await client.dispatch({ type: "thread.delete", commandId: "c", threadId: "t" })).toEqual({ sequence: 9 });
    expect(await client.exchangeToken({ grantType: "pairing", credential: "bootstrap-secret" })).toEqual({
      accessToken: "short-lived",
      tokenType: "Bearer",
      expiresIn: 60,
    });

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/.well-known/t3/environment",
      "/api/orchestration/shell",
      "/api/orchestration/threads/thread%2Fone",
      "/api/orchestration/dispatch",
      "/oauth/token",
    ]);
    expect(requests[0]?.headers.get("authorization")).toBeNull();
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer bearer-secret");
  });

  test("sanitizes bearer values and response bodies from typed failures", async () => {
    const fetch = async () =>
      new Response(
        JSON.stringify({
          code: "internal_error",
          reason: "orchestration_dispatch_failed",
          traceId: "bearer-secret response-secret",
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    const client = createStockT3HttpClient({
      baseUrl: "http://127.0.0.1:3774",
      bearerToken: "bearer-secret",
      fetch,
    });

    const error = await client.dispatch({ type: "thread.delete", commandId: "c", threadId: "t" }).catch((cause) => cause);
    expect(error).toBeInstanceOf(StockT3HttpError);
    expect(error.code).toBe("server_internal");
    expect(JSON.stringify(error)).not.toContain("bearer-secret");
    expect(JSON.stringify(error)).not.toContain("response-secret");
  });

  test.each([
    [401, "authentication_failed"],
    [403, "permission_denied"],
    [500, "server_internal"],
  ] as const)("preserves received snapshot HTTP %i as %s", async (status, code) => {
    const client = createStockT3HttpClient({
      baseUrl: "http://127.0.0.1:3774",
      bearerToken: "bearer-secret",
      fetch: async () =>
        Response.json(
          { code: "redacted", reason: "redacted", traceId: "response-secret" },
          { status },
        ),
    });

    const error = await client.getShell().catch((cause) => cause);
    expect(error).toBeInstanceOf(StockT3HttpError);
    expect(error).toMatchObject({ code, status });
    expect(JSON.stringify(error)).not.toContain("response-secret");
  });

  test("preserves Retry-After on typed transient snapshot failures", async () => {
    const client = createStockT3HttpClient({
      baseUrl: "http://127.0.0.1:3774",
      bearerToken: "bearer-secret",
      fetch: async () =>
        new Response("temporarily unavailable", {
          status: 503,
          headers: { "retry-after": "3" },
        }),
    });

    const error = await client.getShell().catch((cause) => cause);
    expect(error).toBeInstanceOf(StockT3HttpError);
    expect(error).toMatchObject({
      code: "transport_unavailable",
      status: 503,
      detail: { retryAfterMs: 3_000, transient: true },
    });
  });

  test("fails closed on a successful response with malformed JSON", async () => {
    const client = createStockT3HttpClient({
      baseUrl: "http://127.0.0.1:3774",
      bearerToken: "bearer-secret",
      fetch: async () => new Response("not-json", { status: 200 }),
    });

    await expect(client.getShell()).rejects.toMatchObject({
      code: "protocol_mismatch",
      status: 200,
    });
  });

  test("queues the ninth direct request behind the global in-flight cap", async () => {
    let active = 0;
    let peak = 0;
    const client = createStockT3HttpClient({
      baseUrl: "http://127.0.0.1:3774",
      fetch: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return Response.json(descriptor);
      },
    });

    await Promise.all(Array.from({ length: 9 }, () => client.getDescriptor()));
    expect(peak).toBe(8);
    expect(client.observations()).toMatchObject({ peakInFlight: 8, inFlight: 0 });
  });

  test.each([
    ["local", 251, true],
    ["local", 4_999, true],
    ["local", 5_001, false],
    ["relay", 10_000, true],
    ["tunnel", 10_000, true],
  ] as const)(
    "fake-clock %s profile classifies an actual %ims request",
    async (connectionProfile, actualRequestDuration, succeeds) => {
      let current = 0;
      let scheduledBudget = 0;
      let timeoutCallback: (() => void) | undefined;
      let active = 0;
      let peak = 0;
      const client = createStockT3HttpClient({
        baseUrl: "http://127.0.0.1:3774",
        bearerToken: "secret",
        connectionProfile,
        clock: () => current,
        setTimer: (callback, milliseconds) => {
          timeoutCallback = callback;
          scheduledBudget = milliseconds;
          return Symbol("fake-timer");
        },
        clearTimer: () => {},
        fetch: async (_input, init) => {
          active += 1;
          peak = Math.max(peak, active);
          current += actualRequestDuration;
          if (actualRequestDuration > scheduledBudget) {
            timeoutCallback?.();
            active -= 1;
            throw init?.signal?.reason ?? new DOMException("aborted", "AbortError");
          }
          active -= 1;
          return Response.json({
            snapshotSequence: 1,
            projects: [],
            threads: [],
            updatedAt: "2026-07-31T18:00:00.000Z",
          });
        },
      });

      const outcome = await client.getShell({ deadlineMs: 20_000 }).catch((error) => error);
      if (succeeds) expect(outcome).toMatchObject({ snapshotSequence: 1 });
      else expect(outcome).toMatchObject({ code: "transport_unavailable" });
      expect(current).toBe(actualRequestDuration);
      expect(peak).toBe(1);
    },
  );
});
