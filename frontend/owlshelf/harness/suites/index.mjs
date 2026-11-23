/**
 * suites/index.mjs — the suite list, in dependency order.
 *
 * hlc, payload, media, capture and mediaUrl are pure or near-pure; reduce and
 * cmd execute against real Dexie.
 */

import hlc from "./hlc.test.mjs";
import payload from "./payload.test.mjs";
import media from "./media.test.mjs";
import capture from "./capture.test.mjs";
import mediaUrl from "./mediaUrl.test.mjs";
import reduce from "./reduce.test.mjs";
import cmd from "./cmd.test.mjs";
import live from "./live.test.mjs";

export const suites = [hlc, payload, media, capture, mediaUrl, reduce, cmd, live];
