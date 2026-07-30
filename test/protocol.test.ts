import { describe, expect, test } from "bun:test";
import {
  ProtocolError,
  createAckFrame,
  createInterruptFrame,
  createRequestFrame,
  decodeResponseFrame,
} from "../src/protocol";

describe("Effect RPC client frames", () => {
  test("creates a Request with a numeric-string ID, tag, payload, and headers", () => {
    const frame = createRequestFrame({
      id: "17",
      tag: "server.getConfig",
      payload: { includeProviders: true },
      headers: [["x-client-version", "t3layer"]],
    });

    expect(frame).toEqual({
      _tag: "Request",
      id: "17",
      tag: "server.getConfig",
      payload: { includeProviders: true },
      headers: [["x-client-version", "t3layer"]],
    });
    expect(typeof frame.id).toBe("string");
  });

  test.each(["17.5", "-1", "request-17", ""])(
    "rejects a non-numeric request ID %p",
    (id) => {
      expect(() =>
        createRequestFrame({
          id,
          tag: "server.getConfig",
          payload: {},
          headers: [],
        }),
      ).toThrow("request ID must be a numeric string");
    },
  );

  test("creates an Ack using the original request ID", () => {
    expect(createAckFrame("17")).toEqual({
      _tag: "Ack",
      requestId: "17",
    });
  });

  test("creates an Interrupt using the original request ID", () => {
    expect(createInterruptFrame("17")).toEqual({
      _tag: "Interrupt",
      requestId: "17",
    });
  });
});

describe("Effect RPC server frames", () => {
  test("classifies a successful unary Exit and exposes its value", () => {
    expect(
      decodeResponseFrame({
        _tag: "Exit",
        requestId: "17",
        exit: {
          _tag: "Success",
          value: { provider: "claudeAgent", status: "ready" },
        },
      }),
    ).toEqual({
      _tag: "Success",
      requestId: "17",
      value: { provider: "claudeAgent", status: "ready" },
    });
  });

  test("classifies a failed unary Exit and exposes its cause", () => {
    const cause = [
      {
        _tag: "Fail",
        error: { message: "provider unavailable" },
      },
    ];

    expect(
      decodeResponseFrame({
        _tag: "Exit",
        requestId: "18",
        exit: {
          _tag: "Failure",
          cause,
        },
      }),
    ).toEqual({
      _tag: "Failure",
      requestId: "18",
      cause,
    });
  });

  test("extracts values from a Chunk", () => {
    const values = [
      { type: "thread.snapshot", sequence: 1 },
      { type: "thread.updated", sequence: 2 },
    ] as const;

    expect(
      decodeResponseFrame({
        _tag: "Chunk",
        requestId: "19",
        values,
      }),
    ).toEqual({
      _tag: "Chunk",
      requestId: "19",
      values,
    });
  });

  test.each([
    { frame: null },
    { frame: [] },
    { frame: {} },
    {
      frame: {
        _tag: "Exit",
        requestId: 17,
        exit: { _tag: "Success", value: null },
      },
    },
    { frame: { _tag: "Exit", requestId: "17", exit: { _tag: "Success" } } },
    { frame: { _tag: "Exit", requestId: "17", exit: { _tag: "Failure" } } },
    { frame: { _tag: "Chunk", requestId: "17", values: [] } },
  ])("rejects malformed server frame %#", ({ frame }) => {
    expect(() => decodeResponseFrame(frame)).toThrow(ProtocolError);
  });

  test("rejects an unknown server frame tag", () => {
    expect(() =>
      decodeResponseFrame({
        _tag: "Defect",
        defect: "not part of the proven narrow protocol",
      }),
    ).toThrow("unknown Effect RPC server frame");
  });

  test("does not expose credentials from a malformed frame in errors", () => {
    const bearer = "Bearer secret-bearer-value";
    const ticket = "secret-websocket-ticket";

    let thrown: unknown;
    try {
      decodeResponseFrame({
        _tag: "Chunk",
        requestId: "not-numeric",
        values: [{ authorization: bearer, wsTicket: ticket }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProtocolError);
    const message = String(thrown);
    expect(message).not.toContain(bearer);
    expect(message).not.toContain(ticket);
    expect(message).not.toContain("authorization");
    expect(message).not.toContain("wsTicket");
  });
});
