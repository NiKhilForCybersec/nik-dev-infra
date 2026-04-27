/* Vitest setup — give every test file a fresh, isolated SQLite DB so
 * shared module-level singletons (memory.ts) don't carry state between
 * test files. We do this by:
 *
 *   1. Setting NIK_PATH env to a tmp dir BEFORE memory.ts loads, so the
 *      DATA_DIR resolves under the tmpdir.
 *   2. Pinning a unique filename per worker via vitest's worker id.
 *
 * memory.ts opens its DB at module load time, so the env var must be set
 * before any test file imports it. setupFiles guarantees this — Vitest
 * runs setupFiles before resolving test imports.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'dev-infra-test-'));
process.env.DEVINFRA_TARGET = sandbox;
process.env.DEVINFRA_LABEL = 'test';
// Point dev-infra's data dir away from the real one so tests don't
// touch the developer's findings.jsonl / memory.db.
process.env.DEV_INFRA_DATA_DIR = join(sandbox, 'data');
