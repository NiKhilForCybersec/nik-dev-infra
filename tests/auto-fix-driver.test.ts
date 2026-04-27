/* Auto-fix-driver pure-function tests — concern parsing, fingerprinting,
 * actionability gate, scope filter. The driver's run() function is too
 * stateful for unit tests (depends on git, claude -p, file watcher),
 * but its decision functions are pure and warrant tight coverage —
 * they're the safety gates that decide what reaches a live cycle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprint, isActionable, isInScope, parseConcerns } from '../src/server/agents/auto-fix-driver.ts';

// Mock the live config so isInScope sees a known scopes list per test.
vi.mock('../src/server/config.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/server/config.ts')>('../src/server/config.ts');
  return {
    ...actual,
    config: {
      ...actual.config,
      autoFixLoop: {
        enabled: false,
        dryRun: true,
        maxCyclesPerDay: 1,
        maxConsecutiveFailures: 3,
        killSwitchFile: '.dev-infra-pause',
        scopes: ['docs/**', '*.md', '*.json'],
      },
    },
  };
});

describe('parseConcerns', () => {
  it('parses bullets, ignores headers + decorative content', () => {
    const md = `# Header

Some intro paragraph

- **ERROR** · \`secrets/secrets:openai\` — OpenAI key in commit
- **WARN** · \`drift\` — manifest mismatch
- short
`;
    const c = parseConcerns(md);
    expect(c).toHaveLength(2);                         // 'short' is too short to count
    expect(c[0]!.severity).toBe('error');
    expect(c[1]!.severity).toBe('warn');
  });

  it('extracts a fileRef from inline-code path patterns', () => {
    const md = `- Add \`web/src/lib/auth.ts:42\` should validate session\n`;
    const c = parseConcerns(md);
    expect(c[0]!.fileRef).toBe('web/src/lib/auth.ts');
  });

  it('defaults severity to info when no marker', () => {
    const md = `- Just a casual observation about something interesting\n`;
    expect(parseConcerns(md)[0]!.severity).toBe('info');
  });
});

describe('fingerprint', () => {
  it('produces a 16-char hex hash', () => {
    const fp = fingerprint('whatever the concern says');
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });

  it('normalizes whitespace + markdown so cosmetic variations match', () => {
    const a = fingerprint('Add `web/src/lib/auth.ts` validation');
    const b = fingerprint('add web/src/lib/auth.ts validation\n\n');
    expect(a).toBe(b);
  });

  it('strips ISO timestamps + finding ids (curator-injected suffixes)', () => {
    const a = fingerprint('Bug in screen <small>2026-04-26T18:00:00Z · finding abc-123</small>');
    const b = fingerprint('Bug in screen');
    expect(a).toBe(b);
  });

  it('different content → different hash', () => {
    expect(fingerprint('alpha')).not.toBe(fingerprint('beta'));
  });
});

describe('isActionable (hard-path gate)', () => {
  const baseConcern = (overrides: Partial<Parameters<typeof isActionable>[0]>) => ({
    fingerprint: 'fp', text: '', severity: 'info' as const, rawLineNo: 1, ...overrides,
  });

  it('rejects too-short concerns', () => {
    const r = isActionable(baseConcern({ text: 'small' }), undefined);
    expect(r.actionable).toBe(false);
    if (!r.actionable) expect(r.reason).toMatch(/too short/i);
  });

  it('rejects observational concerns with no file ref / verdict / imperative', () => {
    const r = isActionable(baseConcern({ text: 'Things look fine in the dashboard today and yesterday too' }), undefined);
    expect(r.actionable).toBe(false);
  });

  it('rejects speculative wording (maybe / perhaps / consider) even with an imperative verb', () => {
    // The text MUST clear the prior gates (imperative present) so the
    // speculative gate is what trips it — otherwise this test would
    // tautologically pass via a different reject path.
    const r = isActionable(baseConcern({ text: 'Maybe add a dashboard widget for memory stats — perhaps consider it later' }), undefined);
    expect(r.actionable).toBe(false);
    if (!r.actionable) expect(r.reason).toMatch(/speculative/i);
  });

  it('accepts when an imperative verb is present', () => {
    const r = isActionable(baseConcern({ text: 'Add a typecheck step to CI before merges' }), undefined);
    expect(r.actionable).toBe(true);
  });

  it('accepts when a curator verdict is present (even without imperative)', () => {
    const r = isActionable(baseConcern({ text: 'Some lengthy descriptive text about a problem area' }), 'cosmetic');
    expect(r.actionable).toBe(true);
  });

  it('accepts when a fileRef is present', () => {
    const r = isActionable(baseConcern({ text: 'Long enough text describing some issue', fileRef: 'foo.ts' }), undefined);
    expect(r.actionable).toBe(true);
  });
});

describe('isInScope', () => {
  const c = (fileRef?: string) => ({ fingerprint: 'fp', text: 't', severity: 'info' as const, rawLineNo: 1, fileRef });

  it('rejects concerns without a fileRef when scopes is non-empty', () => {
    expect(isInScope(c(undefined))).toBe(false);
  });

  it('accepts files matching docs/** scope', () => {
    expect(isInScope(c('docs/Concerns.md'))).toBe(true);
    expect(isInScope(c('docs/architecture/notes.md'))).toBe(true);
  });

  it('accepts top-level *.md files via the *.md glob', () => {
    expect(isInScope(c('CLAUDE.md'))).toBe(true);
  });

  it('rejects source-code paths that fall outside the scope', () => {
    expect(isInScope(c('web/src/App.tsx'))).toBe(false);
    expect(isInScope(c('src/server/index.ts'))).toBe(false);
  });
});
