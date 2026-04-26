/* Registry agent — deterministic.
 *
 * Walks ~/NIK/web/src/contracts/*.ts, counts ops + commands, flags
 * duplicate names. No LLM call; ~5ms run. Cheap baseline that
 * always works even when claude binary is missing.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import { parseFinding } from '../findings.ts';
import type { Agent, Finding } from '../types.ts';
import { RegistryFindingSchema } from './schemas.ts';

export const registryAgent: Agent = {
  name: 'registry',
  description: 'Counts ops + commands across the contracts dir. Flags duplicate names.',
  routedFiles: config.contractsDir ? [`${config.contractsDir}/*.ts`] : [],
  intervalMs: 60_000,
  run: async () => {
    const findings: Finding[] = [];
    if (!config.contractsDir) return findings;
    const contractsDir = resolve(config.targetPath, config.contractsDir);
    const seen = new Map<string, string>();        // name -> file
    let opCount = 0, cmdCount = 0;

    let files: string[] = [];
    try { files = readdirSync(contractsDir); } catch { return findings; }

    for (const file of files) {
      if (!file.endsWith('.ts') || file === 'index.ts') continue;
      const src = readFileSync(resolve(contractsDir, file), 'utf8');
      const re = /name:\s*['"]([\w.]+)['"]/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const name = m[1];
        if (!name) continue;
        if (seen.has(name)) {
          findings.push(parseFinding('registry', {
            kind: 'registry:duplicate',
            severity: 'error',
            summary: `Duplicate op/command name: ${name}`,
            file: `${config.contractsDir}/${file}`,
            suggestion: `Already declared in ${seen.get(name)}. Rename one.`,
            payload: { name, files: [seen.get(name), file] },
          }, RegistryFindingSchema));
        }
        seen.set(name, file);
        if (name.startsWith('ui.')) cmdCount++;
        else opCount++;
      }
    }

    findings.push(parseFinding('registry', {
      kind: 'registry:summary',
      severity: 'info',
      summary: `${opCount + cmdCount} tools registered (${opCount} ops + ${cmdCount} commands)`,
      payload: { opCount, cmdCount, total: opCount + cmdCount },
    }, RegistryFindingSchema));

    return findings;
  },
};
