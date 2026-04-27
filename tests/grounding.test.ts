/* Grounding builders — verify the cross-reference pulls the right
 * shape of data from the knowledge graph and degrades cleanly when
 * pieces are missing.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { _resetTables, addFact, recordCodeFileIntent, recordCodeFileParse, registerEntity } from '../src/server/memory.ts';
import {
  buildFileGrounding,
  buildProjectGrounding,
  renderFileGrounding,
  renderProjectGrounding,
} from '../src/server/grounding.ts';

beforeEach(() => {
  _resetTables();
});

describe('buildFileGrounding', () => {
  it('returns empty grounding for unknown fileRef', () => {
    expect(buildFileGrounding(undefined).populated).toBe(false);
    expect(buildFileGrounding('does/not/exist.ts').populated).toBe(false);
  });

  it('populates intent block from a Shape A intent_summary', () => {
    recordCodeFileParse('foo.ts', 'sha', 100);
    recordCodeFileIntent('foo.ts', JSON.stringify({
      shape: 'A',
      purpose: 'Does the thing.',
      usedBy: 'screens',
      dependsOn: 'zod',
      fragileWhen: 'no input',
    }), 200);
    const g = buildFileGrounding('foo.ts');
    expect(g.populated).toBe(true);
    expect(g.intentBlock).toContain('Does the thing.');
    expect(g.intentBlock).toContain('zod');
  });

  it('handles Shape B (deferred) intent', () => {
    recordCodeFileParse('foo.ts', 'sha', 100);
    recordCodeFileIntent('foo.ts', JSON.stringify({ shape: 'B', deferred: 'too small' }), 200);
    const g = buildFileGrounding('foo.ts');
    expect(g.intentBlock).toContain('deferred');
    expect(g.intentBlock).toContain('too small');
  });

  it('exports block lists registered functions/classes', () => {
    registerEntity({ urn: 'function:foo.ts:bar', kind: 'function', label: 'bar', file: 'foo.ts', agent: 'codebase-graph' });
    registerEntity({ urn: 'class:foo.ts:Baz', kind: 'class', label: 'Baz', file: 'foo.ts', agent: 'codebase-graph' });
    const g = buildFileGrounding('foo.ts');
    expect(g.exportsBlock).toContain('function bar');
    expect(g.exportsBlock).toContain('class Baz');
  });

  it('imports block separates internal from external', () => {
    addFact({ agent: 'codebase-graph', subject: 'module:foo.ts', predicate: 'imports', object: 'module:bar.ts', evidence: ['foo.ts:1'] });
    addFact({ agent: 'codebase-graph', subject: 'module:foo.ts', predicate: 'depends_on', object: 'package:zod', evidence: ['foo.ts:2'] });
    const g = buildFileGrounding('foo.ts');
    expect(g.importsBlock).toContain('Internal modules');
    expect(g.importsBlock).toContain('bar.ts');
    expect(g.importsBlock).toContain('External packages');
    expect(g.importsBlock).toContain('zod');
  });

  it('dependents block lists modules that import this file', () => {
    addFact({ agent: 'codebase-graph', subject: 'module:caller.ts', predicate: 'imports', object: 'module:foo.ts', evidence: ['caller.ts:1'] });
    const g = buildFileGrounding('foo.ts');
    expect(g.dependentsBlock).toContain('caller.ts');
  });

  it('renderFileGrounding returns empty string when nothing populated', () => {
    expect(renderFileGrounding(buildFileGrounding(undefined))).toBe('');
  });

  it('renderFileGrounding includes hard-path framing when populated', () => {
    registerEntity({ urn: 'function:foo.ts:bar', kind: 'function', label: 'bar', file: 'foo.ts', agent: 'codebase-graph' });
    const out = renderFileGrounding(buildFileGrounding('foo.ts'));
    expect(out).toMatch(/authoritative for STRUCTURE/);
    expect(out).toContain('INTENT');
  });
});

describe('buildProjectGrounding', () => {
  it('reports zero totals on cold-start repo', () => {
    const g = buildProjectGrounding();
    expect(g.populated).toBe(false);
    expect(g.totals.modules).toBe(0);
  });

  it('counts modules + functions + classes + packages + intents', () => {
    registerEntity({ urn: 'module:a.ts', kind: 'module', label: 'a.ts', file: 'a.ts', agent: 'codebase-graph' });
    registerEntity({ urn: 'module:b.ts', kind: 'module', label: 'b.ts', file: 'b.ts', agent: 'codebase-graph' });
    registerEntity({ urn: 'function:a.ts:foo', kind: 'function', label: 'foo', file: 'a.ts', agent: 'codebase-graph' });
    registerEntity({ urn: 'class:a.ts:Bar', kind: 'class', label: 'Bar', file: 'a.ts', agent: 'codebase-graph' });
    registerEntity({ urn: 'package:zod', kind: 'package', label: 'zod', agent: 'codebase-graph' });
    recordCodeFileParse('a.ts', 'sha-a', 100);
    recordCodeFileIntent('a.ts', JSON.stringify({ shape: 'A', purpose: 'whatever' }), 100);

    const g = buildProjectGrounding();
    expect(g.populated).toBe(true);
    expect(g.totals).toEqual({ modules: 2, functions: 1, classes: 1, packages: 1, intents: 1 });
    expect(g.topIntents).toHaveLength(1);
    expect(g.topIntents[0]!.purpose).toBe('whatever');
  });

  it('renderProjectGrounding includes scale + verifies framing', () => {
    registerEntity({ urn: 'module:a.ts', kind: 'module', label: 'a.ts', file: 'a.ts', agent: 'codebase-graph' });
    const out = renderProjectGrounding(buildProjectGrounding());
    expect(out).toContain('Codebase scale');
    expect(out).toMatch(/authoritative for STRUCTURE/);
  });
});
