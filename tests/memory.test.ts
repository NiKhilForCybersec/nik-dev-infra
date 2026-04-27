/* Memory layer smoke tests — L0 findings, L1b facts, L5 register,
 * code_files cache. Each test relies on the sandbox DATA_DIR set up in
 * tests/setup.ts so we don't poison the live database.
 *
 * Hard-path: tests assert BOTH the happy path AND at least one edge
 * case (collision, empty payload, null fields).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetTables,
  addFact,
  entities,
  factsByPredicate,
  getCodeFile,
  query,
  recordCodeFileParse,
  recordCodeFileIntent,
  recordFinding,
  recordRun,
  registerEntity,
} from '../src/server/memory.ts';

beforeEach(() => {
  _resetTables();
});

describe('register (L5)', () => {
  it('upserts an entity by URN', () => {
    registerEntity({ urn: 'screen:Home', kind: 'screen', label: 'HomeScreen', file: 'web/src/screens/HomeScreen.tsx', agent: 'test' });
    registerEntity({ urn: 'screen:Home', kind: 'screen', label: 'HomeScreen', file: 'web/src/screens/HomeScreen.tsx', agent: 'test', confidence: 0.5 });
    const all = entities({ kind: 'screen' });
    expect(all).toHaveLength(1);
    expect(all[0]!.confidence).toBe(0.5);             // upsert kept the latest write
  });

  it('defaults confidence to 1.0 (hard-path: agents must opt out)', () => {
    registerEntity({ urn: 'screen:Foo', kind: 'screen', label: 'FooScreen', agent: 'test' });
    const e = entities({ kind: 'screen' })[0]!;
    expect(e.confidence).toBe(1.0);
  });

  it('returns empty array when no entities of a kind exist', () => {
    expect(entities({ kind: 'nonexistent' })).toEqual([]);
  });
});

describe('facts (L1b)', () => {
  it('addFact stores a triple with evidence', () => {
    addFact({ agent: 'test', subject: 'screen:Home', predicate: 'reads', object: 'op:profile.get', evidence: ['file:1'] });
    const reads = factsByPredicate('reads');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.subject).toBe('screen:Home');
    expect(reads[0]!.object).toBe('op:profile.get');
  });

  it('factsByPredicate isolates by predicate (no cross-leak)', () => {
    addFact({ agent: 'test', subject: 'a', predicate: 'reads', object: 'b', evidence: ['x'] });
    addFact({ agent: 'test', subject: 'a', predicate: 'writes', object: 'b', evidence: ['x'] });
    expect(factsByPredicate('reads')).toHaveLength(1);
    expect(factsByPredicate('writes')).toHaveLength(1);
  });
});

describe('findings (L0)', () => {
  it('recordFinding persists to SQLite (queryable via raw query)', () => {
    recordFinding({
      id: 'f-1',
      agent: 'test',
      kind: 'test:hello',
      at: 1_000_000,
      severity: 'info',
      summary: 'hello',
    });
    const rows = query<{ id: string; summary: string }>('SELECT id, summary FROM findings WHERE id = ?', ['f-1']);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe('hello');
  });

  it('INSERT OR IGNORE — duplicate ids are no-ops, not errors', () => {
    recordFinding({ id: 'dup', agent: 'a', kind: 'k', at: 1, severity: 'info', summary: 'first' });
    recordFinding({ id: 'dup', agent: 'a', kind: 'k', at: 2, severity: 'info', summary: 'second' });
    const rows = query<{ summary: string }>('SELECT summary FROM findings WHERE id = ?', ['dup']);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe('first');           // first write wins; duplicate ignored
  });
});

describe('agent_runs (L7)', () => {
  it('recordRun persists durations + ok flag', () => {
    recordRun({ agent: 'a1', startedAt: 100, durationMs: 500, ok: true, findingCount: 3 });
    recordRun({ agent: 'a1', startedAt: 200, durationMs: 600, ok: false, findingCount: 0, error: 'boom' });
    const rows = query<{ ok: number; duration_ms: number; error: string | null }>('SELECT ok, duration_ms, error FROM agent_runs WHERE agent = ? ORDER BY started_at', ['a1']);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.ok).toBe(1);
    expect(rows[1]!.error).toBe('boom');
  });
});

describe('code_files cache (knowledge-graph)', () => {
  it('recordCodeFileParse + getCodeFile round-trip', () => {
    recordCodeFileParse('web/src/foo.ts', 'sha-abc', 1234567890);
    const r = getCodeFile('web/src/foo.ts');
    expect(r).not.toBeNull();
    expect(r!.sha256).toBe('sha-abc');
    expect(r!.parsed_at).toBe(1234567890);
    expect(r!.intent_summary).toBeNull();
  });

  it('recordCodeFileIntent updates intent without touching parse fields', () => {
    recordCodeFileParse('web/src/foo.ts', 'sha-abc', 100);
    recordCodeFileIntent('web/src/foo.ts', '{"shape":"A","purpose":"test module"}', 200);
    const r = getCodeFile('web/src/foo.ts')!;
    expect(r.sha256).toBe('sha-abc');                  // unchanged
    expect(r.parsed_at).toBe(100);                     // unchanged
    expect(r.intent_summary).toContain('purpose');
    expect(r.intent_at).toBe(200);
  });

  it('returns null for unknown paths', () => {
    expect(getCodeFile('does/not/exist.ts')).toBeNull();
  });

  it('upsert: re-parsing same path replaces sha + parsed_at, keeps intent', () => {
    recordCodeFileParse('foo.ts', 'sha-1', 100);
    recordCodeFileIntent('foo.ts', 'INTENT', 150);
    recordCodeFileParse('foo.ts', 'sha-2', 200);
    const r = getCodeFile('foo.ts')!;
    expect(r.sha256).toBe('sha-2');
    expect(r.parsed_at).toBe(200);
    expect(r.intent_summary).toBe('INTENT');           // intent preserved through re-parse (sha changed but intent is independent)
  });
});

describe('query (raw SQL)', () => {
  it('returns parameterized rows', () => {
    recordFinding({ id: 'a', agent: 'x', kind: 'k', at: 1, severity: 'info', summary: 'one' });
    recordFinding({ id: 'b', agent: 'y', kind: 'k', at: 2, severity: 'warn', summary: 'two' });
    const rows = query<{ id: string }>('SELECT id FROM findings WHERE agent = ?', ['y']);
    expect(rows).toEqual([{ id: 'b' }]);
  });

  it('returns empty array for queries with no matches', () => {
    expect(query('SELECT 1 FROM findings WHERE id = ?', ['nope'])).toEqual([]);
  });
});
