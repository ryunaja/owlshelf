/**
 * suites/index.mjs — the suite list, in dependency order.
 *
 * hlc, payload, media, capture, mediaUrl, canonical and envelope are pure or
 * near-pure; reduce, cmd, live, outbox, gc and catchup execute against real
 * Dexie. sync drives the engine through an injected socket, so it needs neither.
 */

import hlc from "./hlc.test.mjs";
import payload from "./payload.test.mjs";
import media from "./media.test.mjs";
import capture from "./capture.test.mjs";
import mediaUrl from "./mediaUrl.test.mjs";
import blobDemand from "./blobDemand.test.mjs";
import canonical from "./canonical.test.mjs";
import envelope from "./envelope.test.mjs";
import reduce from "./reduce.test.mjs";
import cmd from "./cmd.test.mjs";
import live from "./live.test.mjs";
import outbox from "./outbox.test.mjs";
import gc from "./gc.test.mjs";
import catchup from "./catchup.test.mjs";
import audit from "./audit.test.mjs";
import blob from "./blob.test.mjs";
import sync from "./sync.test.mjs";
import socketHub from "./socketHub.test.mjs";
import syncErrors from "./syncErrors.test.mjs";
import syncHealth from "./syncHealth.test.mjs";
import roomShare from "./roomShare.test.mjs";
import rooms from "./rooms.test.mjs";
import pairing from "./pairing.test.mjs";
import syncRuntime from "./syncRuntime.test.mjs";
import syncStore from "./syncStore.test.mjs";
import liveQuery from "./liveQuery.test.mjs";
import twoDevice from "./twoDevice.test.mjs";
import worker from "./worker.test.mjs";
import integration from "./integration.test.mjs";

export const suites = [
  hlc,
  payload,
  media,
  capture,
  mediaUrl,
  blobDemand,
  canonical,
  envelope,
  reduce,
  cmd,
  live,
  outbox,
  gc,
  catchup,
  audit,
  blob,
  sync,
  socketHub,
  syncErrors,
  syncHealth,
  roomShare,
  rooms,
  pairing,
  syncRuntime,
  syncStore,
  liveQuery,
  twoDevice,
  worker,
  integration,
];
