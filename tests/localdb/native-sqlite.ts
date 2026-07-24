/**
 * Guard for tests that need onelibrary-connect's native SQLite binding.
 *
 * `better-sqlite3-multiple-ciphers` is a native addon, so its compiled binary
 * only loads under the Node ABI it was built for. In the Now Playing monorepo
 * the desktop app rebuilds every native module for Electron's ABI, which then
 * cannot be loaded by the plain Node that runs Jest — the DB-backed suites
 * would fail with NODE_MODULE_VERSION errors that say nothing about the code
 * under test.
 *
 * Suites wrapped in `describeWithOneLibraryDb` skip themselves in that
 * situation. They still run (and fail) in CI, where the binding is built for
 * the same Node that runs the tests and a load failure is a real problem —
 * that is exactly how the npm 12 `allowScripts` regression surfaced.
 *
 * Set NP_NATIVE_SQLITE=1 to force the suites to run locally.
 */

import * as path from 'path';

import {OneLibraryAdapter} from 'src/localdb/onelibrary';

const PROBE_DB = path.join(__dirname, 'fixtures', 'test-onelibrary.db');

/**
 * True for the ways a native addon reports "I cannot be loaded by this
 * runtime", as opposed to a genuine failure in the code under test.
 *
 * Duck-typed rather than `instanceof Error`: the addon throws from outside
 * Jest's module registry, so the error does not share this realm's Error.
 */
const isBindingLoadError = (err: unknown): boolean => {
  const {code, message} = (err ?? {}) as {code?: unknown; message?: unknown};

  return (
    code === 'ERR_DLOPEN_FAILED' ||
    (typeof message === 'string' &&
      (message.includes('NODE_MODULE_VERSION') ||
        message.includes('Could not locate the bindings file')))
  );
};

/** Returns the reason the binding is unusable, or null when it loads fine. */
const probeBinding = (): string | null => {
  try {
    new OneLibraryAdapter(PROBE_DB).close();
    return null;
  } catch (err) {
    if (isBindingLoadError(err)) {
      return String((err as {message?: unknown}).message).split('\n')[0];
    }
    // Anything else is a real failure — let the suites report it.
    return null;
  }
};

const reason = probeBinding();
const skipping = reason !== null && !process.env.CI && !process.env.NP_NATIVE_SQLITE;

if (skipping) {
  console.warn(
    `[localdb] Skipping OneLibrary DB tests: ${reason}\n` +
      '[localdb] The binding is built for another runtime (usually Electron, via the desktop app).\n' +
      '[localdb] Run with NP_NATIVE_SQLITE=1 to force them.'
  );
}

/**
 * `describe` for suites that open a OneLibrary database, skipped locally when
 * the native binding cannot load.
 */
export const describeWithOneLibraryDb = skipping ? describe.skip : describe;
