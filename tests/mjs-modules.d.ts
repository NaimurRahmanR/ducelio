// Ambient declaration for the plain, untyped acceptance-harness scripts
// (scripts/acceptance/*.mjs), imported only from tests/acceptance-harness.test.ts.
// These are deliberately plain Node ESM utilities (no build step, run
// directly via `node`), not part of the typed application surface -- this
// keeps their imports resolvable under `tsc --noEmit` without adding a
// parallel, speculative type system for standalone acceptance tooling.
declare module "*.mjs";
