/* Sandbox-mode argument-validation tests for runClaude.
 *
 * We don't actually spawn `claude` here (that would take 60s + need
 * the CLI installed); we test the argument-validation gate that runs
 * BEFORE the spawn. The gate is what prevents a prompt-injected agent
 * from sneaking WebFetch / TodoWrite / MCP tools past the safe list,
 * or from defaulting cwd to dev-infra's source.
 *
 * The actual env-strip happens inside execa's options, which we can't
 * unit-test without stubbing execa. The behavioral guarantee is
 * documented + the gate's pre-spawn rejections are tested here.
 */

import { describe, expect, it } from 'vitest';
import { runClaude } from '../src/server/claude.ts';

describe('runClaude sandbox=true argument validation', () => {
  it('rejects allowedTools containing a tool not in SAFE_TOOLS', async () => {
    await expect(runClaude({
      prompt: 'noop',
      sandbox: true,
      cwd: '/tmp',
      allowedTools: ['Read', 'WebFetch'],
    })).rejects.toThrow(/WebFetch/);
  });

  it('rejects multiple disallowed tools and lists them all', async () => {
    await expect(runClaude({
      prompt: 'noop',
      sandbox: true,
      cwd: '/tmp',
      allowedTools: ['Read', 'WebFetch', 'WebSearch', 'TodoWrite'],
    })).rejects.toThrow(/WebFetch.*WebSearch.*TodoWrite|WebFetch.*TodoWrite.*WebSearch|TodoWrite.*WebFetch.*WebSearch|TodoWrite.*WebSearch.*WebFetch|WebSearch.*WebFetch.*TodoWrite|WebSearch.*TodoWrite.*WebFetch/);
  });

  it('rejects missing cwd in sandbox mode (refuses to default to dev-infra source)', async () => {
    await expect(runClaude({
      prompt: 'noop',
      sandbox: true,
      allowedTools: ['Read'],
    })).rejects.toThrow(/cwd/i);
  });

  it('SAFE_TOOLS list (Read / Write / Edit / Glob / Grep / Bash) all pass the validation gate', async () => {
    // We can't actually run claude in the test, but the gate runs
    // synchronously BEFORE the spawn. If validation passes, the call
    // proceeds and (in this test env without claude binary) fails at
    // ENOENT — that's our positive signal.
    for (const tool of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']) {
      try {
        await runClaude({ prompt: 'noop', sandbox: true, cwd: '/tmp', allowedTools: [tool], timeoutMs: 1000 });
      } catch (e) {
        const msg = (e as Error).message;
        // The gate would reject with /not in safe set/. Any other error
        // (ENOENT, timed out, etc.) means the gate accepted the tool.
        expect(msg).not.toMatch(/not in safe set/i);
      }
    }
  });
});

describe('runClaude default (sandbox=false) backwards compatibility', () => {
  it('does not enforce tool whitelist when sandbox is unset', async () => {
    // Without sandbox, the legacy default-allowed list (Read/Grep/Glob)
    // is the only constraint and unknown tools just get passed to
    // claude verbatim. The gate doesn't fire.
    try {
      await runClaude({ prompt: 'noop', allowedTools: ['Read', 'WebFetch'], timeoutMs: 1000 });
    } catch (e) {
      const msg = (e as Error).message;
      // Should NOT see the sandbox rejection message.
      expect(msg).not.toMatch(/not in safe set/i);
    }
  });
});
