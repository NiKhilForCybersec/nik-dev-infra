/* Registry agent — deterministic.
 *
 * Walks ~/NIK/web/src/contracts/*.ts, counts ops + commands, flags
 * duplicate names. No LLM call; ~5ms run. Cheap baseline that
 * always works even when claude binary is missing.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NIK_PATH } from '../claude.ts';
import { newId } from '../findings.ts';
import type { Agent, Finding } from '../types.ts';

const CONTRACTS_DIR = resolve(NIK_PATH, 'web/src/contracts');

export const registryAgent: Agent = {
  name: 'registry',
  description: 'Counts ops + commands across contracts/. Flags duplicate names.',
  routedFiles: ['web/src/contracts/*.ts'],
  intervalMs: 60_000,
  run: async () => {
    const findings: Finding[] = [];
    const seen = new Map<string, string>();        // name -> file
    let opCount = 0, cmdCount = 0;

    let files: string[] = [];
    try { files = readdirSync(CONTRACTS_DIR); } catch { return findings; }

    for (const file of files) {
      if (!file.endsWith('.ts') || file === 'index.ts') continue;
      const src = readFileSync(resolve(CONTRACTS_DIR, file), 'utf8');
      const re = /name:\s*['"]([\w.]+)['"]/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const name = m[1];
        if (!name) continue;
        if (seen.has(name)) {
          findings.push({
            id: newId(),
            agent: 'registry',
            kind: 'registry:duplicate',
            at: Date.now(),
            severity: 'error',
            summary: `Duplicate op/command name: ${name}`,
            file: `web/src/contracts/${file}`,
            suggestion: `Already declared in ${seen.get(name)}. Rename one.`,
            payload: { name, files: [seen.get(name), file] },
          });
        }
        seen.set(name, file);
        if (name.startsWith('ui.')) cmdCount++;
        else opCount++;
      }
    }

    findings.push({
      id: newId(),
      agent: 'registry',
      kind: 'registry:summary',
      at: Date.now(),
      severity: 'info',
      summary: `${opCount + cmdCount} tools registered (${opCount} ops + ${cmdCount} commands)`,
      payload: { opCount, cmdCount, total: opCount + cmdCount },
    });

    return findings;
  },
};
