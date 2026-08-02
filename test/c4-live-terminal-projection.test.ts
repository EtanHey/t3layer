import { describe, expect, test } from "bun:test";

import {
  createStockT3NativeRuntime,
  type StockT3RuntimeClient,
} from "../src/nativeRuntime";
import type {
  ShellSnapshot,
  StockLatestTurn,
  StockMessage,
  StockSession,
  StockThreadShell,
  ThreadDetailSnapshot,
} from "../src/stockT3Contracts";

const requestedAt = "2026-08-02T16:13:16.955Z";
const laterAt = "2026-08-02T16:13:29.676Z";
const selection = { instanceId: "claudeAgent", model: "claude-sonnet-4-5" };
const project = {
  id: "project-1",
  title: "project",
  workspaceRoot: "/tmp/project",
  defaultModelSelection: selection,
  createdAt: requestedAt,
  updatedAt: requestedAt,
};
const ref = { environmentId: "env-1", threadId: "thread-1" };

const pendingBoundTurn: StockLatestTurn = {
  turnId: "turn-a",
  state: "running",
  requestedAt,
  startedAt: requestedAt,
  completedAt: null,
  assistantMessageId: null,
};
const boundTurn: StockLatestTurn = {
  ...pendingBoundTurn,
  assistantMessageId: "assistant-a",
};
const reboundAssistantTurn: StockLatestTurn = {
  ...boundTurn,
  assistantMessageId: "assistant-b",
};
const newerTurn: StockLatestTurn = {
  turnId: "turn-b",
  state: "running",
  requestedAt: laterAt,
  startedAt: laterAt,
  completedAt: null,
  assistantMessageId: null,
};
const runningSession: StockSession = {
  threadId: ref.threadId,
  status: "running",
  providerName: "claudeAgent",
  activeTurnId: boundTurn.turnId,
  lastError: null,
  updatedAt: requestedAt,
};
const readySession: StockSession = {
  ...runningSession,
  status: "ready",
  activeTurnId: null,
  updatedAt: laterAt,
};
const userMessages: readonly StockMessage[] = [
  {
    id: "message-1",
    role: "user",
    text: "target",
    attachments: [],
    turnId: null,
    streaming: false,
    createdAt: requestedAt,
    updatedAt: requestedAt,
  },
];
const completedMessages: readonly StockMessage[] = [
  ...userMessages,
  {
    id: "assistant-a",
    role: "assistant",
    text: "done",
    attachments: [],
    turnId: boundTurn.turnId,
    streaming: false,
    createdAt: laterAt,
    updatedAt: laterAt,
  },
];
const mismatchedAssistantMessages: readonly StockMessage[] = completedMessages.map((entry) =>
  entry.role === "assistant" ? { ...entry, id: "assistant-b" } : entry,
);

function shellThread(
  latestTurn: StockLatestTurn | null,
  session: StockSession | null,
): StockThreadShell {
  return {
    id: ref.threadId,
    projectId: project.id,
    title: "worker",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn,
    createdAt: requestedAt,
    updatedAt: laterAt,
    session,
    latestUserMessageAt: requestedAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  };
}

function shell(
  sequence: number,
  latestTurn: StockLatestTurn | null,
  session: StockSession | null,
): ShellSnapshot {
  return {
    snapshotSequence: sequence,
    projects: [project],
    threads: [shellThread(latestTurn, session)],
    updatedAt: laterAt,
  };
}

function detail(
  sequence: number,
  latestTurn: StockLatestTurn | null,
  session: StockSession | null,
  projectedMessages: readonly StockMessage[] = [],
): ThreadDetailSnapshot {
  const identity = shellThread(latestTurn, session);
  return {
    snapshotSequence: sequence,
    thread: {
      id: identity.id,
      projectId: identity.projectId,
      title: identity.title,
      modelSelection: identity.modelSelection,
      runtimeMode: identity.runtimeMode,
      interactionMode: identity.interactionMode,
      branch: identity.branch,
      worktreePath: identity.worktreePath,
      latestTurn,
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt,
      session,
      messages: [...projectedMessages],
      activities: [],
      checkpoints: [],
    },
  };
}

interface Projection {
  readonly sequence: number;
  readonly latestTurn: StockLatestTurn | null;
  readonly shellLatestTurn?: StockLatestTurn | null;
  readonly session: StockSession;
  readonly messages: readonly StockMessage[];
}

function clientForProjections(
  projections: readonly Projection[],
  onDetailProjection?: (sequence: number) => void,
): StockT3RuntimeClient {
  let shellReads = 0;
  let detailReads = 0;
  const projection = (index: number) => projections[Math.min(index, projections.length - 1)]!;
  return {
    getDescriptor: async () => ({
      environmentId: ref.environmentId,
      label: "local",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "stock",
      capabilities: { repositoryIdentity: false },
    }),
    getShell: async () => {
      shellReads += 1;
      const current = projection(shellReads - 1);
      return shell(
        current.sequence,
        current.shellLatestTurn === undefined
          ? current.latestTurn
          : current.shellLatestTurn,
        current.session,
      );
    },
    getThread: async () => {
      detailReads += 1;
      if (detailReads === 1) return detail(1, null, null, []);
      const current = projection(detailReads - 2);
      onDetailProjection?.(current.sequence);
      return detail(
        current.sequence,
        current.latestTurn,
        current.session,
        current.messages,
      );
    },
    dispatch: async () => ({ sequence: 4 }),
  };
}

function runtimeFor(
  projections: readonly Projection[],
  onDetailProjection?: (sequence: number) => void,
  clock?: () => number,
) {
  const ids = ["command-1", "message-1", "lease-1"];
  return createStockT3NativeRuntime({
    client: clientForProjections(projections, onDetailProjection),
    id: () => ids.shift()!,
    now: () => requestedAt,
    ...(clock === undefined ? {} : { clock }),
  });
}

function clientForIndependentProjections(
  shellProjections: readonly Projection[],
  detailProjections: readonly Projection[],
  onDetailProjection?: (sequence: number) => void,
): StockT3RuntimeClient {
  let shellReads = 0;
  let detailReads = 0;
  const projection = (stream: readonly Projection[], index: number) =>
    stream[Math.min(index, stream.length - 1)]!;
  return {
    getDescriptor: async () => ({
      environmentId: ref.environmentId,
      label: "local",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "stock",
      capabilities: { repositoryIdentity: false },
    }),
    getShell: async () => {
      const current = projection(shellProjections, shellReads);
      shellReads += 1;
      return shell(
        current.sequence,
        current.shellLatestTurn === undefined
          ? current.latestTurn
          : current.shellLatestTurn,
        current.session,
      );
    },
    getThread: async () => {
      detailReads += 1;
      if (detailReads === 1) return detail(1, null, null, []);
      const current = projection(detailProjections, detailReads - 2);
      onDetailProjection?.(current.sequence);
      return detail(
        current.sequence,
        current.latestTurn,
        current.session,
        current.messages,
      );
    },
    dispatch: async () => ({ sequence: 4 }),
  };
}

function runtimeForIndependentProjections(
  shellProjections: readonly Projection[],
  detailProjections: readonly Projection[],
  onDetailProjection?: (sequence: number) => void,
  clock?: () => number,
) {
  const ids = ["command-1", "message-1", "lease-1"];
  return createStockT3NativeRuntime({
    client: clientForIndependentProjections(
      shellProjections,
      detailProjections,
      onDetailProjection,
    ),
    id: () => ids.shift()!,
    now: () => requestedAt,
    ...(clock === undefined ? {} : { clock }),
  });
}

describe("criterion-4 terminal projection rollover", () => {
  test("completes from the bound finalized assistant after stock clears latestTurn", async () => {
    const runtime = runtimeFor([
      { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
      { sequence: 14, latestTurn: boundTurn, session: runningSession, messages: completedMessages },
      { sequence: 16, latestTurn: null, session: readySession, messages: completedMessages },
    ]);
    const receipt = await runtime.send(ref, "target");

    await expect(runtime.wait(receipt, { timeoutMs: 3_000 })).resolves.toMatchObject({
      kind: "completed",
      assistantContent: "done",
      snapshotSequence: 16,
    });
    runtime.close();
  });

  test("still rejects a genuinely newer non-null turn after binding", async () => {
    const runtime = runtimeFor([
      { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
      {
        sequence: 16,
        latestTurn: newerTurn,
        session: {
          ...runningSession,
          activeTurnId: newerTurn.turnId,
          updatedAt: laterAt,
        },
        messages: userMessages,
      },
    ]);
    const receipt = await runtime.send(ref, "target");

    await expect(runtime.wait(receipt, { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "concurrent_writer",
      evidence: { reason: "turn_changed" },
    });
    runtime.close();
  });

  test("rejects a different assistant id advertised later for the bound turn", async () => {
    const runtime = runtimeFor([
      { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
      { sequence: 14, latestTurn: boundTurn, session: runningSession, messages: completedMessages },
      {
        sequence: 15,
        latestTurn: reboundAssistantTurn,
        session: runningSession,
        messages: mismatchedAssistantMessages,
      },
    ]);
    const receipt = await runtime.send(ref, "target");

    await expect(runtime.wait(receipt, { timeoutMs: 3_000 })).rejects.toMatchObject({
      code: "concurrent_writer",
      evidence: { reason: "assistant_message_changed" },
    });
    runtime.close();
  });

  test("rejects when shell and detail disagree about a cleared latestTurn", async () => {
    const runtime = runtimeFor([
      { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
      {
        sequence: 16,
        latestTurn: null,
        shellLatestTurn: boundTurn,
        session: readySession,
        messages: completedMessages,
      },
    ]);
    const receipt = await runtime.send(ref, "target");

    await expect(runtime.wait(receipt, { timeoutMs: 3_000 })).rejects.toMatchObject({
      code: "concurrent_writer",
      evidence: { reason: "shell_detail_turn_conflict" },
    });
    runtime.close();
  });

  test("captures the exact assistant id from shell when detail misses the advertising snapshot", async () => {
    let currentMs = 0;
    let terminalObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      terminalObserved = resolve;
    });
    const runtime = runtimeForIndependentProjections(
      [
        { sequence: 8, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 14, latestTurn: boundTurn, session: runningSession, messages: completedMessages },
        { sequence: 16, latestTurn: null, session: readySession, messages: completedMessages },
      ],
      [
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 11, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 16, latestTurn: null, session: readySession, messages: completedMessages },
      ],
      (sequence) => {
        if (sequence === 16) terminalObserved();
      },
      () => currentMs,
    );
    const receipt = await runtime.send(ref, "target");
    const pending = runtime.wait(receipt, { timeoutMs: 30_000 });
    await observed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    currentMs = 30_001;

    await expect(pending).resolves.toMatchObject({
      kind: "completed",
      assistantContent: "done",
      snapshotSequence: 16,
    });
    runtime.close();
  }, 20_000);

  test("refuses a terminal assistant id substituted after a shell-only advertisement", async () => {
    let currentMs = 0;
    let terminalObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      terminalObserved = resolve;
    });
    const runtime = runtimeForIndependentProjections(
      [
        { sequence: 8, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 14, latestTurn: boundTurn, session: runningSession, messages: completedMessages },
        { sequence: 16, latestTurn: null, session: readySession, messages: mismatchedAssistantMessages },
      ],
      [
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 11, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 16, latestTurn: null, session: readySession, messages: mismatchedAssistantMessages },
      ],
      (sequence) => {
        if (sequence === 16) terminalObserved();
      },
      () => currentMs,
    );
    const receipt = await runtime.send(ref, "target");
    const pending = runtime.wait(receipt, { timeoutMs: 30_000 });
    await observed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    currentMs = 30_001;

    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    runtime.close();
  }, 20_000);

  test("does not infer an assistant id when neither projection ever advertises one", async () => {
    let currentMs = 0;
    let terminalObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      terminalObserved = resolve;
    });
    const runtime = runtimeForIndependentProjections(
      [
        { sequence: 8, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 14, latestTurn: pendingBoundTurn, session: runningSession, messages: completedMessages },
        { sequence: 16, latestTurn: null, session: readySession, messages: completedMessages },
      ],
      [
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 11, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 16, latestTurn: null, session: readySession, messages: completedMessages },
      ],
      (sequence) => {
        if (sequence === 16) terminalObserved();
      },
      () => currentMs,
    );
    const receipt = await runtime.send(ref, "target");
    const pending = runtime.wait(receipt, { timeoutMs: 30_000 });
    await observed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    currentMs = 30_001;

    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    runtime.close();
  }, 20_000);

  test("does not capture an assistant id when shell requestedAt disagrees with the bound target", async () => {
    let currentMs = 0;
    let terminalObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      terminalObserved = resolve;
    });
    const skewedAdvertisement = {
      ...boundTurn,
      requestedAt: laterAt,
    };
    const runtime = runtimeForIndependentProjections(
      [
        { sequence: 8, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        {
          sequence: 14,
          latestTurn: skewedAdvertisement,
          session: runningSession,
          messages: completedMessages,
        },
        { sequence: 16, latestTurn: null, session: readySession, messages: completedMessages },
      ],
      [
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 11, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 16, latestTurn: null, session: readySession, messages: completedMessages },
      ],
      (sequence) => {
        if (sequence === 16) terminalObserved();
      },
      () => currentMs,
    );
    const receipt = await runtime.send(ref, "target");
    const pending = runtime.wait(receipt, { timeoutMs: 30_000 });
    await observed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    currentMs = 30_001;

    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    runtime.close();
  }, 20_000);

  test("does not capture an assistant id from a shell pointer re-pointed to another turn", async () => {
    let currentMs = 0;
    let terminalObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      terminalObserved = resolve;
    });
    const otherTurnAdvertisement = {
      ...newerTurn,
      assistantMessageId: "assistant-a",
    };
    const runtime = runtimeForIndependentProjections(
      [
        { sequence: 8, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        {
          sequence: 14,
          latestTurn: otherTurnAdvertisement,
          session: { ...runningSession, activeTurnId: otherTurnAdvertisement.turnId },
          messages: completedMessages,
        },
        { sequence: 16, latestTurn: null, session: readySession, messages: completedMessages },
      ],
      [
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 11, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 16, latestTurn: null, session: readySession, messages: completedMessages },
      ],
      (sequence) => {
        if (sequence === 16) terminalObserved();
      },
      () => currentMs,
    );
    const receipt = await runtime.send(ref, "target");
    const pending = runtime.wait(receipt, { timeoutMs: 30_000 });
    await observed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    currentMs = 30_001;

    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    runtime.close();
  }, 20_000);

  test.each([
    ["error", "turn_error"],
    ["stopped", "turn_interrupted"],
    ["interrupted", "turn_interrupted"],
  ] as const)("maps a cleared latestTurn with session %s to %s", async (status, code) => {
    const runtime = runtimeFor([
      { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
      { sequence: 14, latestTurn: boundTurn, session: runningSession, messages: completedMessages },
      {
        sequence: 16,
        latestTurn: null,
        session: { ...readySession, status },
        messages: completedMessages,
      },
    ]);
    const receipt = await runtime.send(ref, "target");

    await expect(runtime.wait(receipt, { timeoutMs: 3_000 })).rejects.toMatchObject({ code });
    runtime.close();
  });

  test("does not complete a cleared ready session without a captured finalized assistant", async () => {
    let currentMs = 0;
    let terminalObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      terminalObserved = resolve;
    });
    const runtime = runtimeFor(
      [
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 16, latestTurn: null, session: readySession, messages: userMessages },
      ],
      (sequence) => {
        if (sequence === 16) terminalObserved();
      },
      () => currentMs,
    );
    const receipt = await runtime.send(ref, "target");
    const pending = runtime.wait(receipt, { timeoutMs: 30_000 });
    await observed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    currentMs = 30_001;

    await expect(pending).rejects.toMatchObject({
      code: "timeout",
    });
    runtime.close();
  });

  test("does not substitute a same-turn assistant whose id was never advertised", async () => {
    let currentMs = 0;
    let terminalObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      terminalObserved = resolve;
    });
    const runtime = runtimeFor(
      [
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        {
          sequence: 14,
          latestTurn: boundTurn,
          session: runningSession,
          messages: mismatchedAssistantMessages,
        },
        {
          sequence: 16,
          latestTurn: null,
          session: readySession,
          messages: mismatchedAssistantMessages,
        },
      ],
      (sequence) => {
        if (sequence === 16) terminalObserved();
      },
      () => currentMs,
    );
    const receipt = await runtime.send(ref, "target");
    const pending = runtime.wait(receipt, { timeoutMs: 30_000 });
    await observed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    currentMs = 30_001;

    await expect(pending).rejects.toMatchObject({
      code: "timeout",
    });
    runtime.close();
  });

  test("still rejects a newer turn after the session pointer first clears", async () => {
    const observedSequences: number[] = [];
    const runtime = runtimeFor(
      [
        { sequence: 9, latestTurn: pendingBoundTurn, session: runningSession, messages: userMessages },
        { sequence: 16, latestTurn: null, session: readySession, messages: userMessages },
        {
          sequence: 17,
          latestTurn: newerTurn,
          session: {
            ...runningSession,
            activeTurnId: newerTurn.turnId,
            updatedAt: laterAt,
          },
          messages: userMessages,
        },
      ],
      (sequence) => observedSequences.push(sequence),
    );
    const receipt = await runtime.send(ref, "target");

    await expect(runtime.wait(receipt, { timeoutMs: 3_000 })).rejects.toMatchObject({
      code: "concurrent_writer",
      evidence: { reason: "turn_changed" },
    });
    expect(observedSequences).toContain(17);
    runtime.close();
  });
});
