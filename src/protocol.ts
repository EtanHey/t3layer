export type Header = readonly [name: string, value: string];

export interface RequestFrame {
  readonly _tag: "Request";
  readonly id: string;
  readonly tag: string;
  readonly payload: unknown;
  readonly headers: ReadonlyArray<Header>;
}

export interface AckFrame {
  readonly _tag: "Ack";
  readonly requestId: string;
}

export interface InterruptFrame {
  readonly _tag: "Interrupt";
  readonly requestId: string;
}

export interface SuccessfulResponse {
  readonly _tag: "Success";
  readonly requestId: string;
  readonly value: unknown;
}

export interface FailedResponse {
  readonly _tag: "Failure";
  readonly requestId: string;
  readonly cause: ReadonlyArray<unknown>;
}

export interface ChunkResponse {
  readonly _tag: "Chunk";
  readonly requestId: string;
  readonly values: readonly [unknown, ...unknown[]];
}

export type ResponseFrame =
  | SuccessfulResponse
  | FailedResponse
  | ChunkResponse;

export class ProtocolError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const NUMERIC_STRING = /^\d+$/;

function requireRequestId(value: unknown): string {
  if (typeof value !== "string" || !NUMERIC_STRING.test(value)) {
    throw new ProtocolError("request ID must be a numeric string");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function malformedFrame(): never {
  throw new ProtocolError("malformed Effect RPC server frame");
}

export function createRequestFrame(input: {
  readonly id: string;
  readonly tag: string;
  readonly payload: unknown;
  readonly headers: ReadonlyArray<Header>;
}): RequestFrame {
  const id = requireRequestId(input.id);
  if (typeof input.tag !== "string" || input.tag.length === 0) {
    throw new ProtocolError("request tag must be a non-empty string");
  }
  if (
    !Array.isArray(input.headers) ||
    !input.headers.every(
      (header) =>
        Array.isArray(header) &&
        header.length === 2 &&
        typeof header[0] === "string" &&
        typeof header[1] === "string",
    )
  ) {
    throw new ProtocolError("request headers must be string pairs");
  }

  return {
    _tag: "Request",
    id,
    tag: input.tag,
    payload: input.payload,
    headers: input.headers.map(([name, value]) => [name, value]),
  };
}

export function createAckFrame(requestId: string): AckFrame {
  return {
    _tag: "Ack",
    requestId: requireRequestId(requestId),
  };
}

export function createInterruptFrame(requestId: string): InterruptFrame {
  return {
    _tag: "Interrupt",
    requestId: requireRequestId(requestId),
  };
}

export function decodeResponseFrame(input: unknown): ResponseFrame {
  if (!isRecord(input) || typeof input._tag !== "string") {
    return malformedFrame();
  }

  if (input._tag === "Chunk") {
    const requestId = requireRequestId(input.requestId);
    if (!Array.isArray(input.values) || input.values.length === 0) {
      return malformedFrame();
    }
    return {
      _tag: "Chunk",
      requestId,
      values: input.values as [unknown, ...unknown[]],
    };
  }

  if (input._tag === "Exit") {
    const requestId = requireRequestId(input.requestId);
    if (!isRecord(input.exit) || typeof input.exit._tag !== "string") {
      return malformedFrame();
    }

    if (input.exit._tag === "Success") {
      if (!hasOwn(input.exit, "value")) {
        return malformedFrame();
      }
      return {
        _tag: "Success",
        requestId,
        value: input.exit.value,
      };
    }

    if (input.exit._tag === "Failure") {
      if (!Array.isArray(input.exit.cause)) {
        return malformedFrame();
      }
      return {
        _tag: "Failure",
        requestId,
        cause: input.exit.cause,
      };
    }

    return malformedFrame();
  }

  throw new ProtocolError("unknown Effect RPC server frame");
}
