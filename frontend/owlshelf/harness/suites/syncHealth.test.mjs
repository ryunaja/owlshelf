/**
 * syncHealth.test.mjs — the badge's store, and the retry behind it (§6.6).
 *
 * The store is where "silently failing" actually ends: `sync-status` already
 * carried every transition, but only the dev panel listened. Two properties
 * matter and both are cheap to get wrong:
 *
 *  1. **Stable snapshots.** `useSyncExternalStore` re-renders forever if
 *     `getSnapshot` returns a new object each call, so identity is asserted.
 *  2. **A cold tab still learns.** An event that fired before the tab mounted
 *     is gone, so `refresh()` asks the worker once — and a failure the room has
 *     already recovered from is cleared by the worker on `synced`, not here.
 */

import { createSyncHealthStore } from "../../src/lib/syncHealth.ts";
import { assert, assertDeepEqual, assertEqual } from "../lib/assert.mjs";

const ROOM = "room-a";

/** A worker client with just the three methods the store uses. */
function fakeClient(overrides = {}) {
  const calls = { roomInfo: 0, syncRetry: 0 };
  let emit = () => {};
  const client = {
    calls,
    roomInfo: async (roomId) => {
      calls.roomInfo += 1;
      return {
        roomId,
        deviceId: "dev-a",
        isOwner: true,
        keyGen: 1,
        rotationPending: null,
        pendingRelayUrl: null,
        status: "synced",
        peers: ["c1"],
        ops: 3,
        running: true,
        lastClose: null,
        ...overrides,
      };
    },
    syncRetry: async () => {
      calls.syncRetry += 1;
    },
    onEvent: (handler) => {
      emit = handler;
      return () => {
        emit = () => {};
      };
    },
    push: (event) => emit(event),
  };
  return client;
}

export default {
  name: "syncHealth — the app-wide badge state and its retry (§6.6)",
  tests: [
    {
      name: "an unknown room reports 'not connected yet' with a stable reference",
      async run() {
        const store = createSyncHealthStore({ getClient: async () => fakeClient() });
        try {
          const first = store.get(ROOM);
          const second = store.get(ROOM);
          assert(first === second, "the same object, or React re-renders forever");
          assertEqual(first.tone, "busy", "not an error before anything is known");
          assertEqual(first.label, "Not connected yet", "label");
        } finally {
          store.dispose();
        }
      },
    },
    {
      name: "refresh seeds the badge from the worker, cold tab included",
      async run() {
        const client = fakeClient();
        const store = createSyncHealthStore({ getClient: async () => client });
        try {
          await store.refresh(ROOM);
          const snapshot = store.get(ROOM);
          assertEqual(snapshot.tone, "ok", "synced");
          assertEqual(snapshot.status, "synced", "status carried");
          assertDeepEqual(snapshot.peers, ["c1"], "peers carried");
          assertEqual(client.calls.roomInfo, 1, "asked once");
        } finally {
          store.dispose();
        }
      },
    },
    {
      name: "a sync-status event updates the badge and notifies once",
      async run() {
        const client = fakeClient();
        const store = createSyncHealthStore({ getClient: async () => client });
        let notified = 0;
        try {
          const unsubscribe = store.subscribe(() => (notified += 1));
          await store.refresh(ROOM);
          const before = notified;

          client.push({
            kind: "sync-status",
            roomId: ROOM,
            status: "offline",
            lastClose: { code: 1006, reason: "" },
          });

          const snapshot = store.get(ROOM);
          assertEqual(snapshot.tone, "error", "tone");
          assertEqual(snapshot.trouble?.code, 1006, "the code arrives with the event");
          assert(snapshot.detail.includes("1006"), "and is visible in the detail");
          assertEqual(notified, before + 1, "one notification for one transition");
          unsubscribe();
          assertEqual(store.listenerCount(), 0, "unsubscribed");
        } finally {
          store.dispose();
        }
      },
    },
    {
      name: "a synced session clears the remembered failure",
      async run() {
        const client = fakeClient();
        const store = createSyncHealthStore({ getClient: async () => client });
        try {
          store.subscribe(() => {});
          await store.refresh(ROOM);
          client.push({
            kind: "sync-status",
            roomId: ROOM,
            status: "offline",
            lastClose: { code: 1006, reason: "" },
          });
          assertEqual(store.get(ROOM).tone, "error", "failed");

          // The worker clears `lastClose` on a successful session and says so.
          client.push({ kind: "sync-status", roomId: ROOM, status: "synced", lastClose: null });
          const snapshot = store.get(ROOM);
          assertEqual(snapshot.tone, "ok", "recovered");
          assertEqual(snapshot.trouble, null, "no stale code");
        } finally {
          store.dispose();
        }
      },
    },
    {
      name: "an event for another room does not touch this one",
      async run() {
        const client = fakeClient();
        const store = createSyncHealthStore({ getClient: async () => client });
        try {
          store.subscribe(() => {});
          await store.refresh(ROOM);
          client.push({
            kind: "sync-status",
            roomId: "room-b",
            status: "offline",
            lastClose: { code: 1013, reason: "" },
          });
          assertEqual(store.get(ROOM).tone, "ok", "still ok");
          assertEqual(store.get("room-b").trouble?.code, 1013, "and B knows");
        } finally {
          store.dispose();
        }
      },
    },
    {
      name: "retry asks the worker to dial and then re-reads the state",
      async run() {
        const client = fakeClient();
        const store = createSyncHealthStore({ getClient: async () => client });
        try {
          await store.refresh(ROOM);
          await store.retry(ROOM);
          assertEqual(client.calls.syncRetry, 1, "resume asked for");
          assertEqual(client.calls.roomInfo, 2, "state re-read after the retry");
        } finally {
          store.dispose();
        }
      },
    },
    {
      name: "a failing refresh keeps the last known state instead of inventing one",
      async run() {
        const client = fakeClient();
        let fail = false;
        const store = createSyncHealthStore({
          getClient: async () => ({
            ...client,
            roomInfo: async (roomId) => {
              if (fail) throw new Error("worker closed");
              return client.roomInfo(roomId);
            },
          }),
        });
        try {
          await store.refresh(ROOM);
          const before = store.get(ROOM);
          fail = true;
          await store.refresh(ROOM);
          const after = store.get(ROOM);
          assertEqual(after.tone, before.tone, "tone unchanged");
          assertEqual(after.detail, before.detail, "detail unchanged");
        } finally {
          store.dispose();
        }
      },
    },
  ],
};
