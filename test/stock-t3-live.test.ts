import { describe, expect, test } from "bun:test";

import { createStockT3Facade } from "../src/facade";
import { createStockT3NativeRuntime } from "../src/nativeRuntime";
import { canonicalProvisionalProof } from "../src/stockProof";

const live = Bun.env.T3_STOCK_LIVE === "1";

describe.skipIf(!live)("isolated exact-stock live proof", () => {
  test("performs receipt-targeted spawn -> wait -> send -> wait", async () => {
    const startedAt = new Date().toISOString();
    const baseUrl = Bun.env.T3_STOCK_BASE_URL;
    const bearerToken = Bun.env.T3_STOCK_HTTP_TOKEN;
    const workspaceRoot = Bun.env.T3_STOCK_WORKSPACE_ROOT;
    const receiptPath = Bun.env.T3_STOCK_RECEIPT_PATH;
    const runId = Bun.env.T3_STOCK_RUN_ID;
    if (!baseUrl || !bearerToken || !workspaceRoot || !receiptPath || !runId) {
      throw new Error("live harness contract is incomplete");
    }
    const runtime = createStockT3NativeRuntime({
      baseUrl,
      bearerToken,
      connectionProfile: "local",
    });
    const facade = createStockT3Facade(runtime);
    const modelSelection = { instanceId: "claudeAgent", model: "claude-sonnet-4-5" };
    const title = `t3layer-stock-proof-${runId.slice(0, 8)}`;
    const spawned = await facade.spawn({
      workspaceRoot,
      projectCreateIdentity: {
        projectId: crypto.randomUUID(),
        commandId: crypto.randomUUID(),
        createdAt: startedAt,
        workspaceRoot,
        title,
        defaultModelSelection: modelSelection,
      },
      title,
      message: "Reply with exactly T3LAYER_STOCK_PROOF_OK.",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    expect(spawned.kind).toBe("spawned");
    if (spawned.kind !== "spawned") throw new Error("live spawn was partial");
    const first = await facade.wait(spawned.turnReceipt, { timeoutMs: 120_000 });
    const sent = await facade.send(
      spawned.agentRef,
      "Reply with exactly T3LAYER_STOCK_PROOF_FOLLOWUP_OK.",
      { timeoutMs: 120_000 },
    );
    const second = await facade.wait(sent, { timeoutMs: 120_000 });
    const descriptor = await runtime.client.getDescriptor();
    const detail = await runtime.observe(spawned.agentRef, { timeoutMs: 30_000 });
    if (detail === undefined) throw new Error("live thread disappeared before receipt capture");
    const http = runtime.httpObservations();
    const polls = runtime.pollMetrics();
    const requiredSequence = (value: number | null, label: string): number => {
      if (value === null) throw new Error(`${label} accepted sequence is required`);
      return value;
    };

    const provisional = canonicalProvisionalProof({
        provisional: true,
        success: false,
        runId,
        environmentId: descriptor.environmentId,
        serverVersion: descriptor.serverVersion,
        endpointStatusTrace: http.endpointStatusTrace,
        ids: {
          projectId: detail.thread.projectId,
          threadId: spawned.agentRef.threadId,
          createCommandId: spawned.createReceipt.commandId,
          initialCommandId: spawned.turnReceipt.commandId,
          initialMessageId: spawned.turnReceipt.messageId,
          followupCommandId: sent.commandId,
          followupMessageId: sent.messageId,
        },
        sequences: {
          create: requiredSequence(spawned.createReceipt.acceptedSequence, "create"),
          initial: requiredSequence(spawned.turnReceipt.acceptedSequence, "initial"),
          followup: requiredSequence(sent.acceptedSequence, "followup"),
        },
        terminalKinds: [first.kind, second.kind],
        counters: {
          requests: http.requestCount,
          shellPolls: polls.shellStarts,
          detailPolls: polls.detailStarts,
          peakInFlight: Math.max(http.peakInFlight, polls.peakHttpInFlight),
        },
        timestamps: { startedAt, completedAt: new Date().toISOString() },
      }, runId);
    await Bun.write(receiptPath, `${JSON.stringify(provisional)}\n`);
    expect(first.kind).toBe("completed");
    expect(second.kind).toBe("completed");
  }, 120_000);
});
