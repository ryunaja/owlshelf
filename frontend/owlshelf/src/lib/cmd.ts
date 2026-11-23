/**
 * cmd.ts — the command path: one writer, one transaction (plan §6.3).
 * WORKER ONLY.
 *
 * Tabs never write row tables. They post semantic commands here and await a
 * commit ack. Every command is ONE read-write transaction over the row
 * tables, ops, outbox, pending, and meta, in this order:
 *
 *   1. load the target room INSIDE the tx (a read outside the serialized
 *      section lets two engines both read seq 5 and mint it — review-2 P0-9)
 *   2. load the clock in the same tx
 *   3. mint the op: fresh UUID, `authorSeq` from the room's persisted counter,
 *      HLC from the clock
 *   4. reduce it through the SAME reducer as remote ops
 *   5. write the durable outbox entry
 *   6. save the room and clock, commit, then wake the socket
 *
 * The ack is gated on the transaction COMMITTING, never on request success:
 * the repo's old `dbPut` idiom awaited `onsuccess`, which fires before the
 * commit, so an aborted transaction still reported success while the row was
 * absent (audit-4 R4-P1-6, executed). Dexie's transaction promise resolves on
 * `oncomplete`, which is exactly the gate this needs.
 */

import type { OwlshelfDB } from "./db";
import { HlcOverflowError, mintHlc } from "./hlc";
import { normalizePutPayload, normalizeResolvePayload } from "./payload";
import { readRoom, writeRoom } from "./roomMeta";
import { reduceOp } from "./reduce";
import { META_KEYS, type OutboxEntry, type RowOp, type RowTable } from "./stores";

// ─── Errors (plan §15.13) ──────────────────────────────────────────────────

export type CommandErrorCode =
  | "quota"
  | "constraint"
  | "validation"
  | "offline"
  | "timeout"
  | "internal";

export class CommandError extends Error {
  code: CommandErrorCode;

  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

// ─── Command surface ───────────────────────────────────────────────────────

interface CommandBase {
  /** UUID minted by the tab. A retry with a known cmdId returns the ORIGINAL
   *  ack instead of minting a second op (§15.5). */
  cmdId: string;
  roomId: string;
}

export type Command =
  | (CommandBase & { kind: "putItem"; locationId: string; item: Record<string, unknown> })
  | (CommandBase & { kind: "deleteItem"; itemId: string })
  | (CommandBase & {
      kind: "moveItem";
      itemId: string;
      destination: { roomId: string; locationId: string };
    })
  | (CommandBase & { kind: "putProfile"; profile: Record<string, unknown> })
  | (CommandBase & { kind: "putLocation"; location: Record<string, unknown> })
  | (CommandBase & { kind: "deleteLocation"; locationId: string })
  | (CommandBase & {
      kind: "resolveConflict";
      table: RowTable;
      rowId: string;
      keep: "row" | "tombstone";
      /** REQUIRED when `keep` is "row": a resolve without content once wiped
       *  the row (audit-2 N11, executed). */
      content?: Record<string, unknown>;
    });

export interface CommandAck {
  opIds: string[];
  rowId: string;
}

export interface CommandOptions {
  now?: () => number;
  uuid?: () => string;
  deviceId?: string;
  /** Bounded retries on a mint-path ConstraintError (plan §6.3: 3×). */
  attempts?: number;
}

const MINT_ATTEMPTS = 3;

// ─── Helpers ───────────────────────────────────────────────────────────────

function isConstraintError(error: unknown): boolean {
  const candidate = error as { name?: string; inner?: { name?: string } } | null;
  return candidate?.name === "ConstraintError" || candidate?.inner?.name === "ConstraintError";
}

function isQuotaError(error: unknown): boolean {
  const candidate = error as { name?: string; inner?: { name?: string } } | null;
  return candidate?.name === "QuotaExceededError" || candidate?.inner?.name === "QuotaExceededError";
}

/** `${deviceId8}-${nanoid}` — collision-safe across installs, unlike the
 *  deterministic seeds (`p1`, `loc-home-shelf`) the migration remaps. */
function mintRowId(deviceId: string, uuid: string): string {
  const prefix = deviceId.replace(/-/g, "").slice(0, 8);
  const suffix = uuid.replace(/-/g, "").slice(0, 10);
  return `${prefix}-${suffix}`;
}

/** A row's content without the reducer-owned columns. */
function rowContent(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "winner" || key === "deletedAt" || key === "id" || key === "profileId") continue;
    out[key] = value;
  }
  return out;
}

async function resolveDeviceId(db: OwlshelfDB, options: CommandOptions): Promise<string> {
  if (options.deviceId) return options.deviceId;
  const row = await db.meta.get(META_KEYS.deviceId);
  if (typeof row?.value === "string") return row.value;
  const value = crypto.randomUUID();
  await db.meta.put({ key: META_KEYS.deviceId, value });
  return value;
}

function ackFromRecord(record: Record<string, unknown>): CommandAck {
  const rowId = typeof record.rowId === "string" ? record.rowId : "";
  if (typeof record.opId === "string") return { opIds: [record.opId], rowId };
  if (Array.isArray(record.opIds)) return { opIds: record.opIds as string[], rowId };
  throw new CommandError("internal", "corrupt cmd record");
}

// ─── Executor ──────────────────────────────────────────────────────────────

/**
 * Execute one command and resolve on COMMIT.
 *
 * A `ConstraintError` on the mint path (sibling-engine race, Android PWA +
 * tab) retries the whole command with fresh reads, bounded — the two
 * ConstraintError policies are deliberately different: mint-path collision →
 * bounded retry; adoption-path collision → dedup no-op/abort (§6.4).
 */
export async function executeCommand(
  db: OwlshelfDB,
  command: Command,
  options: CommandOptions = {},
): Promise<CommandAck> {
  const attempts = options.attempts ?? MINT_ATTEMPTS;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await runCommand(db, command, options);
    } catch (error) {
      if (error instanceof CommandError) throw error;
      if (isConstraintError(error)) {
        lastError = error;
        continue;
      }
      if (isQuotaError(error)) {
        throw new CommandError("quota", `quota exceeded: ${String(error)}`);
      }
      if (error instanceof HlcOverflowError) {
        throw new CommandError("internal", error.message);
      }
      throw new CommandError("internal", String(error));
    }
  }

  throw new CommandError("constraint", `mint collided ${attempts}×: ${String(lastError)}`);
}

async function runCommand(
  db: OwlshelfDB,
  command: Command,
  options: CommandOptions,
): Promise<CommandAck> {
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());

  return db.transaction(
    "rw",
    [db.meta, db.ops, db.outbox, db.pending, db.quarantine, db.profiles, db.locations, db.items],
    async (): Promise<CommandAck> => {
      // Idempotency: a retry with a known cmdId returns the ORIGINAL ack.
      const recorded = await db.meta.get(`cmd:${command.cmdId}`);
      if (recorded) return ackFromRecord(recorded as Record<string, unknown>);

      const room = await readRoom(db, command.roomId);
      if (!room) throw new CommandError("validation", `unknown room ${command.roomId}`);

      const deviceId = await resolveDeviceId(db, options);
      const minted: RowOp[] = [];
      /** A cross-room move mints into TWO rooms, so the clock and the
       *  authorSeq counter advance in the room the op actually belongs to —
       *  otherwise the destination room's counter never moves and its next
       *  mint collides on the unique index. */
      let destinationRoom: Awaited<ReturnType<typeof readRoom>> = undefined;

      const mintInto =
        (target: { roomId: string; clock: { ts: number; counter: number }; nextAuthorSeq: number }) =>
        (spec: Pick<RowOp, "type" | "table" | "rowId"> & { payload?: unknown }): RowOp => {
          const clock = mintHlc(target.clock, now());
          target.clock = clock;
          const authorSeq = target.nextAuthorSeq;
          target.nextAuthorSeq = authorSeq + 1;
          const op: RowOp = {
            opId: uuid(),
            roomId: target.roomId,
            deviceId,
            authorSeq,
            hlcTs: clock.ts,
            hlcCounter: clock.counter,
            ...spec,
          };
          minted.push(op);
          return op;
        };

      const mint = mintInto(room);

      let rowId: string;

      switch (command.kind) {
        case "putItem": {
          const draft = command.item;
          rowId =
            typeof draft.id === "string" && draft.id.length > 0
              ? draft.id
              : mintRowId(deviceId, uuid());
          const payload = normalizePutPayload(
            "items",
            { ...draft, locationId: command.locationId },
            { side: "mint" },
          );
          if (!payload.ok) throw new CommandError("validation", "invalid item payload");
          await reduceOp(db, mint({ type: "put", table: "items", rowId, payload: payload.value }));
          break;
        }

        case "deleteItem": {
          rowId = command.itemId;
          await reduceOp(db, mint({ type: "delete", table: "items", rowId }));
          break;
        }

        case "moveItem": {
          const source = (await db.items.get(command.itemId)) as Record<string, unknown> | undefined;
          if (!source) throw new CommandError("validation", `unknown item ${command.itemId}`);
          const content = rowContent(source);

          if (command.destination.roomId === command.roomId) {
            // Same-room move: ONE put with the new locationId, no tombstone.
            rowId = command.itemId;
            const payload = normalizePutPayload(
              "items",
              { ...content, locationId: command.destination.locationId },
              { side: "mint" },
            );
            if (!payload.ok) throw new CommandError("validation", "invalid item payload");
            await reduceOp(db, mint({ type: "put", table: "items", rowId, payload: payload.value }));
            break;
          }

          // Cross-room move: TWO ops in TWO rooms, copy before delete. The
          // destination row gets a NEW rowId — reusing the source id would be
          // rejected as a cross-room probe, since that row still exists in
          // the source room.
          destinationRoom = await readRoom(db, command.destination.roomId);
          if (!destinationRoom) {
            throw new CommandError("validation", `unknown room ${command.destination.roomId}`);
          }
          const destinationRowId = mintRowId(deviceId, uuid());
          const destinationPayload = normalizePutPayload(
            "items",
            { ...content, locationId: command.destination.locationId },
            { side: "mint" },
          );
          if (!destinationPayload.ok) throw new CommandError("validation", "invalid item payload");

          const mintDestination = mintInto(destinationRoom);
          await reduceOp(
            db,
            mintDestination({
              type: "put",
              table: "items",
              rowId: destinationRowId,
              payload: destinationPayload.value,
            }),
          );

          const sourceOp = mint({ type: "delete", table: "items", rowId: command.itemId });
          await reduceOp(db, sourceOp);

          rowId = destinationRowId;
          break;
        }

        case "putProfile": {
          rowId = command.roomId;
          const payload = normalizePutPayload("profiles", command.profile, { side: "mint" });
          if (!payload.ok) throw new CommandError("validation", "invalid profile payload");
          await reduceOp(db, mint({ type: "put", table: "profiles", rowId, payload: payload.value }));
          break;
        }

        case "putLocation": {
          const draft = command.location;
          rowId =
            typeof draft.id === "string" && draft.id.length > 0
              ? draft.id
              : mintRowId(deviceId, uuid());
          const payload = normalizePutPayload("locations", draft, { side: "mint" });
          if (!payload.ok) throw new CommandError("validation", "invalid location payload");
          await reduceOp(db, mint({ type: "put", table: "locations", rowId, payload: payload.value }));
          break;
        }

        case "deleteLocation": {
          rowId = command.locationId;
          await reduceOp(db, mint({ type: "delete", table: "locations", rowId }));
          break;
        }

        case "resolveConflict": {
          rowId = command.rowId;
          const payload = normalizeResolvePayload(
            command.table,
            { keep: command.keep, content: command.content },
            { side: "mint" },
          );
          if (!payload.ok) throw new CommandError("validation", "invalid resolve payload");
          // The op carries the NORMALIZED payload, so the wire never ships a
          // resolve whose content the receiver would have to re-interpret.
          const wire =
            payload.keep === "row"
              ? { keep: "row" as const, content: payload.content }
              : { keep: "tombstone" as const };
          await reduceOp(db, mint({ type: "resolve", table: command.table, rowId, payload: wire }));
          break;
        }

        default: {
          throw new CommandError("validation", "unknown command kind");
        }
      }

      // Durable outbox: the op is already durable from the moment the command
      // acks; the memory socket queue is only a transport buffer.
      const createdAt = now();
      for (const op of minted) {
        const entry: OutboxEntry = {
          opId: op.opId,
          roomId: op.roomId,
          deviceId: op.deviceId,
          authorSeq: op.authorSeq,
          state: "pending",
          attempts: 0,
          createdAt,
        };
        await db.outbox.put(entry);
      }

      // §15.5: `opId` for a single-op command, `{ opIds, rowId }` for the one
      // multi-op command (a cross-room move).
      if (minted.length === 1) {
        await db.meta.put({ key: `cmd:${command.cmdId}`, opId: minted[0].opId, rowId });
      } else {
        await db.meta.put({
          key: `cmd:${command.cmdId}`,
          opIds: minted.map((op) => op.opId),
          rowId,
        });
      }

      await writeRoom(db, room);
      // A cross-room move advanced the destination room's clock and counter
      // too; both records commit in this same transaction.
      if (destinationRoom) await writeRoom(db, destinationRoom);
      return { opIds: minted.map((op) => op.opId), rowId };
    },
  );
}
