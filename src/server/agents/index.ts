/* Agent registry. Adding a new agent = create the .ts + .md
 *  files in this dir + add an entry below. */

import type { Agent } from '../types.ts';
import { driftAgent } from './drift.ts';
import { hardcodedAgent } from './hardcoded.ts';
import { navigationAgent } from './navigation.ts';
import { registryAgent } from './registry.ts';

export const AGENTS: Agent[] = [
  registryAgent,    // deterministic — always works
  driftAgent,       // claude -p
  navigationAgent,  // claude -p
  hardcodedAgent,   // claude -p
];
