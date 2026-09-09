import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FilesystemBackend } from 'deepagents';

const execFileAsync = promisify(execFile);

export class WorktreeUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorktreeUnavailableError';
  }
}

export function workspaceRootFor(workspace) {
  const name = String(workspace?.name ?? workspace ?? '').trim();
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new WorktreeUnavailableError(`invalid workspace name for a worktree run: ${JSON.stringify(String(workspace ?? ''))}`);
  }
  return join(process.env.GATEWAY_WORKSPACES_ROOT ?? '/workspaces', name);
}

async function git(args, cwd) {
  return execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
}

/**
 * One objective, one branch: a detached-to-branch git worktree of the
 * workspace, checked out at HEAD. The agent edits files INSIDE this tree;
 * nothing reaches the workspace until a human merges the diff.
 *
 * The worktrees live under the workspace's own `.wiki/agent-worktrees/`
 * (gitignored state), so the same mount every container shares gives the
 * gateway its scratch space without any new volume.
 */
export async function createWorktree({ workspaceRoot, runId }) {
  if (!existsSync(join(workspaceRoot, '.git'))) {
    throw new WorktreeUnavailableError(
      `workspace ${workspaceRoot} has no git repository: worktree runs need the workspace history (git) to propose diffs`,
    );
  }
  const branch = `agent/${runId}`;
  const worktreePath = join(workspaceRoot, '.wiki', 'agent-worktrees', runId);
  if (existsSync(worktreePath)) {
    throw new WorktreeUnavailableError(`worktree already exists for run ${runId}`);
  }
  await mkdir(dirname(worktreePath), { recursive: true });
  try {
    await git(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], workspaceRoot);
  } catch (error) {
    throw new WorktreeUnavailableError(
      `could not create the worktree for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { path: worktreePath, branch };
}

export async function worktreeChanges({ worktreePath }) {
  const { stdout } = await git(['status', '--porcelain', '-uall'], worktreePath);
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const path = line.slice(3).trim();
      return { status: code.trim(), path };
    })
    .filter((entry) => entry.path && !entry.path.startsWith('.wiki/agent-worktrees/'));
}

export async function worktreeDiff({ worktreePath }) {
  const { stdout } = await git(
    ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--unified=3', '--', 'wiki'],
    worktreePath,
  );
  return stdout;
}

export async function worktreeFileContent({ worktreePath, relativePath }) {
  const confined = confinePath(worktreePath, relativePath);
  return readFile(confined, 'utf8');
}

export async function removeWorktree({ workspaceRoot, worktreePath, branch }) {
  try {
    await git(['worktree', 'remove', '--force', worktreePath], workspaceRoot);
  } catch {
    // The worktree metadata may already be gone (hand deletion, crashed run).
  }
  try {
    await git(['branch', '-D', branch], workspaceRoot);
  } catch {
    // An already-merged or never-created branch is not an error here.
  }
}

/**
 * The hands are bounded in TIME too, not only in space: a worktree nobody
 * merges or rejects must not accumulate forever. Startup pruning removes
 * worktrees older than the ceiling (default 7 days), branch included — the
 * review window is the human's, the cleanup is the gateway's.
 */
export const GATEWAY_WORKTREE_MAX_AGE_MS =
  Number.parseInt(process.env.GATEWAY_WORKTREE_MAX_AGE_MS ?? '', 10) || 7 * 24 * 3600 * 1000;

export async function pruneStaleWorktrees({ workspacesRoot }) {
  const pruned = [];
  let entries = [];
  try {
    entries = await readdir(workspacesRoot);
  } catch {
    return { pruned, error: null };
  }
  for (const name of entries) {
    const workspaceRoot = join(workspacesRoot, name);
    const worktreesDir = join(workspaceRoot, '.wiki', 'agent-worktrees');
    let runs = [];
    try {
      runs = await readdir(worktreesDir);
    } catch {
      continue;
    }
    for (const runId of runs) {
      const worktreePath = join(worktreesDir, runId);
      let stats;
      try {
        stats = await stat(worktreePath);
      } catch {
        continue;
      }
      if (Date.now() - stats.mtimeMs <= GATEWAY_WORKTREE_MAX_AGE_MS) continue;
      await removeWorktree({
        workspaceRoot,
        worktreePath,
        branch: `agent/${runId}`,
      }).catch(() => {});
      pruned.push({ workspace: name, runId });
    }
  }
  return { pruned, error: null };
}

export function confinePath(root, input) {
  if (typeof input !== 'string' || input.length === 0) return root;
  const resolved = resolve(root, input);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes the worktree: ${input}`);
  }
  return resolved;
}

// Canonical (realpath) containment for WRITE operations. The lexical check
// alone does not protect against a symlinked parent inside the tree pointing
// outside it: resolve the deepest existing ancestor and verify it is really
// under the worktree's real root. This is the non-negotiable check that must
// move with the backend — without it, "the hands are bounded by the worktree"
// is false.
export async function confineForWrite(root, input) {
  const resolved = confinePath(root, input);
  const realRoot = await realpath(root);
  let parent = dirname(resolved);
  while (!existsSync(parent)) {
    const grand = dirname(parent);
    if (grand === parent) break;
    parent = grand;
  }
  const realParent = await realpath(parent);
  const rel = relative(realRoot, realParent);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path resolves outside the worktree: ${input}`);
  }
  return resolved;
}

/**
 * The filesystem backend the agent gets on a worktree run, wrapped in the
 * canonical-path check. FilesystemBackend's own virtualMode is lexical and
 * library-owned; this wrapper is ours and enforced per operation, reads and
 * writes alike — the frontier must not depend on a library version's default.
 *
 * The inner backend runs in virtualMode: it takes VIRTUAL paths ("/wiki/x.md")
 * rooted at the worktree. The wrapper validates the incoming path against the
 * real root (lexical + canonical for writes), then re-expresses it virtually
 * for the inner call — an absolute host path handed to a virtual backend would
 * be re-rooted and land in the wrong place.
 */
export function createConfinedBackend(inner, { root }) {
  const toVirtual = (input) => {
    const resolved = confinePath(root, input);
    const rel = relative(root, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) return resolved;
    return `/${rel.split(sep).join('/')}`;
  };
  const virtualForWrite = async (input) => {
    const resolved = await confineForWrite(root, input);
    const rel = relative(root, resolved);
    return rel.startsWith('..') || isAbsolute(rel) ? resolved : `/${rel.split(sep).join('/')}`;
  };
  return {
    async ls(dirPath) { return inner.ls(toVirtual(dirPath)); },
    async read(filePath, offset, limit) { return inner.read(toVirtual(filePath), offset, limit); },
    async readRaw(filePath) { return inner.readRaw(toVirtual(filePath)); },
    async write(filePath, content) { return inner.write(await virtualForWrite(filePath), content); },
    async edit(filePath, oldString, newString, replaceAll) {
      return inner.edit(await virtualForWrite(filePath), oldString, newString, replaceAll);
    },
    async delete(filePath) { return inner.delete(await virtualForWrite(filePath)); },
    async grep(pattern, dirPath = '/', glob = null, maxCount = null) {
      return inner.grep(pattern, toVirtual(dirPath), glob, maxCount);
    },
    async ripgrepSearch(pattern, baseFull, includeGlob) {
      return inner.ripgrepSearch(pattern, toVirtual(baseFull), includeGlob);
    },
    async glob(pattern, searchPath = '/') { return inner.glob(pattern, toVirtual(searchPath)); },
    async uploadFiles(files) {
      const confined = files.map((file) => ({ ...file, path: toVirtual(file.path) }));
      return inner.uploadFiles(confined);
    },
    async downloadFiles(paths) {
      return inner.downloadFiles(paths.map((path) => toVirtual(path)));
    },
  };
}

export function createWorktreeBackend({ worktreePath }) {
  return createConfinedBackend(
    new FilesystemBackend({ rootDir: worktreePath, virtualMode: true }),
    { root: worktreePath },
  );
}

/**
 * A diff nobody can read is a diff that never gets merged: refuse explicitly
 * rather than queue a review item no human will open.
 */
export function worktreeProposalTooLarge(changes, diff, limits = {}) {
  const maxFiles = limits.maxFiles ?? 40;
  const maxDiffChars = limits.maxDiffChars ?? 300_000;
  const count = Array.isArray(changes) ? changes.length : 0;
  const diffLength = String(diff ?? '').length;
  return {
    oversized: count > maxFiles || diffLength > maxDiffChars,
    files: count,
    diffChars: diffLength,
    maxFiles,
    maxDiffChars,
  };
}

export { basename, sep };
