import { describe, expect, test } from "bun:test";

import {
  ProtocolMismatchError,
  decodeDescriptor,
  decodeDispatchError,
  decodeDispatchResult,
  decodeReadModelSnapshot,
  decodeShellSnapshot,
  decodeThreadDetailSnapshot,
} from "../src/stockT3Contracts";

const iso = "2026-07-31T18:00:00.000Z";
const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5" };
const session = {
  threadId: "thread-1",
  status: "ready",
  providerName: "claudeAgent",
  activeTurnId: null,
  lastError: null,
  updatedAt: iso,
};
const latestTurn = {
  turnId: "turn-1",
  state: "completed",
  requestedAt: iso,
  startedAt: iso,
  completedAt: iso,
  assistantMessageId: "assistant-1",
};
const threadBase = {
  id: "thread-1",
  projectId: "project-1",
  title: "proof",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn,
  createdAt: iso,
  updatedAt: iso,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  session,
};

describe("stock T3 narrow contracts", () => {
  test("decodes the pinned descriptor and tolerates additive fields", () => {
    expect(
      decodeDescriptor({
        environmentId: "env-1",
        label: "local",
        platform: { os: "darwin", arch: "arm64", future: true },
        serverVersion: "0.0.0-stock",
        capabilities: { repositoryIdentity: true, future: "ok" },
        additive: { accepted: true },
      }),
    ).toEqual({
      environmentId: "env-1",
      label: "local",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-stock",
      capabilities: { repositoryIdentity: true },
    });
  });

  test("fails closed on missing or wrong required descriptor fields", () => {
    expect(() =>
      decodeDescriptor({
        environmentId: "env-1",
        label: "local",
        platform: { os: "darwin", arch: 64 },
        serverVersion: "stock",
        capabilities: {},
      }),
    ).toThrow(ProtocolMismatchError);
  });

  test("decodes shell pending state and detail terminal evidence", () => {
    const shell = decodeShellSnapshot({
      snapshotSequence: 11,
      projects: [
        {
          id: "project-1",
          title: "project",
          workspaceRoot: "/tmp/workspace",
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: iso,
          updatedAt: iso,
        },
      ],
      threads: [
        {
          ...threadBase,
          latestUserMessageAt: iso,
          hasPendingApprovals: false,
          hasPendingUserInput: true,
          hasActionableProposedPlan: false,
        },
      ],
      updatedAt: iso,
      future: true,
    });
    const detail = decodeThreadDetailSnapshot({
      snapshotSequence: 11,
      thread: {
        ...threadBase,
        messages: [
          {
            id: "message-1",
            role: "user",
            text: "hello",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: iso,
            updatedAt: iso,
          },
          {
            id: "assistant-1",
            role: "assistant",
            text: "done",
            attachments: [],
            turnId: "turn-1",
            streaming: false,
            createdAt: iso,
            updatedAt: iso,
          },
        ],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      },
    });

    expect(shell.threads[0]?.hasPendingUserInput).toBe(true);
    expect(detail.thread.messages[1]?.turnId).toBe("turn-1");
  });

  test("decodes archived threads from the full read model", () => {
    const snapshot = decodeReadModelSnapshot({
      snapshotSequence: 12,
      projects: [],
      threads: [{
        ...threadBase,
        archivedAt: iso,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      }],
      updatedAt: iso,
    });

    expect(snapshot.threads[0]).toMatchObject({ id: "thread-1", archivedAt: iso });
  });

  test("preserves absence of lifecycle projections instead of inventing null state", () => {
    const {
      archivedAt: _archivedAt,
      settledOverride: _settledOverride,
      settledAt: _settledAt,
      ...withoutLifecycle
    } = threadBase;
    const snapshot = decodeThreadDetailSnapshot({
      snapshotSequence: 11,
      thread: {
        ...withoutLifecycle,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      },
    });

    expect(Object.hasOwn(snapshot.thread, "archivedAt")).toBeFalse();
    expect(Object.hasOwn(snapshot.thread, "settledOverride")).toBeFalse();
    expect(Object.hasOwn(snapshot.thread, "settledAt")).toBeFalse();
  });

  test("rejects negative or regressing sequence anchors", () => {
    expect(() => decodeDispatchResult({ sequence: -1 })).toThrow(ProtocolMismatchError);
    expect(() =>
      decodeShellSnapshot(
        { snapshotSequence: 4, projects: [], threads: [], updatedAt: iso },
        { minimumSequence: 5 },
      ),
    ).toThrow(ProtocolMismatchError);
  });

  test.each([
    [400, { code: "invalid_request", reason: "invalid_command" }, "command_rejected"],
    [401, { code: "auth_invalid", reason: "invalid_credential" }, "authentication_failed"],
    [403, { code: "insufficient_scope", requiredScope: "orchestration:operate" }, "permission_denied"],
    [500, { code: "internal_error", reason: "orchestration_dispatch_failed" }, "server_internal"],
  ] as const)("decodes exact stock dispatch error %i", (status, body, errorClass) => {
    expect(decodeDispatchError(status, { ...body, traceId: "trace-secret" })).toMatchObject({
      status,
      class: errorClass,
      code: body.code,
      reason: "reason" in body ? body.reason : null,
    });
  });

  test("does not invent a 409 dispatch outcome", () => {
    expect(() => decodeDispatchError(409, { code: "conflict" })).toThrow(
      ProtocolMismatchError,
    );
  });
});
