import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemBackend } from 'deepagents';
import {
  WorktreeUnavailableError,
  confineForWrite,
  confinePath,
  createConfinedBackend,
  createWorktree,
  pruneStaleWorktrees,
  removeWorktree,
  worktreeChanges,
  worktreeDiff,
  worktreeProposalTooLarge,
} from './worktree.js';

function gitRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'gateway-wt-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  return root;
}

test('createWorktree makes a branch, records edits, and diffs against HEAD', async () => {
  const root = gitRepo({ 'wiki/concepts/demo/a.md': '# A\nold line\n' });
  const runId = 'gateway-1';
  try {
    const worktree = await createWorktree({ workspaceRoot: root, runId });
    assert.ok(existsSync(join(worktree.path, 'wiki', 'concepts', 'demo', 'a.md')));

    writeFileSync(join(worktree.path, 'wiki', 'concepts', 'demo', 'a.md'), '# A\nnew line\n');
    const changes = await worktreeChanges({ worktreePath: worktree.path });
    assert.deepEqual(changes.map((entry) => entry.path), ['wiki/concepts/demo/a.md']);

    const diff = await worktreeDiff({ worktreePath: worktree.path });
    assert.match(diff, /\+new line/);
    assert.match(diff, /-old line/);

    // The main tree is untouched: the proposal has not been merged.
    const mainContent = execFileSync('git', ['show', 'HEAD:wiki/concepts/demo/a.md'], { cwd: root }).toString('utf8');
    assert.match(mainContent, /old line/);

    await removeWorktree({ workspaceRoot: root, worktreePath: worktree.path, branch: worktree.branch });
    assert.ok(!existsSync(worktree.path));
    const branches = execFileSync('git', ['branch'], { cwd: root }).toString('utf8');
    assert.ok(!branches.includes(`agent/${runId}`));
  } finally {
    execFileSync('git', ['worktree', 'prune'], { cwd: root }).toString('utf8');
  }
});

test('createWorktree refuses a directory without git', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'gateway-wt-plain-'));
  await assert.rejects(
    createWorktree({ workspaceRoot: plain, runId: 'gateway-x' }),
    (error) => error instanceof WorktreeUnavailableError && /no git repository/.test(error.message),
  );
});

test('confinePath rejects escapes before they reach the backend', () => {
  const root = '/wt';
  assert.equal(confinePath(root, 'wiki/a.md'), '/wt/wiki/a.md');
  assert.throws(() => confinePath(root, '../echappe.md'), /escapes the worktree/);
  assert.throws(() => confinePath(root, '/etc/passwd'), /escapes the worktree/);
  assert.throws(() => confinePath(root, 'wiki/../../secret.md'), /escapes the worktree/);
});

test('confineForWrite rejects a symlinked parent pointing outside the root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-wt-confine-'));
  const outside = mkdtempSync(join(tmpdir(), 'gateway-wt-outside-'));
  mkdirSync(join(root, 'wiki'));
  symlinkSync(outside, join(root, 'wiki', 'link'));
  await assert.rejects(
    confineForWrite(root, 'wiki/link/escaped.md'),
    /resolves outside the worktree/,
  );
  // The lexical check still passes for an in-tree path.
  const ok = await confineForWrite(root, 'wiki/normal.md');
  assert.equal(ok, join(root, 'wiki', 'normal.md'));
});

test('the confined backend refuses writes that escape the worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-wt-backend-'));
  const backend = createConfinedBackend(
    new FilesystemBackend({ rootDir: root, virtualMode: true }),
    { root },
  );
  await assert.rejects(
    backend.write('../echappe.md', 'nope'),
    /escapes|outside the worktree/,
  );
  await assert.rejects(backend.delete('../echappe.md'), /escapes|outside the worktree/);
  const written = await backend.write('wiki/x.md', '# X');
  assert.ok(!('error' in written) || written.error === undefined);
  assert.ok(existsSync(join(root, 'wiki', 'x.md')));
});

test('pruneStaleWorktrees removes abandoned worktrees past the age ceiling', async () => {
  const root = gitRepo({ 'wiki/x.md': '# X' });
  const workspacesRoot = join(root, '..');
  const fresh = await createWorktree({ workspaceRoot: root, runId: 'fresh-run' });
  const stale = await createWorktree({ workspaceRoot: root, runId: 'stale-run' });
  try {
    // Age the stale worktree's directory beyond the ceiling.
    const old = Date.now() - (7 * 24 * 3600 * 1000 + 60_000);
    const staleDir = stale.path;
    execFileSync('touch', ['-t', new Date(old).toISOString().replace(/[-:T]/g, '').slice(0, 12), staleDir]);

    const { pruned } = await pruneStaleWorktrees({ workspacesRoot });
    assert.ok(pruned.some((entry) => entry.runId === 'stale-run'), 'the stale worktree is pruned');
    assert.ok(!pruned.some((entry) => entry.runId === 'fresh-run'), 'the fresh worktree stays');
    assert.ok(!existsSync(stale.path));
    assert.ok(existsSync(fresh.path));
  } finally {
    await removeWorktree({ workspaceRoot: root, worktreePath: fresh.path, branch: fresh.branch }).catch(() => {});
    execFileSync('git', ['worktree', 'prune'], { cwd: root }).toString('utf8');
  }
});

test('worktreeProposalTooLarge refuses unreadable diffs explicitly', () => {
  assert.equal(worktreeProposalTooLarge([], '', { maxFiles: 40, maxDiffChars: 300000 }).oversized, false);
  assert.equal(worktreeProposalTooLarge(new Array(41).fill({}), '', { maxFiles: 40, maxDiffChars: 300000 }).oversized, true);
  assert.equal(worktreeProposalTooLarge([{}], 'x'.repeat(300001), { maxFiles: 40, maxDiffChars: 300000 }).oversized, true);
  const bounds = worktreeProposalTooLarge([{}, {}], 'small', { maxFiles: 40, maxDiffChars: 300000 });
  assert.equal(bounds.oversized, false);
  assert.equal(bounds.files, 2);
});
