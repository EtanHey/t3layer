import { describe, expect, test } from "bun:test";

import {
  WorkerOverlayError,
  createWorkerOverlay,
  type WorkerOverlayRecord,
} from "../src/overlay";

function captureOverlayError(operation: () => unknown): WorkerOverlayError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkerOverlayError);
    return error as WorkerOverlayError;
  }
  throw new Error("expected a WorkerOverlayError");
}

describe("process-local worker hierarchy overlay", () => {
  test("keys identity by the scoped environment and thread ref", () => {
    const overlay = createWorkerOverlay({ now: () => "2026-08-01T20:00:00.000Z" });
    const first = overlay.attach(
      { environmentId: "env-a", threadId: "shared" },
      { role: "worker", parentRef: null },
    );
    const second = overlay.attach(
      { environmentId: "env-b", threadId: "shared" },
      { role: "reviewer", parentRef: null },
    );

    expect(first).toMatchObject({
      ref: { environmentId: "env-a", threadId: "shared" },
      role: "worker",
      parentRef: null,
      depth: 0,
      creation: { source: "attach", createdAt: "2026-08-01T20:00:00.000Z" },
    });
    expect(second).toMatchObject({
      ref: { environmentId: "env-b", threadId: "shared" },
      role: "reviewer",
    });
    expect(overlay.listWorkers()).toHaveLength(2);
  });

  test("rejects cross-environment parents and cycles without mutating known records", () => {
    const overlay = createWorkerOverlay();
    const parent = { environmentId: "env-a", threadId: "parent" };
    const child = { environmentId: "env-a", threadId: "child" };

    expect(
      captureOverlayError(() =>
        overlay.attach(
          { environmentId: "env-b", threadId: "foreign-child" },
          { role: "worker", parentRef: parent },
        ),
      ),
    ).toMatchObject({ code: "overlay_environment_mismatch" });

    overlay.attach(parent, { role: "lead", parentRef: child });
    expect(
      captureOverlayError(() =>
        overlay.attach(child, { role: "worker", parentRef: parent }),
      ),
    ).toMatchObject({ code: "overlay_cycle" });
    expect(overlay.listWorkers().map((entry) => entry.ref.threadId)).toEqual(["parent"]);
  });

  test("enforces depth and capacity, including outstanding spawn reservations", () => {
    const depthBounded = createWorkerOverlay({ maxDepth: 1, maxWorkers: 3 });
    const root = { environmentId: "env-a", threadId: "root" };
    const child = { environmentId: "env-a", threadId: "child" };
    depthBounded.attach(root, { role: "lead", parentRef: null });
    depthBounded.attach(child, { role: "worker", parentRef: root });

    expect(
      captureOverlayError(() =>
        depthBounded.attach(
          { environmentId: "env-a", threadId: "grandchild" },
          { role: "worker", parentRef: child },
        ),
      ),
    ).toMatchObject({ code: "overlay_depth_exceeded" });

    const capacityBounded = createWorkerOverlay({ maxWorkers: 1 });
    const reservation = capacityBounded.reserve(null, {
      role: "worker",
      parentRef: null,
    });
    expect(
      captureOverlayError(() =>
        capacityBounded.attach(root, { role: "lead", parentRef: null }),
      ),
    ).toMatchObject({ code: "overlay_capacity_exceeded" });
    reservation.release();
    expect(capacityBounded.attach(root, { role: "lead", parentRef: null }).depth).toBe(0);
  });

  test("computes descendants when a previously unknown parent is attached", () => {
    const overlay = createWorkerOverlay({ maxDepth: 3 });
    const root = { environmentId: "env-a", threadId: "root" };
    const child = { environmentId: "env-a", threadId: "child" };
    const grandchild = { environmentId: "env-a", threadId: "grandchild" };
    overlay.attach(grandchild, { role: "worker", parentRef: child });
    expect(overlay.getWorker(grandchild).depth).toBeNull();
    overlay.attach(child, { role: "worker", parentRef: root });
    expect(overlay.getWorker(grandchild).depth).toBeNull();
    overlay.attach(root, { role: "lead", parentRef: null });

    expect(overlay.getWorker(grandchild).depth).toBe(2);
    expect(overlay.listChildren(root).map((entry) => entry.ref.threadId)).toEqual(["child"]);
    expect(overlay.listChildren(child).map((entry) => entry.ref.threadId)).toEqual([
      "grandchild",
    ]);
  });

  test("returns defensive records and reports lost metadata as overlay_unknown", () => {
    const ref = { environmentId: "env-a", threadId: "worker" };
    const firstProcess = createWorkerOverlay({ now: () => "2026-08-01T20:00:00.000Z" });
    const reservation = firstProcess.reserve(null, { role: "worker", parentRef: null });
    const record: WorkerOverlayRecord = reservation.commit(ref, { source: "spawn" });
    ref.threadId = "mutated-by-caller";

    expect(record).toMatchObject({
      ref: { environmentId: "env-a", threadId: "worker" },
      creation: { source: "spawn", createdAt: "2026-08-01T20:00:00.000Z" },
    });
    expect(firstProcess.getWorker({ environmentId: "env-a", threadId: "worker" })).toEqual(
      record,
    );

    const restartedProcess = createWorkerOverlay();
    expect(
      captureOverlayError(() =>
        restartedProcess.getWorker({ environmentId: "env-a", threadId: "worker" }),
      ),
    ).toMatchObject({ code: "overlay_unknown" });
    expect(
      captureOverlayError(() =>
        restartedProcess.listChildren({ environmentId: "env-a", threadId: "worker" }),
      ),
    ).toMatchObject({ code: "overlay_unknown" });
    expect(restartedProcess.listWorkers()).toEqual([]);
  });

  test("rejects duplicate refs and invalid role labels", () => {
    const overlay = createWorkerOverlay();
    const ref = { environmentId: "env-a", threadId: "worker" };
    overlay.attach(ref, { role: "worker", parentRef: null });

    expect(
      captureOverlayError(() => overlay.attach(ref, { role: "reviewer", parentRef: null })),
    ).toMatchObject({ code: "overlay_duplicate" });
    expect(
      captureOverlayError(() =>
        overlay.attach(
          { environmentId: "env-a", threadId: "other" },
          { role: " ", parentRef: null },
        ),
      ),
    ).toMatchObject({ code: "overlay_invalid_role" });
  });
});
