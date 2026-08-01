import {
  ProtocolMismatchError,
  type ConnectionProfile,
  type EnvironmentDescriptor,
  type SanitizedDispatchError,
  type ShellSnapshot,
  type ThreadDetailSnapshot,
  decodeDescriptor,
  decodeDispatchError,
  decodeDispatchResult,
  decodeShellSnapshot,
  decodeThreadDetailSnapshot,
  decodeTokenResult,
} from "./stockT3Contracts";

export type StockT3HttpErrorCode =
  | SanitizedDispatchError["class"]
  | "not_found"
  | "transport_unavailable"
  | "protocol_mismatch";

export class StockT3HttpError extends Error {
  constructor(
    readonly code: StockT3HttpErrorCode,
    readonly status: number | null,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
    this.name = "StockT3HttpError";
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { name: this.name, code: this.code, status: this.status, detail: this.detail };
  }
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface StockT3HttpClientOptions {
  readonly baseUrl: string | URL;
  readonly bearerToken?: string;
  readonly fetch?: FetchLike;
  readonly connectionProfile?: ConnectionProfile;
  readonly clock?: () => number;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export interface RequestBoundaryOptions {
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly minimumSequence?: number;
}

export interface EndpointStatusTrace {
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
}

function normalizeBaseUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("stock T3 base URL must use http or https");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  url.search = "";
  url.hash = "";
  return url;
}

function requestBudget(profile: ConnectionProfile): number {
  return profile === "local" ? 5_000 : 15_000;
}

const MAX_HTTP_IN_FLIGHT = 8;

function linkedAttemptSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
  setTimer: (callback: () => void, milliseconds: number) => unknown,
  clearTimer: (timer: unknown) => void,
): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(external?.reason);
  if (external?.aborted) controller.abort(external.reason);
  else external?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimer(
    () => controller.abort(new DOMException("request deadline exceeded", "TimeoutError")),
    Math.max(0, timeoutMs),
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimer(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

export function createStockT3HttpClient(options: StockT3HttpClientOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const profile = options.connectionProfile ?? "local";
  const clock = options.clock ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const endpointStatusTrace: EndpointStatusTrace[] = [];
  let requestCount = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const capacityWaiters: Array<() => void> = [];

  function capacityFailure(signal: AbortSignal | undefined): StockT3HttpError {
    const reason = signal?.reason;
    return new StockT3HttpError("transport_unavailable", null, {
      reason:
        reason instanceof DOMException && reason.name === "TimeoutError"
          ? "deadline"
          : "cancelled",
    });
  }

  async function acquireCapacity(boundary: RequestBoundaryOptions): Promise<() => void> {
    if (boundary.signal?.aborted) {
      throw capacityFailure(boundary.signal);
    }
    if (inFlight >= MAX_HTTP_IN_FLIGHT) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const index = capacityWaiters.indexOf(resume);
          if (index >= 0) capacityWaiters.splice(index, 1);
          reject(capacityFailure(boundary.signal));
        };
        const resume = () => {
          boundary.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        capacityWaiters.push(resume);
        boundary.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (
      boundary.signal?.aborted ||
      (boundary.deadlineMs !== undefined && clock() >= boundary.deadlineMs)
    ) {
      throw new StockT3HttpError("transport_unavailable", null, {
        reason: boundary.signal?.aborted ? "cancelled" : "deadline",
      });
    }
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      capacityWaiters.shift()?.();
    };
  }

  async function requestJson(
    path: string,
    init: RequestInit,
    boundary: RequestBoundaryOptions,
    authenticated: boolean,
  ): Promise<{ readonly response: Response; readonly body: unknown }> {
    const remaining =
      boundary.deadlineMs === undefined
        ? requestBudget(profile)
        : Math.max(0, boundary.deadlineMs - clock());
    const timeoutMs = Math.min(requestBudget(profile), remaining);
    if (timeoutMs <= 0 || boundary.signal?.aborted) {
      throw new StockT3HttpError("transport_unavailable", null, { reason: "deadline_or_cancelled" });
    }
    const attempt = linkedAttemptSignal(boundary.signal, timeoutMs, setTimer, clearTimer);
    const method = init.method ?? "GET";
    requestCount += 1;
    let releaseCapacity: (() => void) | undefined;
    try {
      releaseCapacity = await acquireCapacity({ ...boundary, signal: attempt.signal });
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      if (init.body !== undefined && init.body !== null) headers.set("content-type", "application/json");
      if (authenticated && options.bearerToken !== undefined) {
        headers.set("authorization", `Bearer ${options.bearerToken}`);
      }
      const response = await fetchImpl(new URL(path, baseUrl), { ...init, headers, signal: attempt.signal });
      endpointStatusTrace.push({ method, path, status: response.status });
      let body: unknown;
      try {
        const text = await response.text();
        body = text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new StockT3HttpError("protocol_mismatch", response.status, {
            reason: "invalid_json",
          });
        }
        body = undefined;
      }
      return { response, body };
    } catch (error) {
      if (error instanceof StockT3HttpError) throw error;
      if (error instanceof ProtocolMismatchError) {
        throw new StockT3HttpError("protocol_mismatch", null, { path: error.path });
      }
      endpointStatusTrace.push({ method, path, status: null });
      throw new StockT3HttpError("transport_unavailable", null, {
        reason: boundary.signal?.aborted ? "cancelled" : "request_failed",
      });
    } finally {
      releaseCapacity?.();
      attempt.cleanup();
    }
  }

  function decodeOrProtocol<T>(operation: () => T, status: number | null): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof ProtocolMismatchError) {
        throw new StockT3HttpError("protocol_mismatch", status, { path: error.path });
      }
      throw error;
    }
  }

  function retryAfterMs(response: Response): number {
    const value = response.headers.get("retry-after");
    if (value === null) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(8_000, seconds * 1_000);
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.min(8_000, Math.max(0, at - clock())) : 0;
  }

  function receivedHttpError(response: Response): StockT3HttpError {
    if (response.status === 401) {
      return new StockT3HttpError("authentication_failed", 401);
    }
    if (response.status === 403) {
      return new StockT3HttpError("permission_denied", 403);
    }
    if (response.status === 500) {
      return new StockT3HttpError("server_internal", 500);
    }
    if ([429, 502, 503, 504].includes(response.status)) {
      return new StockT3HttpError("transport_unavailable", response.status, {
        transient: true,
        retryAfterMs: retryAfterMs(response),
      });
    }
    return new StockT3HttpError("protocol_mismatch", response.status, {
      reason: "unexpected_http_status",
    });
  }

  return {
    baseUrl,
    connectionProfile: profile,
    observations() {
      return {
        requestCount,
        inFlight,
        peakInFlight,
        endpointStatusTrace: endpointStatusTrace.map((entry) => ({ ...entry })),
      };
    },

    async getDescriptor(boundary: RequestBoundaryOptions = {}): Promise<EnvironmentDescriptor> {
      const { response, body } = await requestJson(
        "/.well-known/t3/environment",
        { method: "GET" },
        boundary,
        false,
      );
      if (!response.ok) throw receivedHttpError(response);
      return decodeOrProtocol(() => decodeDescriptor(body), response.status);
    },

    async getShell(boundary: RequestBoundaryOptions = {}): Promise<ShellSnapshot> {
      const { response, body } = await requestJson(
        "/api/orchestration/shell",
        { method: "GET" },
        boundary,
        true,
      );
      if (!response.ok) throw receivedHttpError(response);
      return decodeOrProtocol(
        () => decodeShellSnapshot(body, { minimumSequence: boundary.minimumSequence }),
        response.status,
      );
    },

    async getThread(
      threadId: string,
      boundary: RequestBoundaryOptions = {},
    ): Promise<ThreadDetailSnapshot | undefined> {
      const path = `/api/orchestration/threads/${encodeURIComponent(threadId)}`;
      const { response, body } = await requestJson(path, { method: "GET" }, boundary, true);
      if (response.status === 404) return undefined;
      if (!response.ok) throw receivedHttpError(response);
      return decodeOrProtocol(
        () => decodeThreadDetailSnapshot(body, { minimumSequence: boundary.minimumSequence }),
        response.status,
      );
    },

    async dispatch(
      command: Readonly<Record<string, unknown>>,
      boundary: RequestBoundaryOptions = {},
    ): Promise<{ readonly sequence: number }> {
      const { response, body } = await requestJson(
        "/api/orchestration/dispatch",
        { method: "POST", body: JSON.stringify(command) },
        boundary,
        true,
      );
      if (!response.ok) {
        const decoded = decodeOrProtocol(() => decodeDispatchError(response.status, body), response.status);
        throw new StockT3HttpError(decoded.class, decoded.status, {
          code: decoded.code,
          reason: decoded.reason,
        });
      }
      return decodeOrProtocol(() => decodeDispatchResult(body), response.status);
    },

    async exchangeToken(
      payload: Readonly<Record<string, unknown>>,
      boundary: RequestBoundaryOptions = {},
    ): Promise<{ readonly accessToken: string; readonly tokenType: "Bearer"; readonly expiresIn: number }> {
      const { response, body } = await requestJson(
        "/oauth/token",
        { method: "POST", body: JSON.stringify(payload) },
        boundary,
        false,
      );
      if (!response.ok) throw receivedHttpError(response);
      return decodeOrProtocol(() => decodeTokenResult(body), response.status);
    },
  };
}

export type StockT3HttpClient = ReturnType<typeof createStockT3HttpClient>;
