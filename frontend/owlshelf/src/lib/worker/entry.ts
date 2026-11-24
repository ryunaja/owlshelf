/**
 * entry.ts — the worker entry point (plan §5).
 *
 * Loaded two ways, so it handles both:
 *
 *  - `new SharedWorker(url, { type: "module" })` — the preferred path. One
 *    instance per origin, every tab connects a port, `onconnect` fires per tab.
 *  - `new Worker(url, { type: "module" })` — the fallback when SharedWorker is
 *    missing. One instance per tab, `onmessage` on the global scope.
 *
 * The worker holds no state of its own. Clock, sequences, cursors and the
 * outbox all live in Dexie, so a worker restart (idle timeout, crash, browser
 * eviction) is a non-event: the next request re-reads everything it needs.
 * That is the whole reason this file is this short.
 *
 * `lib` is `["ES2023", "DOM"]`, not `WebWorker` — adding the worker lib would
 * collide with DOM's `self`/`addEventListener` declarations for every other
 * file in the project. So the worker global is described narrowly here.
 */

import { db, getDeviceId } from "../db";
import { createWorkerHost, type PortLike } from "./host";
import type { WorkerRequest } from "./protocol";

/** The slice of `SharedWorkerGlobalScope` / `DedicatedWorkerGlobalScope` used. */
interface WorkerGlobalLike {
  onconnect: ((event: { ports: MessagePort[] }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

/** Adapt a `MessagePort` to the host's two-method seam. */
function portLike(port: MessagePort): PortLike {
  return {
    post: (message) => port.postMessage(message),
    onMessage: (handler) => {
      port.onmessage = (event) => handler(event.data);
      // `start()` is a no-op on a port already started by `onmessage`, and
      // required on one that is not. Calling it is always safe.
      port.start();
    },
  };
}

const host = createWorkerHost({ db, getDeviceId });
const scope = self as unknown as WorkerGlobalLike;

// SharedWorker: one port per tab, each tab gets its own handler.
scope.onconnect = (event) => {
  for (const port of event.ports) host.attach(portLike(port));
};

// Dedicated Worker: a single implicit port on the global scope.
scope.onmessage = (event) => {
  const request = event.data as WorkerRequest;
  if (typeof request?.id !== "number") return;
  void host.handle(request).then((reply) => scope.postMessage(reply));
};
