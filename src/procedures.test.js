import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  describeProcedures,
  loadProcedureRegistry,
  parseProcedureFile,
  procedureCatalogue,
  readProcedureBody,
} from './procedures.js';
import { formatProcedureFile, planProcedureImport, writeImportedProcedure } from './procedureImporter.js';

function makeProcedure(root, name, frontmatter = '', { body = 'Do the thing.' } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
  return dir;
}

function tempRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('parseProcedureFile splits frontmatter from the body', () => {
  const parsed = parseProcedureFile('---\nname: x\ndescription: y\n---\n\nBODY');
  assert.equal(parsed.data.name, 'x');
  assert.equal(parsed.body.trim(), 'BODY');
  assert.equal(parseProcedureFile('no frontmatter').body, 'no frontmatter');
});

test('later scopes win a name clash, and the shadowing is reported', () => {
  const base = tempRoot('proc-base-');
  const ws = tempRoot('proc-ws-');
  try {
    makeProcedure(base, 'audit-cost', 'name: audit-cost\ndescription: Base\nroles: [critique]');
    makeProcedure(join(ws, '.wiki', 'procedures'), 'audit-cost', 'name: audit-cost\ndescription: Workspace\nroles: [critique]');
    makeProcedure(base, 'bad name', 'name: bad name\ndescription: invalid');

    const registry = loadProcedureRegistry({ baseDir: base, teamDir: null, workspaceRoot: ws });
    assert.equal(registry.procedures.get('audit-cost').scope, 'workspace');
    assert.equal(registry.procedures.get('audit-cost').description, 'Workspace');
    assert.deepEqual(registry.conflicts, [{ name: 'audit-cost', shadowed: 'base', winner: 'workspace' }]);
    assert.ok(registry.issues.some((issue) => /invalid procedure name/.test(issue.reason)));
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('the catalogue offers only a role whose tools it actually has', () => {
  const base = tempRoot('proc-cat-');
  try {
    makeProcedure(base, 'read-cost', 'name: read-cost\ndescription: Read cost\nroles: [critique]\ntools: [wiki__wiki_read_page]');
    makeProcedure(base, 'write-cost', 'name: write-cost\ndescription: Rewrite cost\nroles: [critique]\ntools: [write_file]');
    makeProcedure(base, 'scout-only', 'name: scout-only\ndescription: Scout\nroles: [scout]\ntools: [wiki__wiki_read_page]');
    const registry = loadProcedureRegistry({ baseDir: base, teamDir: null });

    const catalogue = procedureCatalogue(registry, {
      role: 'critique',
      allowedToolNames: ['wiki__wiki_read_page'],
    });
    assert.deepEqual(catalogue.map((entry) => entry.name), ['read-cost']);
    // The catalogue never leaks the filesystem location.
    assert.ok(!('dir' in catalogue[0]));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the body is read on demand, bounded, and cannot escape its directory', async () => {
  const base = tempRoot('proc-body-');
  const outside = tempRoot('proc-out-');
  try {
    makeProcedure(base, 'audit-cost', 'name: audit-cost\ndescription: d\nroles: [critique]', { body: 'STEP 1' });
    const registry = loadProcedureRegistry({ baseDir: base, teamDir: null });

    const read = await readProcedureBody(registry, 'audit-cost');
    assert.equal(read.name, 'audit-cost');
    assert.match(read.body, /STEP 1/);
    assert.deepEqual((await readProcedureBody(registry, 'nope')), { error: 'unknown procedure "nope"' });

    // A SKILL.md symlinked to a file outside the procedure directory is refused.
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: audit-cost\ndescription: d\n---\nSECRET');
    unlinkSync(join(base, 'audit-cost', 'SKILL.md'));
    symlinkSync(join(outside, 'SKILL.md'), join(base, 'audit-cost', 'SKILL.md'));
    const reloaded = loadProcedureRegistry({ baseDir: base, teamDir: null });
    const escaped = await readProcedureBody(reloaded, 'audit-cost');
    assert.match(String(escaped.error ?? ''), /resolves outside the worktree/);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('describeProcedures reports available, shadowed and malformed entries', () => {
  const base = tempRoot('proc-diag-');
  try {
    makeProcedure(base, 'ok', 'name: ok\ndescription: d\nroles: [critique]');
    makeProcedure(base, 'no-desc', 'name: no-desc\nroles: [critique]');
    const report = describeProcedures(loadProcedureRegistry({ baseDir: base, teamDir: null }));
    assert.deepEqual(report.available.map((entry) => entry.name), ['no-desc', 'ok']);
    assert.ok(report.issues.some((issue) => issue.name === 'no-desc' && /description/.test(issue.reason)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── Import ───────────────────────────────────────────────────────────────────

test('a minimal compatible procedure is imported, an incompatible one is refused', () => {
  const ok = planProcedureImport({
    skillMarkdown: '---\nname: audit-cost\ndescription: Audit the cost pages\nroles: [critique]\ntools: [wiki__wiki_read_page]\n---\nBODY',
  });
  assert.equal(ok.status, 'imported');
  assert.equal(ok.entry.name, 'audit-cost');
  assert.deepEqual(ok.entry.tools, ['wiki__wiki_read_page']);

  const shell = planProcedureImport({
    skillMarkdown: '---\nname: crawl\ndescription: Crawl\nroles: [scout]\ntools: [shell_exec]\n---\nBODY',
  });
  assert.equal(shell.status, 'refused');
  assert.match(shell.reason, /unsupported tool/);

  const script = planProcedureImport({
    skillMarkdown: '---\nname: scripted\ndescription: d\n---\nBODY',
    resources: ['run.sh'],
  });
  assert.equal(script.status, 'refused');
  assert.match(script.reason, /executable resource/);
});

test('a Codex `allowed-tools` field is adapted, and a missing role is noted', () => {
  const plan = planProcedureImport({
    skillMarkdown: '---\nname: audit-cost\ndescription: d\nallowed-tools: [wiki__wiki_read_page]\n---\nBODY',
  });
  assert.equal(plan.status, 'adapted');
  assert.deepEqual(plan.entry.tools, ['wiki__wiki_read_page']);
  assert.deepEqual(plan.entry.roles, []);
  assert.ok(plan.notes.some((note) => /no `roles` declared/.test(note)));
  assert.ok(plan.notes.some((note) => /allowed-tools/.test(note)));
});

test('a written procedure round-trips through the registry', () => {
  const base = tempRoot('proc-write-');
  try {
    const plan = planProcedureImport({
      skillMarkdown: '---\nname: audit-cost\ndescription: d\nroles: [critique]\n---\nDo it.',
    });
    const written = writeImportedProcedure({ scopeDir: base, plan, body: 'Do it.' });
    assert.ok(written.path && existsSync(written.path));
    assert.match(formatProcedureFile({ ...plan.entry, body: 'Do it.' }), /"name": "audit-cost"/);
    const registry = loadProcedureRegistry({ baseDir: base, teamDir: null });
    assert.ok(registry.procedures.has('audit-cost'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
