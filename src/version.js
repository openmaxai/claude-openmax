/**
 * Single source of truth for the plugin version: package.json.
 *
 * Two execution contexts, one behaviour:
 *  - Bundled dist/ (what the marketplace ships and CI's dependency-free smoke
 *    test loads from an empty dir): scripts/build.js passes esbuild
 *    `define: { __CLAUDE_OPENMAX_VERSION__: "<version>" }`, so the guard below
 *    folds to the inlined string literal and the runtime read is
 *    dead-code-eliminated — dist reads no external file and carries no
 *    package.json blob.
 *  - Unbundled src/ (npm exposes src/index.js + src/bridge.js as bins;
 *    engines >= node 20): the define is absent, so `typeof` of the undeclared
 *    identifier is 'undefined' and we read package.json at runtime with
 *    readFileSync — no JSON import attributes, so it parses on Node 20.0+.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let version;
if (typeof __CLAUDE_OPENMAX_VERSION__ !== 'undefined') {
  version = __CLAUDE_OPENMAX_VERSION__;
} else {
  version = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ).version;
}

export const PKG_VERSION = version;
export const DEFAULT_APP_VERSION = `claude-openmax/${version}`;
