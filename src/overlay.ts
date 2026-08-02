import type { AgentRef } from "./nativeRuntime";

export const DEFAULT_OVERLAY_MAX_DEPTH = 8;
export const DEFAULT_OVERLAY_MAX_WORKERS = 64;

const MAX_ROLE_BYTES = 256;

export interface WorkerOverlayIdentity {
  readonly role: string;
  readonly parentRef: AgentRef | null;
}

export interface WorkerOverlayRecord extends WorkerOverlayIdentity {
  readonly ref: AgentRef;
  /** Null means the caller supplied a parent chain whose root is not in this process. */
  readonly depth: number | null;
  readonly creation: {
    readonly source: "spawn" | "attach";
    readonly createdAt: string;
  };
}

export interface WorkerOverlayOptions {
  readonly maxDepth?: number;
  readonly maxWorkers?: number;
  readonly now?: () => string;
}

export type WorkerOverlayErrorCode =
  | "overlay_unknown"
  | "overlay_invalid_ref"
  | "overlay_invalid_role"
  | "overlay_invalid_policy"
  | "overlay_duplicate"
  | "overlay_environment_mismatch"
  | "overlay_cycle"
  | "overlay_depth_exceeded"
  | "overlay_capacity_exceeded"
  | "overlay_reservation_closed"
  | "overlay_canonical_not_found";

export class WorkerOverlayError extends Error {
  readonly code: WorkerOverlayErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: WorkerOverlayErrorCode, details: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.name = "WorkerOverlayError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface WorkerOverlayReservation {
  readonly commit: (
    ref: AgentRef,
    creation: { readonly source: "spawn" | "attach" },
  ) => WorkerOverlayRecord;
  readonly release: () => void;
}

interface StoredRecord extends WorkerOverlayIdentity {
  readonly ref: AgentRef;
  readonly creation: WorkerOverlayRecord["creation"];
}

interface PendingRecord {
  readonly token: symbol;
  readonly ref: AgentRef | null;
  readonly identity: WorkerOverlayIdentity;
}

type GraphKey = string | symbol;
const setTerminalState = Symbol("worker-overlay-terminal-state");

function scopedKey(ref: AgentRef): string {
  return JSON.stringify([ref.environmentId, ref.threadId]);
}

function compareScopedKeys(left: AgentRef, right: AgentRef): number {
  const leftKey = scopedKey(left);
  const rightKey = scopedKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function sameRef(left: AgentRef, right: AgentRef): boolean {
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

function cloneRef(ref: AgentRef): AgentRef {
  return Object.freeze({ environmentId: ref.environmentId, threadId: ref.threadId });
}

function validateRef(ref: AgentRef): void {
  if (
    typeof ref.environmentId !== "string" ||
    ref.environmentId.trim().length === 0 ||
    typeof ref.threadId !== "string" ||
    ref.threadId.trim().length === 0
  ) {
    throw new WorkerOverlayError("overlay_invalid_ref");
  }
}

function cloneIdentity(identity: WorkerOverlayIdentity): WorkerOverlayIdentity {
  if (
    typeof identity.role !== "string" ||
    identity.role.trim().length === 0 ||
    identity.role !== identity.role.trim() ||
    new TextEncoder().encode(identity.role).byteLength > MAX_ROLE_BYTES
  ) {
    throw new WorkerOverlayError("overlay_invalid_role");
  }
  if (identity.parentRef !== null) validateRef(identity.parentRef);
  return Object.freeze({
    role: identity.role,
    parentRef: identity.parentRef === null ? null : cloneRef(identity.parentRef),
  });
}

function policyLimit(value: number | undefined, fallback: number, field: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw new WorkerOverlayError("overlay_invalid_policy", { field });
  }
  return selected;
}

/**
 * Bounded process-local metadata only. This object never reads or writes durable state;
 * callers must separately prove that refs still exist in canonical stock T3.
 */
export function createWorkerOverlay(options: WorkerOverlayOptions = {}) {
  const maxDepth = policyLimit(options.maxDepth, DEFAULT_OVERLAY_MAX_DEPTH, "maxDepth");
  const maxWorkers = policyLimit(
    options.maxWorkers,
    DEFAULT_OVERLAY_MAX_WORKERS,
    "maxWorkers",
  );
  const now = options.now ?? (() => new Date().toISOString());
  const records = new Map<string, StoredRecord>();
  const pending = new Map<symbol, PendingRecord>();
  const terminalRecords = new Set<string>();

  function activeRecordCount(): number {
    let count = 0;
    for (const key of records.keys()) {
      if (!terminalRecords.has(key)) count += 1;
    }
    return count;
  }

  function graph(): Map<GraphKey, string | null> {
    const result = new Map<GraphKey, string | null>();
    for (const [recordKey, record] of records) {
      result.set(recordKey, record.parentRef === null ? null : scopedKey(record.parentRef));
    }
    for (const entry of pending.values()) {
      const entryKey: GraphKey = entry.ref === null ? entry.token : scopedKey(entry.ref);
      result.set(
        entryKey,
        entry.identity.parentRef === null ? null : scopedKey(entry.identity.parentRef),
      );
    }
    return result;
  }

  function depths(): Map<GraphKey, number | null> {
    const parentByKey = graph();
    const result = new Map<GraphKey, number | null>();
    for (const start of parentByKey.keys()) {
      const visited = new Set<GraphKey>([start]);
      let current = start;
      let traversed = 0;
      while (true) {
        const parent = parentByKey.get(current);
        if (parent === null) {
          result.set(start, traversed);
          break;
        }
        if (parent === undefined) {
          result.set(start, null);
          break;
        }
        traversed += 1;
        if (visited.has(parent)) {
          throw new WorkerOverlayError("overlay_cycle");
        }
        if (traversed > maxDepth) {
          throw new WorkerOverlayError("overlay_depth_exceeded", {
            maxDepth,
            observedDepth: traversed,
          });
        }
        visited.add(parent);
        current = parent;
      }
    }
    return result;
  }

  function ensureNoDuplicate(ref: AgentRef, ignoredToken?: symbol): void {
    const candidateKey = scopedKey(ref);
    if (records.has(candidateKey)) {
      throw new WorkerOverlayError("overlay_duplicate", { ref: cloneRef(ref) });
    }
    for (const entry of pending.values()) {
      if (entry.token !== ignoredToken && entry.ref !== null && scopedKey(entry.ref) === candidateKey) {
        throw new WorkerOverlayError("overlay_duplicate", { ref: cloneRef(ref) });
      }
    }
  }

  function validateEnvironment(ref: AgentRef, identity: WorkerOverlayIdentity): void {
    if (
      identity.parentRef !== null &&
      ref.environmentId !== identity.parentRef.environmentId
    ) {
      throw new WorkerOverlayError("overlay_environment_mismatch", {
        childRef: cloneRef(ref),
        parentRef: cloneRef(identity.parentRef),
      });
    }
  }

  function materialize(
    record: StoredRecord,
    depthByKey: Map<GraphKey, number | null> = depths(),
  ): WorkerOverlayRecord {
    const recordDepth = depthByKey.get(scopedKey(record.ref));
    if (recordDepth === undefined) {
      throw new WorkerOverlayError("overlay_unknown", { ref: cloneRef(record.ref) });
    }
    return Object.freeze({
      ref: record.ref,
      role: record.role,
      parentRef: record.parentRef,
      depth: recordDepth,
      creation: record.creation,
    });
  }

  function reserve(
    ref: AgentRef | null,
    requestedIdentity: WorkerOverlayIdentity,
  ): WorkerOverlayReservation {
    if (activeRecordCount() + pending.size >= maxWorkers) {
      throw new WorkerOverlayError("overlay_capacity_exceeded", { maxWorkers });
    }
    if (ref !== null) validateRef(ref);
    const identity = cloneIdentity(requestedIdentity);
    if (ref !== null) {
      ensureNoDuplicate(ref);
      validateEnvironment(ref, identity);
    }

    const token = Symbol("worker-overlay-reservation");
    const plannedRef = ref === null ? null : cloneRef(ref);
    pending.set(token, Object.freeze({ token, ref: plannedRef, identity }));
    try {
      depths();
    } catch (error) {
      pending.delete(token);
      throw error;
    }

    let active = true;
    return Object.freeze({
      commit(actualRef: AgentRef, creation: { readonly source: "spawn" | "attach" }) {
        if (!active || !pending.has(token)) {
          throw new WorkerOverlayError("overlay_reservation_closed");
        }
        validateRef(actualRef);
        if (plannedRef !== null && !sameRef(plannedRef, actualRef)) {
          throw new WorkerOverlayError("overlay_invalid_ref", {
            expectedRef: plannedRef,
            actualRef: cloneRef(actualRef),
          });
        }
        ensureNoDuplicate(actualRef, token);
        validateEnvironment(actualRef, identity);

        pending.delete(token);
        active = false;
        const stored: StoredRecord = Object.freeze({
          ref: cloneRef(actualRef),
          role: identity.role,
          parentRef: identity.parentRef,
          creation: Object.freeze({ source: creation.source, createdAt: now() }),
        });
        const storedKey = scopedKey(stored.ref);
        records.set(storedKey, stored);
        terminalRecords.delete(storedKey);
        try {
          depths();
        } catch (error) {
          records.delete(storedKey);
          terminalRecords.delete(storedKey);
          throw error;
        }
        return materialize(stored);
      },
      release() {
        if (!active) return;
        active = false;
        pending.delete(token);
      },
    });
  }

  return Object.freeze({
    [setTerminalState](ref: AgentRef, terminal: boolean): boolean {
      const key = scopedKey(ref);
      if (!records.has(key)) return false;
      const wasTerminal = terminalRecords.has(key);
      if (terminal) {
        terminalRecords.add(key);
      } else {
        if (wasTerminal && activeRecordCount() >= maxWorkers) {
          throw new WorkerOverlayError("overlay_capacity_exceeded", { maxWorkers });
        }
        terminalRecords.delete(key);
      }
      return wasTerminal;
    },
    reserve,
    attach(ref: AgentRef, identity: WorkerOverlayIdentity): WorkerOverlayRecord {
      const reservation = reserve(ref, identity);
      try {
        return reservation.commit(ref, { source: "attach" });
      } catch (error) {
        reservation.release();
        throw error;
      }
    },
    getWorker(ref: AgentRef): WorkerOverlayRecord {
      validateRef(ref);
      const record = records.get(scopedKey(ref));
      if (record === undefined) {
        throw new WorkerOverlayError("overlay_unknown", { ref: cloneRef(ref) });
      }
      return materialize(record);
    },
    listChildren(parentRef: AgentRef): readonly WorkerOverlayRecord[] {
      validateRef(parentRef);
      const parentKey = scopedKey(parentRef);
      const children = [...records.values()]
        .filter(
          (record) => record.parentRef !== null && scopedKey(record.parentRef) === parentKey,
        )
        .sort((left, right) => compareScopedKeys(left.ref, right.ref));
      if (children.length === 0 && !records.has(parentKey)) {
        throw new WorkerOverlayError("overlay_unknown", { ref: cloneRef(parentRef) });
      }
      const depthByKey = depths();
      return Object.freeze(children.map((record) => materialize(record, depthByKey)));
    },
    listWorkers(): readonly WorkerOverlayRecord[] {
      const depthByKey = depths();
      return Object.freeze(
        [...records.values()]
          .sort((left, right) => compareScopedKeys(left.ref, right.ref))
          .map((record) => materialize(record, depthByKey)),
      );
    },
  });
}

export type WorkerOverlay = ReturnType<typeof createWorkerOverlay>;

export function recordWorkerTerminalState(
  overlay: WorkerOverlay,
  ref: AgentRef,
  terminal: boolean,
): boolean {
  return overlay[setTerminalState](ref, terminal);
}
