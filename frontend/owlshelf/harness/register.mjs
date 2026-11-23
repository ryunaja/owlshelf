/**
 * register.mjs — installs loader.mjs for the harness process.
 *
 * Usage: node --import ./harness/register.mjs harness/run.mjs
 * (wired as `npm run harness`).
 */

import { registerHooks } from "node:module";
import { resolve } from "./loader.mjs";

registerHooks({ resolve });
