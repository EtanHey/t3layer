import { describe, expect, test } from "bun:test";
import { AmbiguousDispatchError, createT3Facade } from "../src/facade";

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
        createdAt: "2026-07-30T18:05:00.000Z",
        attachments: [],
      },
    ]);
    expect(receipt).toEqual({
      agentId: "thread-1",
      commandId: "command-2",
      messageId: "message-2",
      sequence: 21,
      recovered: false,
    });
    expect(evidence).toEqual([
      {
        operation: "send",
        commandId: "command-2",
        threadId: "thread-1",
        messageId: "message-2",
        createdAt: "2026-07-30T18:05:00.000Z",
        attachments: 0,
        messageBytes: 16,
      },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("secret follow-up");
    expect(JSON.stringify(calls)).not.toContain("bootstrap");
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
    const facade = createT3Facade(runtime);

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
    const facade = createT3Facade(runtime);

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
      id: () => ids.shift()!,
      now: () => "2026-07-30T18:05:00.000Z",
    });

    const receipt = await facade.send("thread-1", "follow-up");

    expect(attempts).toBe(1);
    expect(receipt).toEqual({
      agentId: "thread-1",
      commandId: "command-2",
      messageId: "message-2",
      snapshotSequence: 22,
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
      createdAt: "2026-07-31T00:00:00.000Z",
      attachments: [],
    });
    expect(ids).toHaveLength(0);
    expect(receipt).toEqual({
      agentId: "thread-1",
      commandId: "command-stable",
      messageId: "message-stable",
      sequence: 23,
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
      snapshotSequence: 23,
      recovered: true,
    });
  });

  for (const reconciliationQuery of [2, 3]) {
    test(`rejects a different thread on ambiguous send reconciliation query ${reconciliationQuery}`, async () => {
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
          const colliding = queryCount === reconciliationQuery;
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
    const facade = createT3Facade(runtime);

    await expect(facade.send("thread-1", "duplicate")).rejects.toMatchObject({
      code: "turn_error",
      sequence: 20,
    });
    expect(attempts).toBe(0);
  });
});
