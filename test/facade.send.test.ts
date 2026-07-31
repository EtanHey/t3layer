import { describe, expect, test } from "bun:test";
import { AmbiguousDispatchError, createT3Facade } from "../src/facade";

const DISPATCH_MODES = {
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

describe("send", () => {
  test("reuses the thread with fresh IDs and no bootstrap payload", async () => {
    const calls: unknown[] = [];
    const evidence: unknown[] = [];
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
      async startTurn(input: unknown) {
        calls.push(input);
        return { sequence: 21 };
      },
      async getThread(threadId: string) {
        return {
          threadId,
          projectId: "project-1",
          snapshotSequence: 20,
          session: { status: "ready", activeTurnId: null },
          latestTurn: null,
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = ["command-2", "message-2"];
    const facade = createT3Facade(runtime, {
      ...DISPATCH_MODES,
      id: () => ids.shift()!,
      now: () => "2026-07-30T18:05:00.000Z",
      evidence: (record) => evidence.push(record),
    });

    const receipt = await facade.send("thread-1", "secret follow-up");

    expect(calls).toEqual([
      {
        commandId: "command-2",
        threadId: "thread-1",
        messageId: "message-2",
        message: "secret follow-up",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-07-30T18:05:00.000Z",
        attachments: [],
      },
    ]);
    expect(receipt).toEqual({
      agentId: "thread-1",
      commandId: "command-2",
      messageId: "message-2",
      sequence: 21,
      sequenceSource: "dispatch",
      recovered: false,
    });
    expect(evidence).toEqual([
      {
        operation: "send",
        commandId: "command-2",
        threadId: "thread-1",
        messageId: "message-2",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-07-30T18:05:00.000Z",
        attachments: 0,
        messageBytes: 16,
      },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("secret follow-up");
    expect(JSON.stringify(calls)).not.toContain("bootstrap");
  });

  test("counts multibyte send evidence by encoded byte length", async () => {
    const evidence: unknown[] = [];
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
      async getThread(threadId: string) {
        return {
          threadId,
          projectId: "project-1",
          snapshotSequence: 20,
          session: { status: "ready", activeTurnId: null },
          latestTurn: null,
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = ["command-multibyte", "message-multibyte"];
    const facade = createT3Facade(runtime, {
      ...DISPATCH_MODES,
      id: () => ids.shift()!,
      now: () => "2026-07-31T00:00:00.000Z",
      evidence: (record) => evidence.push(record),
    });

    await facade.send("thread-1", "é🙂");

    expect("é🙂").toHaveLength(3);
    expect(evidence).toEqual([
      {
        operation: "send",
        commandId: "command-multibyte",
        threadId: "thread-1",
        messageId: "message-multibyte",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-07-31T00:00:00.000Z",
        attachments: 0,
        messageBytes: 6,
      },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("é🙂");
  });

  test("fails closed before dispatch when preflight returns a different thread", async () => {
    const credential = "hostile-preflight-credential";
    let attempts = 0;
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
        attempts += 1;
        return { sequence: 21 };
      },
      async getThread() {
        return {
          threadId: "thread-other",
          projectId: "project-1",
          snapshotSequence: 20,
          session: {
            status: "ready",
            activeTurnId: null,
            authorization: credential,
          },
          latestTurn: null,
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const facade = createT3Facade(runtime, DISPATCH_MODES);

    const result = facade.send("thread-requested", "follow-up");
    const error = await result.catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: "transport_unavailable",
      sequence: 20,
    });
    expect(attempts).toBe(0);
    expect(String(error)).not.toContain(credential);
    expect(JSON.stringify(error)).not.toContain(credential);
  });

  test("returns a structural facade error when the preflight thread is unavailable", async () => {
    let attempts = 0;
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
        attempts += 1;
        return { sequence: 21 };
      },
      async getThread() {
        return undefined;
      },
      async *subscribeThread() {
        return;
      },
    };
    const facade = createT3Facade(runtime, DISPATCH_MODES);

    const result = facade.send("thread-requested", "follow-up");

    await expect(result).rejects.toMatchObject({
      code: "transport_unavailable",
      sequence: 0,
      structuralSnapshot: {
        threadId: "thread-requested",
      },
    });
    expect(attempts).toBe(0);
  });

  test("recovers an ambiguous receipt from the chosen thread and does not duplicate the turn", async () => {
    let attempts = 0;
    let queryCount = 0;
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
        attempts += 1;
        throw new AmbiguousDispatchError();
      },
      async getThread(threadId: string) {
        queryCount += 1;
        if (queryCount === 1) {
          return {
            threadId,
            projectId: "project-1",
            snapshotSequence: 20,
            session: { status: "ready", activeTurnId: null },
            latestTurn: null,
            pendingApproval: null,
            pendingInput: null,
          };
        }
        return {
          threadId,
          projectId: "project-1",
          snapshotSequence: 22,
          session: { status: "running", activeTurnId: "turn-2" },
          latestTurn: {
            turnId: "turn-2",
            status: "running",
            userMessageId: "message-2",
            assistantMessage: null,
          },
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = ["command-2", "message-2"];
    const facade = createT3Facade(runtime, {
      ...DISPATCH_MODES,
      id: () => ids.shift()!,
      now: () => "2026-07-30T18:05:00.000Z",
    });

    const receipt = await facade.send("thread-1", "follow-up");

    expect(attempts).toBe(1);
    expect(receipt).toEqual({
      agentId: "thread-1",
      commandId: "command-2",
      messageId: "message-2",
      sequence: 22,
      sequenceSource: "projection",
      recovered: true,
    });
  });

  test("retries an absent ambiguous send with the identical preallocated payload", async () => {
    const attempts: unknown[] = [];
    let queryCount = 0;
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
      async startTurn(input: unknown) {
        attempts.push(input);
        if (attempts.length === 1) {
          throw new AmbiguousDispatchError();
        }
        return { sequence: 23 };
      },
      async getThread(threadId: string) {
        queryCount += 1;
        return {
          threadId,
          projectId: "project-1",
          snapshotSequence: queryCount === 1 ? 20 : 22,
          session: { status: "ready", activeTurnId: null },
          latestTurn: null,
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = ["command-stable", "message-stable"];
    const facade = createT3Facade(runtime, {
      ...DISPATCH_MODES,
      id: () => ids.shift()!,
      now: () => "2026-07-31T00:00:00.000Z",
    });

    const receipt = await facade.send("thread-1", "follow-up");

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    expect(attempts[1]).toEqual({
      commandId: "command-stable",
      threadId: "thread-1",
      messageId: "message-stable",
      message: "follow-up",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-07-31T00:00:00.000Z",
      attachments: [],
    });
    expect(ids).toHaveLength(0);
    expect(receipt).toEqual({
      agentId: "thread-1",
      commandId: "command-stable",
      messageId: "message-stable",
      sequence: 23,
      sequenceSource: "dispatch",
      recovered: false,
    });
  });

  test("reconciles the stable message after an ambiguous identical retry lands", async () => {
    let attempts = 0;
    let queryCount = 0;
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
        attempts += 1;
        throw new AmbiguousDispatchError();
      },
      async getThread(threadId: string) {
        queryCount += 1;
        return {
          threadId,
          projectId: "project-1",
          snapshotSequence: 20 + queryCount,
          session:
            queryCount === 3
              ? { status: "running", activeTurnId: "turn-2" }
              : { status: "ready", activeTurnId: null },
          latestTurn:
            queryCount === 3
              ? {
                  turnId: "turn-2",
                  status: "running",
                  userMessageId: "message-stable",
                  assistantMessage: null,
                }
              : null,
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = ["command-stable", "message-stable"];
    const facade = createT3Facade(runtime, {
      ...DISPATCH_MODES,
      id: () => ids.shift()!,
      now: () => "2026-07-31T00:00:00.000Z",
    });

    const receipt = await facade.send("thread-1", "follow-up");

    expect(attempts).toBe(2);
    expect(queryCount).toBe(3);
    expect(ids).toHaveLength(0);
    expect(receipt).toEqual({
      agentId: "thread-1",
      commandId: "command-stable",
      messageId: "message-stable",
      sequence: 23,
      sequenceSource: "projection",
      recovered: true,
    });
  });

  test("fails closed without retry when the first ambiguous-send reconciliation returns a different thread", async () => {
    let attempts = 0;
    let queryCount = 0;
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
        attempts += 1;
        throw new AmbiguousDispatchError();
      },
      async getThread(threadId: string) {
        queryCount += 1;
        return {
          threadId: queryCount === 2 ? "thread-colliding" : threadId,
          projectId: "project-1",
          snapshotSequence: 20 + queryCount,
          session: { status: "ready", activeTurnId: null },
          latestTurn: null,
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = ["command-stable", "message-stable"];
    const facade = createT3Facade(runtime, {
      ...DISPATCH_MODES,
      id: () => ids.shift()!,
      now: () => "2026-07-31T00:00:00.000Z",
    });

    await expect(facade.send("thread-1", "follow-up")).rejects.toMatchObject({
      code: "transport_unavailable",
      sequence: 22,
    });
    expect(attempts).toBe(1);
    expect(queryCount).toBe(2);
    expect(ids).toHaveLength(0);
  });

  test("rejects a different thread after the final ambiguous-send reconciliation", async () => {
    let attempts = 0;
    let queryCount = 0;
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
        attempts += 1;
        throw new AmbiguousDispatchError();
      },
      async getThread(threadId: string) {
        queryCount += 1;
        const colliding = queryCount === 3;
        return {
          threadId: colliding ? "thread-colliding" : threadId,
          projectId: "project-1",
          snapshotSequence: 20 + queryCount,
          session: { status: "ready", activeTurnId: null },
          latestTurn: colliding
            ? {
                turnId: "turn-colliding",
                status: "running",
                userMessageId: "message-stable",
                assistantMessage: null,
              }
            : null,
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = ["command-stable", "message-stable"];
    const facade = createT3Facade(runtime, {
      ...DISPATCH_MODES,
      id: () => ids.shift()!,
      now: () => "2026-07-31T00:00:00.000Z",
    });

    await expect(facade.send("thread-1", "follow-up")).rejects.toBeInstanceOf(
      AmbiguousDispatchError,
    );
    expect(attempts).toBe(2);
    expect(queryCount).toBe(3);
    expect(ids).toHaveLength(0);
  });

  for (const blocked of [
    {
      label: "an active turn",
      session: { status: "ready", activeTurnId: "turn-other" },
      latestTurn: null,
      pendingApproval: null,
      pendingInput: null,
    },
    {
      label: "a starting session",
      session: { status: "starting", activeTurnId: null },
      latestTurn: null,
      pendingApproval: null,
      pendingInput: null,
    },
    {
      label: "a running session",
      session: { status: "running", activeTurnId: null },
      latestTurn: null,
      pendingApproval: null,
      pendingInput: null,
    },
    {
      label: "a running latest turn",
      session: { status: "ready", activeTurnId: null },
      latestTurn: {
        turnId: "turn-other",
        status: "running",
        userMessageId: "message-other",
        assistantMessage: null,
      },
      pendingApproval: null,
      pendingInput: null,
    },
    {
      label: "pending approval",
      session: { status: "ready", activeTurnId: null },
      latestTurn: null,
      pendingApproval: { requestId: "approval-other" },
      pendingInput: null,
    },
    {
      label: "pending input",
      session: { status: "ready", activeTurnId: null },
      latestTurn: null,
      pendingApproval: null,
      pendingInput: { requestId: "input-other" },
    },
  ] as const) {
    test(`does not retry an ambiguous send after reconciliation finds ${blocked.label}`, async () => {
      let attempts = 0;
      let queryCount = 0;
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
          attempts += 1;
          throw new AmbiguousDispatchError();
        },
        async getThread(threadId: string) {
          queryCount += 1;
          if (queryCount === 1) {
            return {
              threadId,
              projectId: "project-1",
              snapshotSequence: 20,
              session: { status: "ready", activeTurnId: null },
              latestTurn: null,
              pendingApproval: null,
              pendingInput: null,
            };
          }
          return {
            threadId,
            projectId: "project-1",
            snapshotSequence: 22,
            session: blocked.session,
            latestTurn: blocked.latestTurn,
            pendingApproval: blocked.pendingApproval,
            pendingInput: blocked.pendingInput,
          };
        },
        async *subscribeThread() {
          return;
        },
      };
      const ids = ["command-stable", "message-stable"];
      const facade = createT3Facade(runtime, {
        ...DISPATCH_MODES,
        id: () => ids.shift()!,
        now: () => "2026-07-31T00:00:00.000Z",
      });

      await expect(facade.send("thread-1", "follow-up")).rejects.toMatchObject({
        code: "turn_error",
        sequence: 22,
      });
      expect(attempts).toBe(1);
      expect(queryCount).toBe(2);
      expect(ids).toHaveLength(0);
    });
  }

  test("fails after final reconciliation without a third dispatch or new IDs", async () => {
    let attempts = 0;
    let queryCount = 0;
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
        attempts += 1;
        throw new AmbiguousDispatchError();
      },
      async getThread(threadId: string) {
        queryCount += 1;
        return {
          threadId,
          projectId: "project-1",
          snapshotSequence: 20 + queryCount,
          session: { status: "ready", activeTurnId: null },
          latestTurn: null,
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = ["command-stable", "message-stable"];
    const facade = createT3Facade(runtime, {
      ...DISPATCH_MODES,
      id: () => ids.shift()!,
      now: () => "2026-07-31T00:00:00.000Z",
    });

    await expect(facade.send("thread-1", "follow-up")).rejects.toBeInstanceOf(
      AmbiguousDispatchError,
    );
    expect(attempts).toBe(2);
    expect(queryCount).toBe(3);
    expect(ids).toHaveLength(0);
  });

  for (const pendingKind of ["pendingApproval", "pendingInput"] as const) {
    test(`refuses a new turn while native state reports ${pendingKind}`, async () => {
      let attempts = 0;
      const evidence: unknown[] = [];
      const ids = ["command-unused", "message-unused"];
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
          attempts += 1;
          return { sequence: 3 };
        },
        async getThread(threadId: string) {
          return {
            threadId,
            projectId: "project-1",
            snapshotSequence: 20,
            session: { status: "ready", activeTurnId: null },
            latestTurn: null,
            pendingApproval:
              pendingKind === "pendingApproval"
                ? { requestId: "approval-1" }
                : null,
            pendingInput:
              pendingKind === "pendingInput" ? { requestId: "input-1" } : null,
          };
        },
        async *subscribeThread() {
          return;
        },
      };
      const facade = createT3Facade(runtime, {
        ...DISPATCH_MODES,
        id: () => ids.shift()!,
        evidence: (record) => evidence.push(record),
      });

      await expect(
        facade.send("thread-1", "must not dispatch"),
      ).rejects.toMatchObject({
        code: "turn_error",
        sequence: 20,
      });
      expect(attempts).toBe(0);
      expect(ids).toEqual(["command-unused", "message-unused"]);
      expect(evidence).toEqual([]);
    });
  }

  test("refuses a second turn while native state reports one in flight", async () => {
    let attempts = 0;
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
        attempts += 1;
        return { sequence: 3 };
      },
      async getThread(threadId: string) {
        return {
          threadId,
          projectId: "project-1",
          snapshotSequence: 20,
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
      },
      async *subscribeThread() {
        return;
      },
    };
    const facade = createT3Facade(runtime, DISPATCH_MODES);

    await expect(facade.send("thread-1", "duplicate")).rejects.toMatchObject({
      code: "turn_error",
      sequence: 20,
    });
    expect(attempts).toBe(0);
  });
});
