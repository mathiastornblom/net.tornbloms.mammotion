'use strict';

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Reads env.json-provided secrets via `Homey.env` (documented at
 * https://apps.developer.homey.app/the-basics/app — env.json lives at the app root,
 * belongs in .gitignore, and its uppercase-keyed string values are "available anywhere in
 * your app under Homey.env.CLIENT_ID" per that page; populated at install/publish time,
 * never committed to the repo). The 'homey' module only exists inside Homey's own runtime
 * sandbox — it isn't an installable npm package (no node_modules/homey anywhere, even in
 * the built .homeybuild output), so plain Node (this project's scripts/*.test.mjs, run
 * outside that sandbox) can't resolve it. Falls back to reading env.json directly off disk
 * in that case — the same file Homey's own CLI reads for local `homey app run`, so
 * scripts/tests see identical values without needing the real 'homey' package. Falls back
 * further to {} if even that's missing (a fresh checkout with no env.json yet) rather than
 * crashing every test that transitively imports a constants file needing a secret. */
function loadHomeyEnv(): Record<string, string> {
  try {
    const require = createRequire(import.meta.url);
    const Homey = require('homey') as { env?: Record<string, string> };
    // Note: can't just try/catch this require() and stop there — `homey app build` generates
    // a local .homeybuild/node_modules/homey stub (a self-referential `module.exports =
    // require('homey')`) purely so static module resolution succeeds during local build/dev.
    // Node's circular-require handling resolves that stub to `{}` (the in-progress, not-yet-
    // assigned module.exports) rather than throwing, so it must be detected by the *absence*
    // of `.env`, not by whether the require call itself failed.
    if (Homey.env) return Homey.env;
  } catch {
    // Genuinely unresolvable (no stub at all) — fall through to the disk read below.
  }
  try {
    return JSON.parse(readFileSync(join(process.cwd(), 'env.json'), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export const HOMEY_ENV: Record<string, string> = loadHomeyEnv();
