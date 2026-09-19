import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isValidProcedureName, parseProcedureFile } from './procedures.js';

/*
 Import a procedure from the compatible subset of the Claude/Codex `SKILL.md`
 format. The report is explicit — imported, adapted, refused, with the reason —
 because a procedure that needs a shell, a browser, a secret or a direct write
 must never be imported silently: the operator would discover it only when a
 role tried to use it.

 The importer is pure about the DECISION (`planProcedureImport`); writing is a
 separate, explicit step so the same plan can be previewed.
*/

// A tool whose name carries one of these verbs is asking for something the
// gateway will never hand a role.
const INCOMPATIBLE_TOOL_PATTERN =
  /(?:^|[_-])(?:shell|bash|sh|exec|execute|terminal|browser|playwright|puppeteer|secret|write|edit|delete|remove|move|rename|chmod|upload|publish)(?:[_-]|$)/i;

const SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.js', '.mjs', '.cjs', '.ts', '.py', '.rb', '.ps1']);

function extensionOf(name) {
  const value = String(name ?? '');
  const dot = value.lastIndexOf('.');
  return dot === -1 ? '' : value.slice(dot).toLowerCase();
}

function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

export function planProcedureImport({ skillMarkdown, resources = [] } = {}) {
  const { data } = parseProcedureFile(skillMarkdown);
  const name = String(data.name ?? '').trim();
  if (!isValidProcedureName(name)) {
    return { status: 'refused', reason: 'the procedure must declare a valid `name` (letters, digits, `_`, `-`)' };
  }
  const description = String(data.description ?? '').trim();
  if (!description) {
    return { status: 'refused', reason: 'the procedure must declare a `description`' };
  }
  // Codex/Claude declare `allowed-tools`; the gateway registry calls it `tools`.
  const declaredTools = data.tools != null ? asStringList(data.tools) : asStringList(data['allowed-tools']);
  const incompatible = declaredTools.filter((tool) => INCOMPATIBLE_TOOL_PATTERN.test(tool));
  if (incompatible.length > 0) {
    return { status: 'refused', reason: `requires unsupported tool(s): ${incompatible.join(', ')}` };
  }
  const scripts = resources.map(String).filter((resource) => SCRIPT_EXTENSIONS.has(extensionOf(resource)));
  if (scripts.length > 0) {
    return { status: 'refused', reason: `ships executable resource(s): ${scripts.join(', ')}` };
  }

  const roles = asStringList(data.roles);
  const notes = [];
  if (roles.length === 0) notes.push('no `roles` declared: the procedure is imported but offered to none until a role is named');
  if (data.tools == null && data['allowed-tools'] != null) notes.push('`allowed-tools` mapped to `tools`');

  const entry = {
    name,
    description,
    roles,
    tools: declaredTools,
    ...(data.version != null ? { version: String(data.version) } : {}),
    ...(data.license != null ? { license: String(data.license) } : {}),
    ...(data.source != null ? { source: String(data.source) } : {}),
    ...(data.risk != null ? { risk: String(data.risk) } : {}),
    resources: resources.map(String),
  };
  // `adapted` when the importer had to normalize something, `imported` when the
  // file was already in the registry's shape.
  const adapted = notes.length > 0;
  return { status: adapted ? 'adapted' : 'imported', entry, notes };
}

export function formatProcedureFile(entry) {
  const frontmatter = {
    name: entry.name,
    description: entry.description,
    roles: entry.roles ?? [],
    tools: entry.tools ?? [],
    ...(entry.version ? { version: entry.version } : {}),
    ...(entry.license ? { license: entry.license } : {}),
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.risk ? { risk: entry.risk } : {}),
    ...(Array.isArray(entry.resources) && entry.resources.length > 0 ? { resources: entry.resources } : {}),
  };
  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n\n${String(entry.body ?? '').trim()}\n`;
}

/** Writes a planned import under `<scopeDir>/<name>/SKILL.md`. Refuses traversal. */
export function writeImportedProcedure({ scopeDir, plan, body = '' }) {
  if (!plan || plan.status === 'refused') {
    return { error: plan?.reason ?? 'nothing to write' };
  }
  if (!isValidProcedureName(plan.entry?.name)) {
    return { error: `invalid procedure name "${plan.entry?.name}"` };
  }
  try {
    const dir = join(String(scopeDir), plan.entry.name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'SKILL.md');
    writeFileSync(path, formatProcedureFile({ ...plan.entry, body }));
    return { path };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
