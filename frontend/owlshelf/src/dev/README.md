# Dev sync panel

The sync engine (`src/lib/sync.ts`) is complete and covered by the harness. The
app now starts it on boot (`src/lib/syncRuntime.ts`, plan §7.1), so a normal
page load connects every room without this panel.

This panel is the **diagnostic** surface: it shows the envelope log, the
outbox, the cursors, and the close code, and it lets you drive one room by hand
(catch-up, audit, suspend/resume, blob request). It is not the pairing UI (that
is step 6).

Two things it does that the app does not:

- It runs **one** engine at a time, for the room you select. The app runs one
  per room. Switching the dropdown while connected rebinds the socket.
- It persists the relay URL onto the room when you connect. The app passes the
  default to the engine instead and leaves the room's `relayUrl` alone, so
  step 6's pairing is the only thing that writes it.

## 1. Start the relay

`ALLOWED_ORIGINS` is **required** and fails closed — an empty allowlist refuses
every connection rather than allowing every connection.

```bash
cd backend
ALLOWED_ORIGINS="http://localhost:4173,http://127.0.0.1:4173" \
  .venv/bin/python main.py
```

It binds `127.0.0.1:8000`, route `/ws`. Both origins are listed because the
two-device setup below uses both.

## 2. Serve the app

```bash
cd frontend/owlshelf
npm run build && npm run preview     # http://localhost:4173
```

`npm run dev` works too, but then add `http://localhost:5173` to
`ALLOWED_ORIGINS`.

## 3. Open the panel

Append `?sync=1` to the URL:

```
http://localhost:4173/?sync=1
```

The gate is a query parameter, not `import.meta.env.DEV`, because `vite preview`
serves a **production** build — a dev-only gate would hide the panel exactly
where the relay and the PWA are actually exercised.

A `sync` button appears bottom-right. Click it.

## 4. Connect

1. Pick a room. There is one per profile, and `createProfile` writes the room
   and the profile in one transaction — so if the list is empty, create a
   profile in the app and the panel picks it up on its own (the list is a
   `liveQuery`, not a one-shot read).
2. The relay URL defaults to `ws://localhost:8000/ws`. Leave it.
3. Click **connect**.

**One socket, one room.** A socket is room-bound: `hello` names one `roomId`
and every envelope is sealed with that room's key. The panel runs exactly one
engine, so switching the room dropdown while connected stops the old engine and
starts a new one on the new room — you do not need to disconnect first. The
counters always describe the room the socket is actually in.

The dropdown lists raw room ids, not profile names — a room id IS its profile
id, so match it against the profile you mean. Selecting a room is enough to
tell them apart: `OPS` and `OUTBOX` are per room.

The status dot goes `connecting` → `syncing` → `synced`. If it stays `offline`,
the relay refused you: check `ALLOWED_ORIGINS` matches the page's origin
exactly, including the port.

**The app connects on its own.** `src/lib/syncRuntime.ts` starts one engine per
room at boot, so you do not need this panel to see sync happen — open the app
normally and the sockets are already there. The relay it dials is
`DEFAULT_RELAY_URL` in `src/lib/sync.ts`: `VITE_RELAY_URL` if set, otherwise
`ws://localhost:8000/ws`. A room that has its own `relayUrl` (written by
pairing, step 6) always wins over that default.

If the panel and the app are both open on the same origin they are the same
device and the same rooms, so you will see **two** connections per room in the
relay log. That is expected; close the panel to get back to one.

## 5. Two devices

**Two tabs on the same origin are one device.** They share one IndexedDB, so
they share one `deviceId` and one `authorSeq` space. Syncing them tests nothing
and can produce a fork.

Use two origins instead — `localhost` and `127.0.0.1` are different origins with
separate storage:

```
http://localhost:4173/?sync=1
http://127.0.0.1:4173/?sync=1
```

Each gets its own `deviceId`. Connect both to the same room.

**A fresh origin has no profile**, so it has no room either. Create one there
first — the panel will pick it up without a reload.

## 5b. Share the room (dev only)

A room created on one origin has its own `roomKey`, so the other origin cannot
decrypt its envelopes. Real pairing is step 6. Until then the panel can copy the
room across by hand:

1. On the **source** origin, select the room and click **export**. The payload
   appears in the textarea; **copy** puts it on the clipboard.
2. On the **target** origin, paste it into the same textarea and click
   **import**.

The target now holds the same `roomId`, `roomKey`, `keyGen`, and `relayUrl`, with
an empty `cursorIn` (a join is a full catch-up) and its own `nextAuthorSeq`
starting at 1. It appears in the room list immediately.

Now both devices can decrypt each other, and **op convergence is testable**:
create an item on one, watch it appear on the other.

> The payload contains the room key in the clear — as the real QR fragment does.
> Treat it as a secret.
>
> This is **not** §6.7 pairing. There is no roster anchor, no owner signature,
> no revocation, and no rotation. It exists so sync can be tested before step 6
> lands, and it should be deleted when step 6 does.

## 6. What to click

| To verify | Do this | Expect |
|---|---|---|
| Presence | connect both | `members` lists both connectionIds |
| Heartbeat | leave it 60 s | status stays `synced`, no reconnect |
| Catch-up | **catch-up** | log shows `catchup-request`, then `catchup-reply` chunks |
| Push | create an item | within ~5 s the other device shows it; `outbox.pending` drops once acked |
| Drain now | **drain** | log shows `drain N sent` immediately |
| Audit | **audit** | log shows `audit` out and in; `peerCursors` fills |
| Ack rule | create an item, then **refresh** | `outbox.pending` drops as the peer's cursor covers it |
| Suspend | **suspend** | socket closes `1001`; **resume** reconnects and asks for catch-up |
| Blob | **get** with a hash | `blob-request` out; `{seq: -1}` if nobody holds it |
| Media | add an item with a photo on A, then open it on B | B's card shows the photo within a second or two, no reload |
| Reconnect | stop the relay | status `offline`, `last close` names the code, then backoff retries |

The envelope log is the point: a catch-up is *observable* here instead of being
inferred from the database afterwards.

### Media is pulled on demand, not replicated

A blob is fetched when something tries to **render** it and the bytes are
absent — not when the row syncs. A room with 500 covers must not pull 500 blobs
onto a phone that will show twelve.

So the sequence on B is: the item row arrives with `imageUrl: "idb://<hash>"`,
`useMediaSrc` reads `files`, finds nothing, returns `missing`, and publishes a
demand. The panel answers it with `blob-request`, A serves `file-chunk`, B
verifies `sha256(bytes) === hash` **before** writing, and `onBlob` invalidates
the media cache so the mounted card re-reads and paints.

Two things that look like bugs and are not:

- **`missing` is retried once a minute per `(roomId, hash)`.** A blob nobody
  holds stays missing; the cooldown is what stops a scrolling list from
  becoming a request storm.
- **A demand outside `?sync=1` does nothing.** The engine only exists when the
  panel is open, so media sync is a panel feature until step 5 wires sync into
  the app path. That is not a media bug.

If B shows a broken image and the log has no `blob-request`, the demand never
fired — check that the panel is connected on **both** origins. If the log shows
`blob-request` out and `{seq: -1}` back, A does not hold the bytes: the item was
created with a `data:` or `https:` URL, or A's `files` row was GC'd.

**If it says `offline`, read `last close`.** It names the cause: `1006` is a
relay that is not running, `4401` is an origin missing from `ALLOWED_ORIGINS`,
`4403` is a full room, `4404` is a generation mismatch. `offline` alone is the
same word for all four.

The relay console says the same thing from its side: `admitted conn=… room=…`
or `refused <code>: <reason>`. **Do not read uvicorn's `WebSocket /ws
[accepted]` as success** — it prints on the HTTP upgrade, before admission
runs, so a refused connection still shows it. If the panel says `offline` and
the console says `[accepted]` with no `admitted` line, you were refused.

## Limits

- **No §6.7 pairing.** Export/import is a dev stopgap: no roster anchor, no
  owner signature, no revocation, no rotation. The real thing is step 6.
- **The roster completes itself on contact.** Import writes the joiner into its
  own roster and cannot reach back to the owner's, so the owner would ack every
  op on creation and never announce anything. `recordPeerCursors` therefore
  adds an unknown device to the roster when a sealed body names it. That is a
  stopgap and it must be deleted at step 6 — a device that can write itself
  into the roster defeats revocation.
- **One browser engine.** Gate G wants a matrix; this is Firefox and Chromium
  158 today. WebKit is unverified.
- **The panel is dev-only.** Nothing imports it unless `?sync=1` is present, so
  it is tree-shaken out of a normal load — but it *is* in the production bundle
  when the flag is set, which is deliberate.

## Where the writes go

Since §5.5, a tab does not write. `hooks.ts` posts commands to the worker
(`src/lib/worker/`), which is the only writer. The panel is unaffected — it
reads through Dexie and drives the engine, and the engine is still in the tab.

Two consequences worth knowing when you debug:

- **The worker is a separate bundle.** `vite build` emits it as its own chunk
  (`dist/assets/entry-*.js`). A change to `cmd.ts` or `reduce.ts` lands in that
  chunk, so a stale service worker can serve you an old writer while the tab
  runs a new reader. Hard-reload when a write behaves like the old code.
- **`SharedWorker` is the fast path.** Firefox and Chromium have it; Safari does
  not, so Safari takes the Web Locks rung — one tab is the leader and owns the
  writer, the others relay to it over a `BroadcastChannel`. If the leader tab
  closes, the followers are not promoted until reload. That is a known gap, not
  a bug you are chasing.
