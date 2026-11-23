/**
 * capture.test.mjs — the pure half of capture-time compression (plan §8.1).
 *
 * The encode path needs a canvas, so it is browser-only. The geometry is
 * pure, and it is the part that decides whether a 4000px photo becomes a
 * 1024px one or stays at 4000px and blows the 1 MB post-compression cap.
 */

import {
  MAX_COMPRESSED_BYTES,
  MAX_DIMENSION,
  MAX_RAW_BYTES,
  fitWithin,
} from "../../src/lib/capture.ts";
import { assertDeepEqual, assertEqual } from "../lib/assert.mjs";

export default {
  name: "capture — the 4 MB raw / 1 MB compressed / 1024px rules",
  tests: [
    {
      name: "the caps are the documented ones",
      run() {
        assertEqual(MAX_RAW_BYTES, 4 * 1024 * 1024, "raw cap is 4 MB");
        assertEqual(MAX_COMPRESSED_BYTES, 1024 * 1024, "compressed cap is 1 MB");
        assertEqual(MAX_DIMENSION, 1024, "long edge is 1024px");
      },
    },
    {
      name: "a landscape photo is scaled on its long edge",
      run() {
        assertDeepEqual(fitWithin(4000, 3000), { width: 1024, height: 768 }, "4000×3000 → 1024×768");
      },
    },
    {
      name: "a portrait photo is scaled on its long edge",
      run() {
        assertDeepEqual(fitWithin(3000, 4000), { width: 768, height: 1024 }, "3000×4000 → 768×1024");
      },
    },
    {
      name: "a square photo is scaled on both edges",
      run() {
        assertDeepEqual(fitWithin(2048, 2048), { width: 1024, height: 1024 }, "2048² → 1024²");
      },
    },
    {
      name: "an image already inside the bound is never upscaled",
      run() {
        assertDeepEqual(fitWithin(800, 600), { width: 800, height: 600 }, "800×600 unchanged");
        assertDeepEqual(fitWithin(1024, 1024), { width: 1024, height: 1024 }, "exactly 1024 unchanged");
      },
    },
    {
      name: "a degenerate edge never rounds to zero",
      run() {
        const fitted = fitWithin(4000, 1);
        assertEqual(fitted.width, 1024, "long edge clamped");
        assertEqual(fitted.height, 1, "a 1px edge stays 1px, never 0");
      },
    },
  ],
};
