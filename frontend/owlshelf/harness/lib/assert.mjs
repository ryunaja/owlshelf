/**
 * assert.mjs — the harness's whole assertion vocabulary.
 *
 * Deliberately tiny: the point of this harness is to EXECUTE the shipped
 * modules against real Dexie, not to grow a test framework.
 */

function format(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message} — expected ${format(expected)}, got ${format(actual)}`);
  }
}

export function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message} — expected ${b}, got ${a}`);
}

export async function assertRejects(fn, message) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`${message} — expected a rejection, got a resolution`);
}

export async function assertRejectsWith(fn, predicate, message) {
  try {
    await fn();
  } catch (error) {
    if (!predicate(error)) {
      throw new Error(`${message} — rejected with the wrong error: ${format(error)}`);
    }
    return;
  }
  throw new Error(`${message} — expected a rejection, got a resolution`);
}
