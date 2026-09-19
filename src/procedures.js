import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { confineForReadSync } from './worktree.js';

/*
 Gateway PROCEDURES: reusable, role-scoped instructions loaded into a role's
 context. Not "skills" — the product already has those (`.wiki/skills/`,
 `skillCompiler`, `/skills run`): another owner, another format, another
 executor, another trust model. The name collision would be a vocabulary drift.

 Three scopes, in precedence order: base (shipped with the image) → team
 (operator-mounted) → workspace (`.wiki/procedures/`). A later scope WINS a name
 clash, and the shadowed definition is REPORTED — never arbitrated in silence.

 A procedure's required tools are a DECLARATION, and the catalogue only offers a
 procedure whose tools are all inside the role's allow-list: a procedure can
 never widen the frontier.
*/

export const PROCEDURE_SCHEMA_VERSION = 1;
export const PROCEDURE_BODY_MAX = 20_000;

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASE_PROCEDURES_DIR = process.env.GATEWAY_PROCEDURES_BASE_DIR ?? join(HERE, '..', 'procedures');
export const TEAM_PROCEDURES_DIR = process.env.GATEWAY_PROCEDURES_TEAM_DIR ?? null;

export function procedureScopeDirs({
  workspaceRoot = null,
  baseDir = BASE_PROCEDURES_DIR,
  teamDir = TEAM_PROCEDURES_DIR,
} = {}) {
  return [
    ['base', baseDir],
    ['team', teamDir],
    ['workspace', workspaceRoot ? join(workspaceRoot, '.wiki', 'procedures') : null],
  ].filter(([, dir]) => Boolean(dir));
}

// `---\n<yaml>\n---\n<body>` — the Claude/Codex shape, minus the parts we do
// not honour. A file without frontmatter is body-only (no metadata to trust).
export function parseProcedureFile(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(raw ?? ''));
  if (!match) return { data: {}, body: String(raw ?? '') };
  try {
    return { data: parseYaml(match[1]) ?? {}, body: match[2] ?? '' };
  } catch {
    return { data: {}, body: match[2] ?? '' };
  }
}

function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

// A `/`-free, `.`-free identifier: the procedure NAME is a name, and a name
// that can walk a path is a name that should never have been one.
export function isValidProcedureName(name) {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(String(name ?? ''));
}

function toEntry(scope, fallbackName, data, scopeDir, relativePath) {
  return {
    schemaVersion: PROCEDURE_SCHEMA_VERSION,
    scope,
    name: String(data.name ?? fallbackName),
    // The CONTAINMENT ROOT is the scope directory, not the procedure's own
    // directory: a check rooted at the thing it inspects proves nothing when
    // the thing itself is a link. `relativePath` joins them.
    scopeDir,
    relativePath,
    description: String(data.description ?? '').trim(),
    version: data.version != null ? String(data.version) : null,
    license: data.license != null ? String(data.license) : null,
    source: data.source != null ? String(data.source) : null,
    risk: data.risk != null ? String(data.risk) : null,
    roles: asStringList(data.roles),
    tools: asStringList(data.tools),
    resources: asStringList(data.resources),
  };
}

/**
 * Reads every `<scope>/<name>/SKILL.md`, later scopes overriding earlier ones.
 * A missing or unreadable scope is skipped, never fatal: a registry is an
 * observation.
 */
export function loadProcedureRegistry({ workspaceRoot = null, baseDir = BASE_PROCEDURES_DIR, teamDir = TEAM_PROCEDURES_DIR } = {}) {
  const procedures = new Map();
  const conflicts = [];
  const issues = [];
  for (const [scope, dir] of procedureScopeDirs({ workspaceRoot, baseDir, teamDir })) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relativePath = `${entry.name}/SKILL.md`;
      let skillPath;
      try {
        // Confined AT LOAD, not only on the body read: the metadata reaches the
        // catalogue, hence the role's prompt — an unconfined read here leaked a
        // file from outside the registry through the description.
        skillPath = confineForReadSync(dir, relativePath);
      } catch {
        issues.push({ name: entry.name, scope, reason: 'SKILL.md resolves outside the scope root' });
        continue;
      }
      let raw;
      try {
        raw = readFileSync(skillPath, 'utf8');
      } catch {
        continue;
      }
      const { data } = parseProcedureFile(raw);
      const procedure = toEntry(scope, entry.name, data, dir, relativePath);
      if (!isValidProcedureName(procedure.name)) {
        issues.push({ name: procedure.name, scope, reason: 'invalid procedure name' });
        continue;
      }
      if (!procedure.description) issues.push({ name: procedure.name, scope, reason: 'missing description' });
      const prior = procedures.get(procedure.name);
      if (prior) conflicts.push({ name: procedure.name, shadowed: prior.scope, winner: scope });
      procedures.set(procedure.name, procedure);
    }
  }
  return { procedures, conflicts, issues };
}

/**
 * What a role may be TOLD exists: procedures that declare the role AND whose
 * required tools are all inside the role's allow-list. The body is never here —
 * it is fetched on demand through `gateway__read_skill`. The catalog strips the
 * filesystem location: a model has no use for it and no right to it.
 */
export function procedureCatalogue(registry, { role = null, allowedToolNames = [] } = {}) {
  const allowed = new Set(allowedToolNames.map(String));
  return [...registry.procedures.values()]
    .filter((procedure) => role != null && procedure.roles.includes(String(role)))
    .map((procedure) => {
      const missingTools = procedure.tools.filter((tool) => !allowed.has(tool));
      return { procedure, missingTools };
    })
    .filter(({ missingTools }) => missingTools.length === 0)
    .map(({ procedure }) => ({
      name: procedure.name,
      description: procedure.description,
      scope: procedure.scope,
      risk: procedure.risk,
      tools: procedure.tools,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The body, read on demand. Confined to the SCOPE directory by the canonical
 * check — the root is the scope, never the procedure's own (possibly linked)
 * directory, so a symlinked `SKILL.md` cannot serve a file from outside the
 * registry — and bounded so a huge page cannot flood the context. A body is
 * readable only through a role context: the same filter that built the
 * catalogue is replayed here, so a role cannot read what it was not offered.
 */
export async function readProcedureBody(registry, name, { role = null, allowedToolNames = null } = {}) {
  const procedure = registry.procedures.get(String(name));
  if (!procedure) return { error: `unknown procedure "${name}"` };
  // Fail closed: a body is readable only THROUGH a role context. The catalogue
  // hides what a role may not use; the reader must replay the same filter, or
  // the scope stops at the menu and any role reads any body by name.
  if (role == null || !Array.isArray(allowedToolNames)) {
    return { error: 'procedure access requires a role and the run allow-list' };
  }
  const allowed = new Set(allowedToolNames.map(String));
  if (!procedure.roles.includes(String(role)) || procedure.tools.some((tool) => !allowed.has(tool))) {
    return { error: `procedure "${name}" is not available to role "${role}"` };
  }
  try {
    const skillPath = confineForReadSync(procedure.scopeDir, procedure.relativePath);
    const raw = readFileSync(skillPath, 'utf8');
    const { body } = parseProcedureFile(raw);
    const truncated = body.length > PROCEDURE_BODY_MAX;
    return {
      name: procedure.name,
      scope: procedure.scope,
      roles: procedure.roles,
      tools: procedure.tools,
      truncated,
      body: truncated ? `${body.slice(0, PROCEDURE_BODY_MAX)}\n…[truncated]` : body,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The diagnostic view: available, shadowed and malformed procedures. */
export function describeProcedures(registry) {
  return {
    available: [...registry.procedures.values()]
      .map(({ scopeDir, relativePath, ...procedure }) => procedure)
      .sort((a, b) => a.name.localeCompare(b.name)),
    conflicts: [...registry.conflicts],
    issues: [...registry.issues],
  };
}
