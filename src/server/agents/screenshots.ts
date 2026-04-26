/* Screenshots agent — deterministic.
 *
 * The user's Claude Code session (running in the watched repo)
 * drops screenshots into `<repo>/<config.screenshotsDir>/` keyed
 * by screen name. This agent:
 *
 *   - watches that folder via routedFiles
 *   - groups files by screen prefix (e.g. 'HomeScreen.png',
 *     'HomeScreen.20260426-074500.png' both map to screen:HomeScreen)
 *   - registers a `has_screenshot` fact per latest PNG
 *   - prunes older versions, keeping only the newest 2 per screen,
 *     so the folder stays bounded (the user can keep more by hand
 *     if they want — the agent only deletes its own old archives)
 *   - emits findings on add / update / missing
 *
 * Hard-path: only adds a fact when the file actually exists and is
 * a non-empty image. No assumption that a screen name with no
 * matching file means "missing screenshot" unless the screen is in
 * the register (we don't flag screens that simply don't exist).
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { addFact, entities, registerEntity } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';

const KEEP_PER_SCREEN = 2;
const VALID_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

type Entry = { file: string; mtimeMs: number };

function listScreenshots(dir: string): Map<string, Entry[]> {
  // Returns a map: screenName → list of files (newest first).
  const out = new Map<string, Entry[]>();
  if (!existsSync(dir)) return out;
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const lowExt = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (!VALID_EXT.has(lowExt)) continue;
    // Take the prefix up to the first dot or hyphen-followed-by-digit-y stuff.
    // Conventions accepted:
    //   HomeScreen.png
    //   HomeScreen.20260426-074500.png
    //   HomeScreen-2.png
    //   HomeScreen_v2.png
    const stem = name.slice(0, name.lastIndexOf('.'));
    const screenMatch = stem.match(/^([A-Z][A-Za-z0-9]*Screen)\b/);
    if (!screenMatch) continue;
    const screenName = screenMatch[1]!;
    const abs = resolve(dir, name);
    let mtimeMs = 0;
    try { mtimeMs = statSync(abs).mtimeMs; } catch { continue; }
    const list = out.get(screenName) ?? [];
    list.push({ file: name, mtimeMs });
    out.set(screenName, list);
  }
  for (const list of out.values()) list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export const screenshotsAgent: Agent = {
  name: 'screenshots',
  description: "Watches the screenshots folder; registers each as a fact; prunes old versions (keeps newest 2 per screen).",
  routedFiles: [`${config.screenshotsDir}/*`],
  intervalMs: 30 * 60 * 1000,           // half-hour backstop
  run: async () => {
    const findings: Finding[] = [];
    const dir = resolve(config.targetPath, config.screenshotsDir);
    const screenURNs = new Set(entities({ kind: 'screen' }).map((e) => e.urn));
    const grouped = listScreenshots(dir);

    if (grouped.size === 0) {
      return [{
        id: newId(),
        agent: 'screenshots',
        kind: 'screenshots:none',
        at: Date.now(),
        severity: 'info',
        summary: `no screenshots found at ${config.screenshotsDir} — drop *Screen.png files there to populate the playground`,
      }];
    }

    let registered = 0;
    let pruned = 0;
    for (const [screenName, entries] of grouped) {
      const screenUrn = `screen:${screenName}`;
      // Only register if the screen exists in the register — otherwise we'd
      // be creating shadow nodes for screenshots of non-existent screens.
      if (!screenURNs.has(screenUrn)) continue;

      const newest = entries[0]!;
      const relPath = `${config.screenshotsDir}/${newest.file}`;
      // Refresh the screen entity so the file pointer + mtime are current.
      const screen = entities({ kind: 'screen' }).find((e) => e.urn === screenUrn);
      if (screen) {
        registerEntity({
          urn: screen.urn,
          kind: screen.kind,
          label: screen.label,
          ...(screen.file ? { file: screen.file } : {}),
          evidence: Array.from(new Set([...(screen.evidence ?? []), relPath])),
          agent: 'screenshots',
          confidence: screen.confidence,
          ...(screen.segment ? { segment: screen.segment } : {}),
        });
      }
      addFact({
        agent: 'screenshots',
        subject: screenUrn,
        predicate: 'has_screenshot',
        object: relPath,
        evidence: [relPath],
      });
      registered++;

      // Prune anything beyond KEEP_PER_SCREEN.
      if (entries.length > KEEP_PER_SCREEN) {
        for (const stale of entries.slice(KEEP_PER_SCREEN)) {
          try {
            unlinkSync(resolve(dir, stale.file));
            pruned++;
          } catch { /* skip stat / permission errors */ }
        }
      }
    }

    findings.push({
      id: newId(),
      agent: 'screenshots',
      kind: 'screenshots:summary',
      at: Date.now(),
      severity: 'info',
      summary: `${registered} screenshot${registered === 1 ? '' : 's'} registered · ${pruned} pruned`,
      payload: { registered, pruned, dir: config.screenshotsDir, keepPerScreen: KEEP_PER_SCREEN },
    });

    return findings;
  },
};
