import { AflVmError } from "./errors.js";
import { workspacePathOverlap } from "./workspace.js";

type Release = () => void;

interface SemaphoreWaiter {
  readonly resolve: (release: Release) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

export class Semaphore {
  private active = 0;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new TypeError("semaphore limit must be a positive integer");
    }
  }

  async use<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  acquire(signal: AbortSignal): Promise<Release> {
    throwIfAborted(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortReason(signal));
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private createRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) return;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }
}

interface LockWaiter {
  readonly mode: "read" | "write";
  readonly resolve: (release: Release) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

interface LockState {
  readers: number;
  writer: boolean;
  readonly queue: LockWaiter[];
}

export interface ResourceRequest {
  readonly key: string;
  readonly mode: "read" | "write";
}

export class ResourceLocks {
  private readonly states = new Map<string, LockState>();

  async use<T>(
    requests: readonly ResourceRequest[],
    signal: AbortSignal,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const normalized = normalizeRequests(requests);
    const releases: Release[] = [];
    try {
      for (const request of normalized) {
        releases.push(await this.acquire(request.key, request.mode, signal));
      }
      return await operation();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  private acquire(key: string, mode: "read" | "write", signal: AbortSignal): Promise<Release> {
    throwIfAborted(signal);
    const state = this.states.get(key) ?? { readers: 0, writer: false, queue: [] };
    this.states.set(key, state);
    if (canAcquireImmediately(state, mode)) {
      activate(state, mode);
      return Promise.resolve(this.createRelease(key, state, mode));
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter: LockWaiter = {
        mode,
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = state.queue.indexOf(waiter);
          if (index >= 0) state.queue.splice(index, 1);
          reject(abortReason(signal));
          this.cleanup(key, state);
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      state.queue.push(waiter);
    });
  }

  private createRelease(key: string, state: LockState, mode: "read" | "write"): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (mode === "read") state.readers -= 1;
      else state.writer = false;
      this.drain(key, state);
    };
  }

  private drain(key: string, state: LockState): void {
    if (state.writer || state.readers > 0) return;
    while (state.queue.length > 0) {
      const first = state.queue[0]!;
      if (first.signal.aborted) {
        state.queue.shift();
        first.signal.removeEventListener("abort", first.onAbort);
        first.reject(abortReason(first.signal));
        continue;
      }
      if (first.mode === "write") {
        state.queue.shift();
        first.signal.removeEventListener("abort", first.onAbort);
        state.writer = true;
        first.resolve(this.createRelease(key, state, "write"));
        return;
      }
      while (state.queue[0]?.mode === "read") {
        const reader = state.queue.shift()!;
        reader.signal.removeEventListener("abort", reader.onAbort);
        if (reader.signal.aborted) {
          reader.reject(abortReason(reader.signal));
          continue;
        }
        state.readers += 1;
        reader.resolve(this.createRelease(key, state, "read"));
      }
      return;
    }
    this.cleanup(key, state);
  }

  private cleanup(key: string, state: LockState): void {
    if (!state.writer && state.readers === 0 && state.queue.length === 0) {
      this.states.delete(key);
    }
  }
}

export interface WorkspaceRequest {
  readonly path: string;
  readonly mode: "read" | "write";
}

interface WorkspaceLease {
  readonly id: number;
  readonly requests: readonly WorkspaceRequest[];
}

interface WorkspaceWaiter {
  readonly requests: readonly WorkspaceRequest[];
  readonly resolve: (release: Release) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

export class WorkspaceLocks {
  private readonly active: WorkspaceLease[] = [];
  private readonly waiters: WorkspaceWaiter[] = [];
  private nextId = 0;

  async use<T>(
    requests: readonly WorkspaceRequest[],
    signal: AbortSignal,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const release = await this.acquire(requests, signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  acquire(requests: readonly WorkspaceRequest[], signal: AbortSignal): Promise<Release> {
    throwIfAborted(signal);
    const normalized = normalizeWorkspaceRequests(requests);
    if (this.waiters.length === 0 && this.canActivate(normalized)) {
      return Promise.resolve(this.activate(normalized));
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter: WorkspaceWaiter = {
        requests: normalized,
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortReason(signal));
          this.drainWorkspaceWaiters();
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private canActivate(requests: readonly WorkspaceRequest[]): boolean {
    return this.active.every((lease) => !workspaceRequestsConflict(lease.requests, requests));
  }

  private activate(requests: readonly WorkspaceRequest[]): Release {
    this.nextId += 1;
    const lease: WorkspaceLease = { id: this.nextId, requests };
    this.active.push(lease);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const index = this.active.findIndex((item) => item.id === lease.id);
      if (index >= 0) this.active.splice(index, 1);
      this.drainWorkspaceWaiters();
    };
  }

  private drainWorkspaceWaiters(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]!;
      if (waiter.signal.aborted) {
        this.waiters.shift();
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      if (!this.canActivate(waiter.requests)) return;
      this.waiters.shift();
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(this.activate(waiter.requests));
    }
  }
}

export interface LinkedController {
  readonly controller: AbortController;
  dispose(): void;
}

export function linkedController(parent?: AbortSignal): LinkedController {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted === true) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    dispose: () => parent?.removeEventListener("abort", onAbort),
  };
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new AflVmError("RUN_ABORTED", "AFL run was aborted");
}

function canAcquireImmediately(state: LockState, mode: "read" | "write"): boolean {
  if (state.writer || state.queue.length > 0) return false;
  return mode === "read" || state.readers === 0;
}

function activate(state: LockState, mode: "read" | "write"): void {
  if (mode === "read") state.readers += 1;
  else state.writer = true;
}

function normalizeRequests(requests: readonly ResourceRequest[]): ResourceRequest[] {
  const modes = new Map<string, "read" | "write">();
  for (const request of requests) {
    const previous = modes.get(request.key);
    modes.set(request.key, previous === "write" || request.mode === "write" ? "write" : "read");
  }
  return [...modes].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, mode]) => ({ key, mode }));
}

function normalizeWorkspaceRequests(requests: readonly WorkspaceRequest[]): WorkspaceRequest[] {
  const modes = new Map<string, "read" | "write">();
  for (const request of requests) {
    const previous = modes.get(request.path);
    modes.set(request.path, previous === "write" || request.mode === "write" ? "write" : "read");
  }
  return [...modes].sort(([left], [right]) => left.localeCompare(right))
    .map(([path, mode]) => ({ path, mode }));
}

function workspaceRequestsConflict(
  left: readonly WorkspaceRequest[],
  right: readonly WorkspaceRequest[],
): boolean {
  return left.some((leftRequest) => right.some((rightRequest) =>
    workspacePathOverlap(leftRequest.path, rightRequest.path) &&
    (leftRequest.mode === "write" || rightRequest.mode === "write")));
}
