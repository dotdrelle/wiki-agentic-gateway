#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { startGateway } from '../src/server.js';
import { loadGatewayConfig } from '../src/config.js';
import { planProcedureImport, writeImportedProcedure } from '../src/procedureImporter.js';
import { parseProcedureFile, TEAM_PROCEDURES_DIR } from '../src/procedures.js';

const [command] = process.argv.slice(2);

// `import-procedure` is an operator command, never a server start: it previews
// the Claude/Codex SKILL.md subset import and writes only with --write.
if (command === 'import-procedure') {
  const args = process.argv.slice(3);
  const write = args.includes('--write');
  const dirIndex = args.indexOf('--dir');
  const dir = dirIndex >= 0 ? args[dirIndex + 1] : null;
  const file = args.find((arg) => !arg.startsWith('--') && arg !== dir);
  if (!file || (dirIndex >= 0 && !dir)) {
    console.error('usage: wiki-agentic-gateway import-procedure <SKILL.md> [--write] [--dir <scopeDir>]');
    process.exit(2);
  }

  const path = resolve(file);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // Sibling files are the procedure's resources: a shipped executable is part
  // of the refusal, so it must be listed, not discovered at role time.
  let resources = [];
  try {
    resources = readdirSync(dirname(path))
      .filter((name) => name !== 'SKILL.md' && statSync(join(dirname(path), name)).isFile());
  } catch {
    // Unreadable directory: no resource is silently invented.
  }

  const plan = planProcedureImport({ skillMarkdown: raw, resources });
  if (plan.status === 'refused') {
    console.error(`refused: ${plan.reason}`);
    process.exit(1);
  }
  console.log(`import-procedure: ${plan.status}`);
  console.log(`  name: ${plan.entry.name}`);
  console.log(`  roles: ${plan.entry.roles?.length ? plan.entry.roles.join(', ') : 'none'}`);
  console.log(`  tools: ${plan.entry.tools?.length ? plan.entry.tools.join(', ') : 'none'}`);
  for (const note of plan.notes ?? []) console.log(`  note: ${note}`);
  if (!write) {
    console.log('  preview only: pass --write to install');
    process.exit(0);
  }

  const scopeDir = dir ?? TEAM_PROCEDURES_DIR;
  if (!scopeDir) {
    console.error('no scope directory: pass --dir <scopeDir> or set GATEWAY_PROCEDURES_TEAM_DIR');
    process.exit(1);
  }
  const written = writeImportedProcedure({
    scopeDir,
    plan,
    body: parseProcedureFile(raw).body,
  });
  if (written.error) {
    console.error(`not written: ${written.error}`);
    process.exit(1);
  }
  console.log(`  written: ${written.path}`);
  process.exit(0);
}

const port = Number(process.env.GATEWAY_PORT ?? 7789);
const config = loadGatewayConfig();
const server = startGateway({ port, config });

console.log(`wiki-agentic-gateway listening on ${port}`);
console.log(`  capabilities: ${config.capabilities.map((capability) => capability.name).join(', ') || 'none'}`);
