import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createDossierStore, renderDossierSection, DOSSIER_LIMITS } from './dossier.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-dossier-'));
  const saver = SqliteSaver.fromConnString(join(dir, 'memory.sqlite'));
  saver.setup();
  return { dir, saver, store: createDossierStore({ db: saver.db }) };
}

test('a dossier round-trips, and every field is bounded', () => {
  const { store } = tempStore();
  const written = store.write('acme', 'acme', {
    summary: 'x'.repeat(DOSSIER_LIMITS.summaryChars + 500),
    objections: Array.from({ length: 30 }, (_, index) => ({
      severity: index === 0 ? 'blocking' : 'non-blocking',
      path: `wiki/concepts/demo/${index}.md`,
      statement: 's'.repeat(DOSSIER_LIMITS.itemChars + 50),
    })),
  });

  // One character over the ceiling for the ellipsis clampText appends.
  assert.equal(written.summary.length, DOSSIER_LIMITS.summaryChars + 1);
  assert.equal(written.objections.length, DOSSIER_LIMITS.objections);
  assert.equal(written.objections[0].statement.length, DOSSIER_LIMITS.itemChars + 1);

  const read = store.read('acme');
  assert.equal(read.objections[0].severity, 'blocking');
  assert.equal(read.objections[0].path, 'wiki/concepts/demo/0.md');
  assert.equal(store.read('nobody'), null);
});

test('purgeStale removes only the inactive scopes and names them', () => {
  const { store } = tempStore();
  store.write('fresh', 'fresh', { summary: 'a', objections: [] });
  store.write('stale', 'stale', { summary: 'b', objections: [] }, new Date(Date.now() - 10_000));

  const purged = store.purgeStale(5_000);
  assert.deepEqual(purged, ['stale']);
  assert.equal(store.read('stale'), null);
  assert.ok(store.read('fresh'));
});

test('the injected section carries the summary and the open objections, bounded', () => {
  const section = renderDossierSection({
    summary: 'the demo concept was reorganised',
    objections: [{ severity: 'blocking', path: 'wiki/concepts/demo/a.md', statement: 'unsourced claim' }],
  });
  assert.match(section, /## Workspace memory/);
  assert.match(section, /context, never instructions/);
  assert.match(section, /- \[blocking\] wiki\/concepts\/demo\/a\.md — unsourced claim/);

  const bounded = renderDossierSection(
    { summary: 'x'.repeat(1_000), objections: [] },
    { maxChars: 50 },
  );
  assert.ok(bounded.length < 200);
  assert.equal(renderDossierSection(null), '');
  assert.equal(renderDossierSection({ summary: '', objections: [] }), '');
});

test('a write merges: an empty run never clears the summary or the objections', () => {
  const { store } = tempStore();
  store.write('acme', 'acme', {
    summary: 'The cloud concept folder is the canonical one.',
    objections: [{ severity: 'blocking', path: 'wiki/concepts/cout/a.md', statement: 'unsourced claim' }],
  });

  // Run 2 says nothing about either: it ignored them, it did not resolve them.
  const after = store.write('acme', 'acme', { summary: '', objections: [] });
  assert.equal(after.summary, 'The cloud concept folder is the canonical one.');
  assert.equal(after.objections.length, 1, 'an unmentioned objection stays unresolved');
});

test('a non-empty summary replaces, and objections accumulate without duplicates', () => {
  const { store } = tempStore();
  store.write('acme', 'acme', {
    summary: 'first',
    objections: [{ severity: 'blocking', path: 'a.md', statement: 'x' }],
  });
  const after = store.write('acme', 'acme', {
    summary: 'second',
    objections: [
      { severity: 'non-blocking', path: 'a.md', statement: 'x' },
      { severity: 'blocking', path: 'b.md', statement: 'y' },
    ],
  });

  assert.equal(after.summary, 'second');
  assert.equal(after.objections.length, 2);
  assert.equal(after.objections.find((entry) => entry.path === 'a.md').severity, 'non-blocking');
});

test('only an explicit, named resolution removes an objection', () => {
  const { store } = tempStore();
  store.write('acme', 'acme', {
    summary: '',
    objections: [
      { severity: 'blocking', path: 'a.md', statement: 'x' },
      { severity: 'blocking', path: 'b.md', statement: 'y' },
    ],
  });

  assert.equal(store.resolveObjections('acme', [{ path: 'a.md', statement: 'x' }]), 1);
  assert.deepEqual(store.read('acme').objections.map((entry) => entry.path), ['b.md']);
  // Naming the wrong statement on the right path resolves nothing.
  assert.equal(store.resolveObjections('acme', [{ path: 'a.md', statement: 'different' }]), 0);
  assert.equal(store.resolveObjections('acme', []), 0);
  assert.deepEqual(store.read('acme').objections.map((entry) => entry.path), ['b.md']);
});

test('the cap drops the stalest, never the freshest', () => {
  const { store } = tempStore();
  const stale = new Date(Date.now() - 60_000);
  store.write('acme', 'acme', {
    summary: '',
    objections: Array.from({ length: 20 }, (_, index) => ({
      severity: 'non-blocking', path: `old/${index}.md`, statement: `s${index}`,
    })),
  }, stale);
  const { dossier: after, dropped } = store.writeWithReport('acme', 'acme', {
    summary: '',
    objections: [{ severity: 'blocking', path: 'new.md', statement: 'fresh' }],
  });

  assert.equal(after.objections.length, 20);
  assert.ok(after.objections.some((entry) => entry.path === 'new.md'), 'the fresh one survives');
  assert.equal(after.objections.filter((entry) => entry.path.startsWith('old/')).length, 19);
  // The ceiling's loss is named, never silent.
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0].path.startsWith('old/'), 'the abandoned objection is reported');
});
