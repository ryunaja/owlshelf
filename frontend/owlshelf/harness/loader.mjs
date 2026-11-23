/**
 * loader.mjs — Node resolution for the app's Vite-style specifiers.
 *
 * The harness runs the SHIPPED modules (plan §13: "the same code that ships,
 * never a test double"), so it has to resolve the two things Vite resolves
 * and Node does not:
 *
 *   1. extensionless relative imports — `./stores` → `./stores.ts`
 *   2. the `@/` alias — `@/types/item` → `<root>/src/types/item.ts`
 *
 * Node 26 strips the types itself (erasable syntax only, which
 * tsconfig.app.json already enforces), so no transpiler is involved.
 *
 * The hook is SYNCHRONOUS because it is installed with `module.registerHooks`
 * (in-thread), not the deprecated `module.register` loader thread.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const SRC = fileURLToPath(new URL("src/", ROOT));

const EXTENSIONS = [".ts", ".mts", ".tsx", "/index.ts"];

function firstExisting(base) {
  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const resolved = firstExisting(`${SRC}${specifier.slice(2)}`);
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
    throw new Error(`harness: cannot resolve alias ${specifier}`);
  }

  const relative =
    specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
  if (!relative) return nextResolve(specifier, context);

  try {
    return nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    const base = specifier.startsWith("/")
      ? specifier
      : fileURLToPath(new URL(specifier, context.parentURL));
    const resolved = firstExisting(base);
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
    throw error;
  }
}
