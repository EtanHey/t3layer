#!/usr/bin/env bash
set -euo pipefail

stock_tree=${1:?exact stock worktree path is required}
expected_sha=d3037064e61a9f059eafbd4f9869679779bd2a7c
generated_relative=apps/server/src/orchestration/Layers/T3LayerStockProjectionCharacterization.generated.test.ts
generated_path="$stock_tree/$generated_relative"

actual_sha=$(/usr/bin/git -C "$stock_tree" rev-parse HEAD)
if [[ "$actual_sha" != "$expected_sha" ]]; then
  echo "ERROR: exact stock SHA mismatch" >&2
  exit 2
fi

if [[ -e "$generated_path" ]]; then
  echo "ERROR: generated characterization path already exists" >&2
  exit 3
fi

cleanup() {
  rm -f -- "$generated_path"
}
trap cleanup EXIT INT TERM

/bin/cat >"$generated_path" <<'CHARACTERIZATION'
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, test } from "vite-plus/test";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";

test("two accepted same-ID/equal-time turns collapse to the later stock projection", async () => {
  const config = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3layer-stock-characterization-",
  });
  const layer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    WorkspacePaths.layer,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(config),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  try {
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const workspacePaths = await runtime.runPromise(Effect.service(WorkspacePaths.WorkspacePaths));
    const createdAt = "2026-07-31T18:00:00.000Z";
    const threadId = ThreadId.make("thread-t3layer-stock-characterization");
    const messageId = MessageId.make("message-t3layer-stock-characterization");

    const normalizedWorkspaceRoot = await runtime.runPromise(
      workspacePaths.normalizeWorkspaceRoot(`  ${process.cwd()}/  `),
    );
    expect(normalizedWorkspaceRoot).toBe(process.cwd());
    expect(normalizeProjectPathForComparison(`${process.cwd()}/`)).toBe(process.cwd());
    expect(normalizeProjectPathForComparison("C:/Users/Etan/Project/"))
      .toBe("c:\\users\\etan\\project");
    const projectCommand = {
      type: "project.create" as const,
      commandId: CommandId.make("cmd-project-characterization"),
      projectId: ProjectId.make("project-t3layer-stock-characterization"),
      title: "characterization",
      workspaceRoot: normalizedWorkspaceRoot,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt,
    };
    const [firstProject, exactReplay] = await Promise.all([
      runtime.runPromise(engine.dispatch(projectCommand)),
      runtime.runPromise(engine.dispatch(projectCommand)),
    ]);
    expect(exactReplay.sequence).toBe(firstProject.sequence);
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-characterization"),
        threadId,
        projectId: ProjectId.make("project-t3layer-stock-characterization"),
        title: "characterization",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const first = await runtime.runPromise(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-first"),
        threadId,
        message: { messageId, role: "user", text: "first", attachments: [] },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    const second = await runtime.runPromise(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-second"),
        threadId,
        message: { messageId, role: "user", text: "second", attachments: [] },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    expect(second.sequence).toBeGreaterThan(first.sequence);

    const events = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.filter((event) => event.commandId === "cmd-turn-first")).toHaveLength(2);
    expect(events.filter((event) => event.commandId === "cmd-turn-second")).toHaveLength(2);

    const messageRows = await runtime.runPromise(sql<{
      readonly messageId: string;
      readonly text: string;
      readonly createdAt: string;
    }>`
      SELECT
        message_id AS "messageId",
        text,
        created_at AS "createdAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
    `);
    expect(messageRows).toEqual([{ messageId, text: "second", createdAt }]);

    const pendingRows = await runtime.runPromise(sql<{
      readonly messageId: string;
      readonly requestedAt: string;
    }>`
      SELECT
        pending_message_id AS "messageId",
        requested_at AS "requestedAt"
      FROM projection_turns
      WHERE thread_id = ${threadId}
        AND turn_id IS NULL
        AND state = 'pending'
    `);
    expect(pendingRows).toEqual([{ messageId, requestedAt: createdAt }]);

    const snapshot = await runtime.runPromise(snapshotQuery.getSnapshot());
    expect(snapshot.projects.filter((entry) => entry.id === projectCommand.projectId)).toHaveLength(1);
    expect(snapshot.projects.find((entry) => entry.id === projectCommand.projectId)?.workspaceRoot)
      .toBe(process.cwd());
    const projected = snapshot.threads.find((entry) => entry.id === threadId);
    expect(projected?.messages.filter((entry) => entry.id === messageId)).toHaveLength(1);
    expect(projected?.messages.find((entry) => entry.id === messageId)?.text).toBe("second");
  } finally {
    await runtime.dispose();
  }
});
CHARACTERIZATION

if [[ ${T3_STOCK_EXACT_FAIL_AT:-} == after-generated-fixture ]]; then
  echo "ERROR: injected failure: after-generated-fixture" >&2
  exit 91
fi

(cd "$stock_tree" && corepack pnpm --filter t3 exec vp test run src/orchestration/Layers/T3LayerStockProjectionCharacterization.generated.test.ts)
