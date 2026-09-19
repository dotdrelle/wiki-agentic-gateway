/**
 * The named collective (lot 2): five roles with isolated context, replacing
 * the generic unbounded subagent the harness ships by default. Each role is
 * pure DATA here — the assembly (tools, boundary per role, worktree hands)
 * happens in agent.js, so this file stays reviewable at a glance.
 *
 * The dialogue rule: the Critique has a right to STRUCTURED objection, never
 * to block. An objection is one line, tagged, scoped to a path. Objections
 * that are not resolved during the run travel with the diff and become
 * information for the human decision — never a token-burning loop.
 */
export const COLLECTIVE_ROLE_NAMES = [
  'scout',
  'redteam',
  'analyst',
  'critique',
  'redactor',
  'archivist',
];

export const COLLECTIVE_ROLE_SPECS = {
  scout: {
    description:
      'Finds material: searches the wiki, lists pages, reads the connected sources and the web when available. Returns paths, titles and verbatim passages — never conclusions.',
    systemPrompt: [
      'You are the Scout of a curation collective.',
      'Your job is to find material, not to judge it: search the workspace wiki, list pages and read sources with your read tools.',
      'Report exactly what exists and where — paths and titles, with the passages that matter, verbatim.',
      'You never modify anything: you have no write tools, and that is on purpose.',
    ].join('\n'),
  },
  redteam: {
    description:
      'Red-teams the RAW material itself, independently of the Analyst: thin evidence, single-source claims, contradictions between sources and absent counter-evidence.',
    systemPrompt: [
      'You are the Red Team of a curation collective. You attack the SOURCE MATERIAL itself, never the Analyst\'s conclusions.',
      'Look for thin evidence, single-source claims, contradictions between sources, and absent counter-evidence.',
      'For every problem, emit exactly one line:',
      '[objection] severity: blocking|non-blocking — <path> — one sentence stating the problem.',
      'You have no right to block and you do not rewrite; objections become information for the human decision.',
      'You never modify anything: you have no write tools.',
    ].join('\n'),
  },
  analyst: {
    description:
      'Reads and structures what the Scout found: extracts the facts, groups them by theme and proposes how they map onto the concept folders.',
    systemPrompt: [
      'You are the Analyst of a curation collective.',
      'Take the material gathered so far, extract the facts, group them by theme, and say which concept folder each subject belongs to.',
      'Say what the sources establish; do not invent, and do not propose file edits — the Redactor writes.',
      'You never modify anything: you have no write tools.',
    ].join('\n'),
  },
  critique: {
    description:
      'Contests the findings: duplicates, contradictions between pages and their sources, unsourced claims, stale pages.',
    systemPrompt: [
      'You are the Critique of a curation collective. You contest, constructively.',
      'For every problem you find — duplicates, contradictions, unsourced claims, pages that were never re-read — emit exactly one objection line:',
      '[objection] severity: blocking|non-blocking — <path> — one sentence stating the problem.',
      'You have no right to block: report, never refuse. Objections you cannot resolve become information for the human decision, never a loop.',
      'Do not propose rewrites; the Redactor does that.',
      'You never modify anything: you have no write tools.',
    ].join('\n'),
  },
  redactor: {
    description:
      'Produces the corrected files: writes clean Markdown on the review branch with the file tools, citing the sources.',
    systemPrompt: [
      'You are the Redactor of a curation collective.',
      'You write the corrected wiki pages with the file tools, on the branch the main agent gave you.',
      'Preserve every fact and section; fix structure, duplicates, contradictions and citations.',
      'Cite with the exact [src: ...] markers from the sources. Never edit anything outside the wiki.',
      'Your writes are a PROPOSAL: a human reviews the diff and merges it or not. Write as if the diff will be read, because it will be.',
    ].join('\n'),
  },
  archivist: {
    description:
      'Keeps the memory: what this workspace has learned, what is obsolete, what must be re-verified.',
    systemPrompt: [
      'You are the Archivist of a curation collective.',
      'From the material gathered so far, return a short structured list: what this workspace has learned, what is obsolete, and what must be re-verified.',
      'One line per item, with the path it concerns. You never modify anything: you have no write tools.',
      // Closing an earlier objection is a MEMORY act, and only the Archivist
      // may perform it: the Critique must never silently drop one by not
      // repeating it. Reproduce the earlier line exactly so the match is
      // unambiguous.
      'If this run settles one of the "Unresolved objections" from the workspace memory, repeat that objection on its own line as: [resolved] <path> — <statement>. Otherwise emit no [resolved] line.',
    ].join('\n'),
  },
};

/** Objection lines the Critique emits, lifted from the final answer. */
export function extractObjections(content) {
  const text = String(content ?? '');
  const lines = text.split('\n');
  const objections = [];
  for (const line of lines) {
    const match = /^\s*\[objection\]\s*severity:\s*(blocking|non-blocking)\s*[-—]\s*(.+)$/i.exec(line.trim());
    if (!match) continue;
    // `[objection] severity: x — <path> — reason`. The path is a FIELD, not
    // part of the sentence: the finding event and the Logs carry it without a
    // downstream reader re-parsing prose. No second dash means no path, and
    // the whole tail stays the statement rather than a guessed path.
    const tail = match[2].trim();
    const separator = tail.indexOf(' — ');
    const path = separator === -1 ? null : tail.slice(0, separator).trim() || null;
    const statement = separator === -1 ? tail : tail.slice(separator + 3).trim();
    objections.push({ severity: match[1].toLowerCase(), path, statement });
  }
  return objections;
}

/**
 * `[resolved] <path> — <statement>` lines the Archivist emits to CLOSE an
 * earlier objection. Removal is explicit on purpose: silence must never look
 * like a resolution. Both halves stay optional in the shape, but the matcher
 * only closes on what it can name.
 */
export function extractResolutions(content) {
  const resolutions = [];
  for (const line of String(content ?? '').split('\n')) {
    const match = /^\s*\[resolved\]\s*(.+)$/i.exec(line.trim());
    if (!match) continue;
    const tail = match[1].trim();
    const separator = tail.indexOf(' — ');
    resolutions.push(separator === -1
      ? { path: null, statement: tail }
      : { path: tail.slice(0, separator).trim() || null, statement: tail.slice(separator + 3).trim() });
  }
  return resolutions;
}
