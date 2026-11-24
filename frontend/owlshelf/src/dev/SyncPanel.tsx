/**
 * SyncPanel.tsx — the dev surface for driving the sync engine (plan §13).
 *
 * Mounted only when the URL carries `?sync=1` (see `App.tsx`). It is NOT gated
 * on `import.meta.env.DEV` on purpose: `vite preview` serves a production
 * build, and that is where the PWA and the relay are actually exercised, so a
 * dev-only gate would make the panel disappear exactly when it is needed.
 *
 * What it gives you that nothing else does:
 *
 *  - a relay URL field, because every room ships `relayUrl: null` and
 *    `connect()` returns early on a null URL — the engine can never start
 *    without this;
 *  - the engine's lifetime, because `SyncEngine` has no other call site;
 *  - the operations the engine already implements (catch-up, audit,
 *    suspend/resume, blob request) as buttons;
 *  - a live envelope log, so a catch-up is observable instead of inferred
 *    from the database afterwards.
 *
 * Two tabs on the SAME origin share one IndexedDB, therefore one `deviceId`,
 * therefore one `authorSeq` space — they are one device, not two, and syncing
 * them tests nothing. To get two devices, use two origins: `localhost:4173`
 * and `127.0.0.1:4173` are different origins with separate storage.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { syncStore, DEFAULT_RELAY_URL } from "./syncStore";

const STATUS_COLOR: Record<string, string> = {
  offline: "#9ca3af",
  connecting: "#f59e0b",
  syncing: "#3b82f6",
  synced: "#10b981",
  attention: "#ef4444",
};

const label: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "#9ca3af",
  marginBottom: 2,
};

const value: React.CSSProperties = {
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#e5e7eb",
  wordBreak: "break-all",
};

const button: React.CSSProperties = {
  fontSize: 11,
  padding: "4px 8px",
  borderRadius: 4,
  border: "1px solid #374151",
  background: "#1f2937",
  color: "#e5e7eb",
  cursor: "pointer",
};

const input: React.CSSProperties = {
  fontSize: 11,
  padding: "4px 6px",
  borderRadius: 4,
  border: "1px solid #374151",
  background: "#111827",
  color: "#e5e7eb",
  width: "100%",
  boxSizing: "border-box",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={label}>{name}</div>
      <div style={value}>{children}</div>
    </div>
  );
}

export function SyncPanel() {
  const snap = useSyncExternalStore(
    syncStore.subscribe,
    syncStore.getSnapshot,
    syncStore.getSnapshot,
  );
  const [open, setOpen] = useState(false);
  const [hash, setHash] = useState("");
  const [shareText, setShareText] = useState("");

  // Keep the room list live. A one-shot load is wrong on first use: the panel
  // mounts before any profile exists, and the profile the user creates a
  // moment later must appear without a manual reload.
  useEffect(() => syncStore.watchRooms(), []);

  // The engine lives in the worker now, so its live state is a `dev-state`
  // request rather than a set of getters. One poll covers both the durable
  // counters and the engine's status.
  useEffect(() => syncStore.startPolling(1000), []);

  const dot = STATUS_COLOR[snap.status] ?? "#9ca3af";

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          position: "fixed",
          right: 12,
          bottom: 12,
          zIndex: 10000,
          ...button,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        title="Open the dev sync panel"
      >
        <span
          style={{ width: 8, height: 8, borderRadius: 4, background: dot, display: "inline-block" }}
        />
        sync
      </button>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: 10000,
        width: 340,
        maxHeight: "80vh",
        overflowY: "auto",
        background: "#0b1220",
        border: "1px solid #374151",
        borderRadius: 8,
        padding: 12,
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        color: "#e5e7eb",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
          <span
            style={{ width: 8, height: 8, borderRadius: 4, background: dot, display: "inline-block" }}
          />
          sync · {snap.status}
        </div>
        <button onClick={() => setOpen(false)} style={button}>
          hide
        </button>
      </div>

      {snap.error && (
        <div
          style={{
            background: "#7f1d1d",
            color: "#fecaca",
            fontSize: 11,
            padding: "6px 8px",
            borderRadius: 4,
            marginBottom: 10,
          }}
        >
          {snap.error}
        </div>
      )}

      {/* ── Connection ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 10 }}>
        <div style={label}>room</div>
        <select
          value={snap.roomId ?? ""}
          onChange={(e) => void syncStore.selectRoom(e.target.value)}
          style={{ ...input, marginBottom: 6 }}
        >
          {snap.rooms.length === 0 && <option value="">(no rooms)</option>}
          {snap.rooms.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>

        <div style={label}>relay url</div>
        <input
          value={snap.relayUrl}
          placeholder={DEFAULT_RELAY_URL}
          onChange={(e) => void syncStore.setRelayUrl(e.target.value)}
          style={{ ...input, marginBottom: 6 }}
        />

        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => void syncStore.connect()}
            disabled={snap.running}
            style={{ ...button, opacity: snap.running ? 0.4 : 1 }}
          >
            connect
          </button>
          <button
            onClick={() => void syncStore.disconnect()}
            disabled={!snap.running}
            style={{ ...button, opacity: snap.running ? 1 : 0.4 }}
          >
            disconnect
          </button>
          <button onClick={() => void syncStore.loadRooms()} style={button}>
            reload
          </button>
        </div>
      </div>

      {/* ── Share (dev only) ───────────────────────────────────────────── */}
      <div style={{ borderTop: "1px solid #1f2937", paddingTop: 8, marginBottom: 10 }}>
        <div style={label}>share this room (dev only)</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <button
            onClick={() => {
              void syncStore.exportRoom().then((text) => {
                if (text) setShareText(text);
              });
            }}
            style={button}
          >
            export
          </button>
          <button
            onClick={() => void navigator.clipboard?.writeText(shareText)}
            disabled={shareText === ""}
            style={{ ...button, opacity: shareText === "" ? 0.4 : 1 }}
          >
            copy
          </button>
          <button
            onClick={() => {
              void syncStore.importRoom(shareText);
              setShareText("");
            }}
            disabled={shareText.trim() === ""}
            style={{ ...button, opacity: shareText.trim() === "" ? 0.4 : 1 }}
          >
            import
          </button>
        </div>
        <textarea
          value={shareText}
          onChange={(e) => setShareText(e.target.value)}
          placeholder="export here, or paste an exported room to join it"
          rows={3}
          style={{ ...input, resize: "vertical" }}
        />
        <div style={{ fontSize: 10, color: "#6b7280", marginTop: 4 }}>
          Contains the room key in the clear. Not §6.7 pairing — no roster
          anchor, no signatures, no revocation.
        </div>
      </div>

      {/* ── State ──────────────────────────────────────────────────────── */}
      <div style={{ borderTop: "1px solid #1f2937", paddingTop: 8, marginBottom: 10 }}>
        <Row name="device">{snap.deviceId ?? "—"}</Row>
        <Row name="conn">{snap.connId ?? "—"}</Row>
        <Row name="last close">
          {snap.lastClose
            ? `${snap.lastClose.code}${snap.lastClose.reason ? ` ${snap.lastClose.reason}` : ""}`
            : "—"}
        </Row>
        <Row name="members">{snap.members.length === 0 ? "—" : snap.members.join(", ")}</Row>
        <Row name="ops">{snap.ops}</Row>
        <Row name="outbox">
          pending {snap.outbox.pending} · acked {snap.outbox.acked} · dead {snap.outbox.dead}
        </Row>
        <Row name="cursorIn">
          {Object.keys(snap.cursorIn).length === 0
            ? "—"
            : Object.entries(snap.cursorIn)
                .map(([k, v]) => `${k.slice(0, 8)}=${v}`)
                .join(" ")}
        </Row>
        <Row name="peerCursors">
          {Object.keys(snap.peerCursors).length === 0
            ? "—"
            : Object.entries(snap.peerCursors)
                .map(
                  ([peer, cursors]) =>
                    `${peer.slice(0, 8)}:${Object.entries(cursors)
                      .map(([a, s]) => `${a.slice(0, 4)}=${s}`)
                      .join(",")}`,
                )
                .join(" ")}
        </Row>
      </div>

      {/* ── Actions ────────────────────────────────────────────────────── */}
      <div style={{ borderTop: "1px solid #1f2937", paddingTop: 8, marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
          <button onClick={() => void syncStore.catchup()} style={button}>
            catch-up
          </button>
          <button onClick={() => void syncStore.drain()} style={button}>
            drain
          </button>
          <button onClick={() => void syncStore.audit()} style={button}>
            audit
          </button>
          <button onClick={() => void syncStore.suspend()} style={button}>
            suspend
          </button>
          <button onClick={() => void syncStore.resume()} style={button}>
            resume
          </button>
          <button onClick={() => void syncStore.refresh()} style={button}>
            refresh
          </button>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={hash}
            placeholder="blob hash"
            onChange={(e) => setHash(e.target.value)}
            style={input}
          />
          <button
            onClick={() => {
              void syncStore.requestBlob(hash.trim());
              setHash("");
            }}
            disabled={hash.trim() === ""}
            style={{ ...button, opacity: hash.trim() === "" ? 0.4 : 1 }}
          >
            get
          </button>
        </div>
      </div>

      {/* ── Log ────────────────────────────────────────────────────────── */}
      <div style={{ borderTop: "1px solid #1f2937", paddingTop: 8 }}>
        <div style={label}>envelopes ({snap.log.length})</div>
        <div
          style={{
            maxHeight: 200,
            overflowY: "auto",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 10,
            lineHeight: 1.5,
          }}
        >
          {snap.log.length === 0 && <div style={{ color: "#6b7280" }}>nothing yet</div>}
          {snap.log.map((entry, i) => (
            <div key={`${entry.at}-${i}`} style={{ color: "#9ca3af" }}>
              <span style={{ color: "#6b7280" }}>
                {new Date(entry.at).toLocaleTimeString()}{" "}
              </span>
              <span style={{ color: "#93c5fd" }}>{entry.kind}</span>
              {entry.from && <span style={{ color: "#6b7280" }}> ←{entry.from.slice(0, 6)}</span>}
              <span> {entry.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
