/**
 * suites/index.mjs — the suite list, in dependency order.
 *
 * hlc, payload and media are pure; reduce and cmd execute against real Dexie.
 */

import hlc from "./hlc.test.mjs";
import payload from "./payload.test.mjs";
import media from "./media.test.mjs";
import reduce from "./reduce.test.mjs";
import cmd from "./cmd.test.mjs";

export const suites = [hlc, payload, media, reduce, cmd];
