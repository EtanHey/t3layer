import { describe, expect, test } from "bun:test";
import { FacadeError, createT3Facade, type AgentEvent } from "../src/facade";

async function collect(
  iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("FacadeError", () => {
  test("allowlists structural session fields and drops unexpected secrets", () => {
    const bearer = "Bearer hostile-runtime-secret";
    const hostileSession = {
      status: "running",
      activeTurnId: "turn-1",
      authorization: bearer,
    };
    const error = new FacadeError("timeout", {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 9,
      session: hostileSession,
      latestTurn: null,
      pendingApproval: null,
      pendingInput: null,
    });

    expect(error.structuralSnapshot.session).toEqual({
      status: "running",
      activeTurnId: "turn-1",
    });
    expect(JSON.stringify(error.structuralSnapshot)).not.toContain(bearer);
    expect(JSON.stringify(error.structuralSnapshot)).not.toContain(
      "authorization",
    );
  });
});

describe("wait", () => {
  test("waits past receipt and streaming content until structural completion", async () => {
    const subscriptions: unknown[] = [];
    const initial = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 21,
      session: { status: "running", activeTurnId: "turn-1" },
      latestTurn: {
        turnId: "turn-1",
        status: "running",
        userMessageId: "message-1",
        assistantMessage: null,
      },
      pendingApproval: null,
      pendingInput: null,
    };
    const streaming = {
      ...initial,
      snapshotSequence: 22,
      latestTurn: {
        ...initial.latestTurn,
        assistantMessage: { content: "partial", streaming: true },
      },
    };
    const completed = {
      ...initial,
      snapshotSequence: 23,
      session: { status: "ready", activeTurnId: null },
      latestTurn: {
        ...initial.latestTurn,
        status: "completed",
        assistantMessage: { content: "final answer", streaming: false },
      },
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 21 };
      },
      async getThread() {
        return initial;
      },
      async *subscribeThread(threadId: string, input: unknown) {
        subscriptions.push({ threadId, input });
        yield { sequence: 22, snapshot: streaming };
        yield { sequence: 23, snapshot: completed };
        throw new Error("wait consumed past completion");
      },
    };
    const facade = createT3Facade(runtime);

    const events = [];
    for await (const event of facade.wait("thread-1", {
      kind: "terminal",
      timeoutMs: 1_000,
      maxEvidenceBytes: 10_000,
    })) {
      events.push(event);
    }

    expect(subscriptions).toEqual([
      { threadId: "thread-1", input: { afterSequence: 21 } },
    ]);
    expect(events.map((event) => event.lifecycle)).toEqual([
      "running",
      "running",
      "completed",
    ]);
    expect(events.at(-1)).toMatchObject({
      agentId: "thread-1",
      sequence: 23,
      lifecycle: "completed",
      assistantContent: "final answer",
    });
  });

  for (const violation of [
    {
      label: "duplicates the initial sequence",
      yieldsAdvancingObservation: false,
      expectedLastSequence: 70,
    },
    {
      label: "regresses after an advancing observation",
      yieldsAdvancingObservation: true,
      expectedLastSequence: 71,
    },
  ] as const) {
    test(`fails closed before retaining or yielding an observation that ${violation.label}`, async () => {
      const initial = {
        threadId: "thread-1",
        projectId: "project-1",
        snapshotSequence: 70,
        session: { status: "running", activeTurnId: "turn-1" },
        latestTurn: {
          turnId: "turn-1",
          status: "running",
          userMessageId: "message-1",
          assistantMessage: null,
        },
        pendingApproval: null,
        pendingInput: null,
      };
      const advancing = {
        ...initial,
        snapshotSequence: 71,
      };
      const invalid = {
        ...initial,
        pendingApproval: {
          requestId: "approval-invalid",
          payload: "x".repeat(20_000),
        },
      };
      const runtime = {
        async listProjects() {
          return [];
        },
        async createProject() {
          return { sequence: 1 };
        },
        async startThread() {
          return { sequence: 2 };
        },
        async startTurn() {
          return { sequence: 3 };
        },
        async getThread() {
          return initial;
        },
        async *subscribeThread() {
          if (violation.yieldsAdvancingObservation) {
            yield { sequence: 71, snapshot: advancing };
          }
          yield { sequence: 70, snapshot: invalid };
        },
      };
      const facade = createT3Facade(runtime);
      const iterator = facade
        .wait("thread-1", {
          kind: "terminal",
          timeoutMs: 1_000,
          maxEvidenceBytes: 10_000,
        })
        [Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toMatchObject({
        value: { sequence: 70 },
        done: false,
      });
      if (violation.yieldsAdvancingObservation) {
        await expect(iterator.next()).resolves.toMatchObject({
          value: { sequence: 71 },
          done: false,
        });
      }
      await expect(iterator.next()).rejects.toMatchObject({
        code: "transport_unavailable",
        sequence: violation.expectedLastSequence,
      });
    });
  }

  test("fails closed when the initial lookup returns a different thread", async () => {
    const divergent = {
      threadId: "thread-other",
      projectId: "project-1",
      snapshotSequence: 24,
      session: { status: "stopped", activeTurnId: null },
      latestTurn: null,
      pendingApproval: null,
      pendingInput: null,
    };
    let subscribed = false;
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return divergent;
      },
      async *subscribeThread() {
        subscribed = true;
        return;
      },
    };
    const facade = createT3Facade(runtime);

    const result = collect(
      facade.wait("thread-requested", {
        kind: "terminal",
        timeoutMs: 1_000,
        maxEvidenceBytes: 10_000,
      }),
    );

    await expect(result).rejects.toMatchObject({
      code: "transport_unavailable",
      sequence: 24,
    });
    expect(subscribed).toBe(false);
  });

  test("returns a structural facade error when the initial thread is unavailable", async () => {
    let subscribed = false;
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return undefined;
      },
      async *subscribeThread() {
        subscribed = true;
        return;
      },
    };
    const facade = createT3Facade(runtime);

    const result = collect(
      facade.wait("thread-requested", {
        kind: "terminal",
        timeoutMs: 1_000,
        maxEvidenceBytes: 10_000,
      }),
    );

    await expect(result).rejects.toMatchObject({
      code: "transport_unavailable",
      sequence: 0,
      structuralSnapshot: {
        threadId: "thread-requested",
      },
    });
    expect(subscribed).toBe(false);
  });

  test("fails closed when a subscription observation returns a different thread", async () => {
    const initial = {
      threadId: "thread-requested",
      projectId: "project-1",
      snapshotSequence: 25,
      session: { status: "running", activeTurnId: "turn-1" },
      latestTurn: {
        turnId: "turn-1",
        status: "running",
        userMessageId: "message-1",
        assistantMessage: null,
      },
      pendingApproval: null,
      pendingInput: null,
    };
    const divergent = {
      ...initial,
      threadId: "thread-other",
      snapshotSequence: 26,
      session: { status: "stopped", activeTurnId: null },
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return initial;
      },
      async *subscribeThread() {
        yield { sequence: 26, snapshot: divergent };
      },
    };
    const facade = createT3Facade(runtime);

    const result = collect(
      facade.wait("thread-requested", {
        kind: "terminal",
        timeoutMs: 1_000,
        maxEvidenceBytes: 10_000,
      }),
    );

    await expect(result).rejects.toMatchObject({
      code: "transport_unavailable",
      sequence: 26,
    });
  });

  test("classifies empty terminal assistant content as a structural error", async () => {
    const emptyTerminal = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 30,
      session: { status: "ready", activeTurnId: null },
      latestTurn: {
        turnId: "turn-1",
        status: "completed",
        userMessageId: "message-1",
        assistantMessage: { content: "   ", streaming: false },
      },
      pendingApproval: null,
      pendingInput: null,
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return emptyTerminal;
      },
      async *subscribeThread() {
        return;
      },
    };
    const facade = createT3Facade(runtime);

    const result = collect(
      facade.wait("thread-1", {
        kind: "terminal",
        timeoutMs: 1_000,
        maxEvidenceBytes: 10_000,
      }),
    );

    await expect(result).rejects.toBeInstanceOf(FacadeError);
    await expect(result).rejects.toMatchObject({
      code: "empty_assistant_response",
      sequence: 30,
    });
  });

  test("fails closed immediately when a completed turn has no assistant message", async () => {
    const missingAssistant = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 31,
      session: { status: "ready", activeTurnId: null },
      latestTurn: {
        turnId: "turn-1",
        status: "completed",
        userMessageId: "message-1",
        assistantMessage: null,
      },
      pendingApproval: null,
      pendingInput: null,
    };
    let subscribed = false;
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return missingAssistant;
      },
      async *subscribeThread() {
        subscribed = true;
        throw new Error("missing assistant must fail before subscription");
      },
    };
    const facade = createT3Facade(runtime);

    const result = collect(
      facade.wait("thread-1", {
        kind: "terminal",
        timeoutMs: 1,
        maxEvidenceBytes: 10_000,
      }),
    );

    await expect(result).rejects.toMatchObject({
      code: "empty_assistant_response",
      sequence: 31,
    });
    expect(subscribed).toBe(false);
  });

  test("stops on structured pending approval without inspecting provider text", async () => {
    const awaitingApproval = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 31,
      session: { status: "ready", activeTurnId: null },
      latestTurn: {
        turnId: "turn-1",
        status: "running",
        userMessageId: "message-1",
        assistantMessage: null,
      },
      pendingApproval: { requestId: "approval-1", status: "pending" },
      pendingInput: null,
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return awaitingApproval;
      },
      async *subscribeThread() {
        throw new Error("pending approval must stop before subscription");
      },
    };
    const facade = createT3Facade(runtime);

    const events = await collect(
      facade.wait("thread-1", {
        kind: "terminal",
        timeoutMs: 1_000,
        maxEvidenceBytes: 10_000,
      }),
    );

    expect(events.map((event) => event.lifecycle)).toEqual(["awaiting_input"]);
  });

  for (const failedState of ["interrupted", "error"] as const) {
    test(`keeps ${failedState} ahead of pending state and omits whitespace-only assistant content`, async () => {
      const failed = {
        threadId: "thread-1",
        projectId: "project-1",
        snapshotSequence: 32,
        session: { status: failedState, activeTurnId: null },
        latestTurn: {
          turnId: "turn-1",
          status: "running",
          userMessageId: "message-1",
          assistantMessage: { content: " \n\t ", streaming: false },
        },
        pendingApproval:
          failedState === "interrupted"
            ? { requestId: "approval-pending" }
            : null,
        pendingInput:
          failedState === "error" ? { requestId: "input-pending" } : null,
      };
      const runtime = {
        async listProjects() {
          return [];
        },
        async createProject() {
          return { sequence: 1 };
        },
        async startThread() {
          return { sequence: 2 };
        },
        async startTurn() {
          return { sequence: 3 };
        },
        async getThread() {
          return failed;
        },
        async *subscribeThread() {
          throw new Error("failed state must stop before subscription");
        },
      };
      const facade = createT3Facade(runtime);

      const events = await collect(
        facade.wait("thread-1", {
          kind: "terminal",
          timeoutMs: 1_000,
          maxEvidenceBytes: 10_000,
        }),
      );

      expect(events).toHaveLength(1);
      expect(events[0]?.lifecycle).toBe(failedState);
      expect(events[0]).not.toHaveProperty("assistantContent");
    });
  }

  test("decodes omitted pending fields as no pending input", async () => {
    const initial = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 32,
      session: { status: "ready", activeTurnId: null },
      latestTurn: null,
    };
    const stopped = {
      ...initial,
      snapshotSequence: 33,
      session: { status: "stopped", activeTurnId: null },
      pendingApproval: null,
      pendingInput: null,
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return initial;
      },
      async *subscribeThread() {
        yield { sequence: 33, snapshot: stopped };
      },
    };
    const facade = createT3Facade(runtime);

    const events = await collect(
      facade.wait("thread-1", {
        kind: "terminal",
        timeoutMs: 1_000,
        maxEvidenceBytes: 10_000,
      }),
    );

    expect(events.map((event) => event.lifecycle)).toEqual([
      "ready",
      "stopped",
    ]);
  });

  test("fails with timeout while native state remains nonterminal", async () => {
    const running = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 40,
      session: { status: "running", activeTurnId: "turn-1" },
      latestTurn: {
        turnId: "turn-1",
        status: "running",
        userMessageId: "message-1",
        assistantMessage: null,
      },
      pendingApproval: null,
      pendingInput: null,
    };
    const completed = {
      ...running,
      snapshotSequence: 41,
      session: { status: "ready", activeTurnId: null },
      latestTurn: {
        ...running.latestTurn,
        status: "completed",
        assistantMessage: { content: "late", streaming: false },
      },
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return running;
      },
      async *subscribeThread() {
        await Bun.sleep(30);
        yield { sequence: 41, snapshot: completed };
      },
    };
    const facade = createT3Facade(runtime);

    const result = collect(
      facade.wait("thread-1", {
        kind: "terminal",
        timeoutMs: 5,
        maxEvidenceBytes: 10_000,
      }),
    );

    await expect(result).rejects.toMatchObject({
      code: "timeout",
      sequence: 40,
    });
  });

  test("bounds the initial native lookup by the wait timeout", async () => {
    const completed = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 41,
      session: { status: "ready", activeTurnId: null },
      latestTurn: {
        turnId: "turn-1",
        status: "completed",
        userMessageId: "message-1",
        assistantMessage: { content: "too late", streaming: false },
      },
      pendingApproval: null,
      pendingInput: null,
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        await Bun.sleep(100);
        return completed;
      },
      async *subscribeThread() {
        throw new Error("late terminal lookup must not subscribe");
      },
    };
    const facade = createT3Facade(runtime);
    const startedAt = performance.now();

    const result = collect(
      facade.wait("thread-1", {
        kind: "terminal",
        timeoutMs: 5,
        maxEvidenceBytes: 10_000,
      }),
    );
    const error = await result.catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "timeout" });
    expect(performance.now() - startedAt).toBeLessThan(50);
  });

  test("does not await stalled iterator teardown before rejecting at timeout", async () => {
    const running = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 42,
      session: { status: "running", activeTurnId: "turn-1" },
      latestTurn: {
        turnId: "turn-1",
        status: "running",
        userMessageId: "message-1",
        assistantMessage: null,
      },
      pendingApproval: null,
      pendingInput: null,
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return running;
      },
      async *subscribeThread() {
        await Bun.sleep(150);
        yield { sequence: 43, snapshot: running };
      },
    };
    const facade = createT3Facade(runtime);
    const startedAt = performance.now();

    const result = collect(
      facade.wait("thread-1", {
        kind: "terminal",
        timeoutMs: 5,
        maxEvidenceBytes: 10_000,
      }),
    );

    await expect(result).rejects.toMatchObject({
      code: "timeout",
      sequence: 42,
    });
    expect(performance.now() - startedAt).toBeLessThan(75);
  });

  test("sanitizes credential-bearing subscription errors", async () => {
    const credential = "Bearer hostile-subscription-credential";
    const running = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 44,
      session: { status: "running", activeTurnId: "turn-1" },
      latestTurn: {
        turnId: "turn-1",
        status: "running",
        userMessageId: "message-1",
        assistantMessage: null,
      },
      pendingApproval: null,
      pendingInput: null,
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return running;
      },
      async *subscribeThread() {
        throw new Error(`transport rejected ${credential}`);
      },
    };
    const facade = createT3Facade(runtime);

    const result = collect(
      facade.wait("thread-1", {
        kind: "terminal",
        timeoutMs: 1_000,
        maxEvidenceBytes: 10_000,
      }),
    );
    const error = await result.catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: "transport_unavailable",
      sequence: 44,
    });
    expect(String(error)).not.toContain(credential);
    expect(JSON.stringify(error)).not.toContain(credential);
  });

  test("fails closed when the subscription ends before a terminal state", async () => {
    const running = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 45,
      session: { status: "running", activeTurnId: "turn-1" },
      latestTurn: {
        turnId: "turn-1",
        status: "running",
        userMessageId: "message-1",
        assistantMessage: null,
      },
      pendingApproval: null,
      pendingInput: null,
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return running;
      },
      async *subscribeThread() {
        return;
      },
    };
    const facade = createT3Facade(runtime);

    const result = collect(
      facade.wait("thread-1", {
        kind: "terminal",
        timeoutMs: 1_000,
        maxEvidenceBytes: 10_000,
      }),
    );

    await expect(result).rejects.toMatchObject({
      code: "transport_unavailable",
      sequence: 45,
    });
  });

  test("fails before retaining evidence beyond the configured byte cap", async () => {
    const running = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 50,
      session: { status: "running", activeTurnId: "turn-1" },
      latestTurn: {
        turnId: "turn-1",
        status: "running",
        userMessageId: "message-1",
        assistantMessage: null,
      },
      pendingApproval: null,
      pendingInput: null,
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return running;
      },
      async *subscribeThread() {
        return;
      },
    };
    const facade = createT3Facade(runtime);

    const result = collect(
      facade.wait("thread-1", {
        kind: "terminal",
        timeoutMs: 1_000,
        maxEvidenceBytes: 1,
      }),
    );

    await expect(result).rejects.toMatchObject({
      code: "buffer_exhausted",
      sequence: 50,
    });
  });

  test("counts a hostile pending payload before returning the native event", async () => {
    const secretMarker = "hostile-pending-payload";
    const awaitingApproval = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 51,
      session: { status: "ready", activeTurnId: null },
      latestTurn: {
        turnId: "turn-1",
        status: "running",
        userMessageId: "message-1",
        assistantMessage: null,
      },
      pendingApproval: {
        requestId: "approval-1",
        payload: `${secretMarker}:${"x".repeat(20_000)}`,
      },
      pendingInput: null,
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return awaitingApproval;
      },
      async *subscribeThread() {
        throw new Error(
          "oversized pending state must fail before subscription",
        );
      },
    };
    const facade = createT3Facade(runtime);

    const result = collect(
      facade.wait("thread-1", {
        kind: "terminal",
        timeoutMs: 1_000,
        maxEvidenceBytes: 500,
      }),
    );

    await expect(result).rejects.toMatchObject({
      code: "buffer_exhausted",
      sequence: 51,
    });
    const error = await result.catch((reason: unknown) => reason);
    expect(JSON.stringify(error)).not.toContain(secretMarker);
  });

  test("stops when the native session is structurally interrupted", async () => {
    const interrupted = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 60,
      session: { status: "interrupted", activeTurnId: null },
      latestTurn: {
        turnId: "turn-1",
        status: "running",
        userMessageId: "message-1",
        assistantMessage: null,
      },
      pendingApproval: null,
      pendingInput: null,
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return interrupted;
      },
      async *subscribeThread() {
        throw new Error("interrupted state must stop before subscription");
      },
    };
    const facade = createT3Facade(runtime);

    const events = await collect(
      facade.wait("thread-1", {
        kind: "terminal",
        timeoutMs: 1_000,
        maxEvidenceBytes: 10_000,
      }),
    );

    expect(events.map((event) => event.lifecycle)).toEqual(["interrupted"]);
  });

  test("stops when the native session is structurally stopped", async () => {
    const stopped = {
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 61,
      session: { status: "stopped", activeTurnId: null },
      latestTurn: {
        turnId: "turn-1",
        status: "running",
        userMessageId: "message-1",
        assistantMessage: null,
      },
      pendingApproval: null,
      pendingInput: null,
    };
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread() {
        return stopped;
      },
      async *subscribeThread() {
        throw new Error("stopped state must stop before subscription");
      },
    };
    const facade = createT3Facade(runtime);

    const events = await collect(
      facade.wait("thread-1", {
        kind: "terminal",
        timeoutMs: 1_000,
        maxEvidenceBytes: 10_000,
      }),
    );

    expect(events.map((event) => event.lifecycle)).toEqual(["stopped"]);
  });
});
