'use strict';

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Reads env.json-provided secrets via Homey's `env` export (see
 * https://apps.developer.homey.app/the-basics/app/App#environment-variables — populated at
 * install/publish time from a git-ignored env.json, never committed to the repo). The
 * 'homey' module only exists inside Homey's own runtime sandbox — it isn't an installable
 * npm package (no node_modules/homey anywhere, even in the built .homeybuild output), so
 * plain Node (this project's scripts/*.test.mjs, run outside that sandbox) can't resolve
 * it. Falls back to reading env.json directly off disk in that case — the same file Homey's
 * own CLI reads for local `homey app run`, so scripts/tests see identical values without
 * needing the real 'homey' package. Falls back further to {} if even that's missing (a
 * fresh checkout with no env.json yet) rather than crashing every test that transitively
 * imports a constants file needing a secret. */
function loadHomeyEnv(): Record<string, string> {
  try {
    const require = createRequire(import.meta.url);
    return (require('homey') as { env?: Record<string, string> }).env ?? {};
  } catch {
    try {
      return JSON.parse(readFileSync(join(process.cwd(), 'env.json'), 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
}

export const HOMEY_ENV: Record<string, string> = loadHomeyEnv();
