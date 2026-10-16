// One readable stdout line per meaningful gateway fact, for
// `wiki-workspace agents logs`. Before it, the console said only that a run
// failed: a refused capability, a 401 from a token mismatch, which role ran or
// degraded, and the tools a role called were visible nowhere but in the
// manager's panels — and not at all when the manager could not reach us.
//
// GATEWAY_TRACE: `on` (default), `tools` (adds every tool start/finish) or
// `off`. Never logs a token, a prompt or a tool's content.

const SILENT = new Set(['heartbeat', 'assistant_delta', 'progress']);
const TOOL_EVENTS = new Set(['tool_started', 'tool_finished']);

export function gatewayTraceMode(env = process.env) {
  const value = String(env.GATEWAY_TRACE ?? 'on').trim().toLowerCase();
  if (/^(0|off|false|no|none)$/.test(value)) return 'off';
  return value === 'tools' ? 'tools' : 'on';
}

function clip(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function detail(event) {
  switch (event.type) {
    case 'subagent_started':
    case 'subagent_finished':
      return `role=${event.subagent ?? '?'}`;
    case 'phase_started':
    case 'phase_finished':
      return [`phase=${event.phase ?? '?'}`, event.role ? `role=${event.role}` : '',
        Number.isFinite(event.durationMs) ? `${Math.round(event.durationMs / 1000)}s` : '',
        Number.isFinite(event.tools) ? `tools=${event.tools}` : '',
        Number.isFinite(event.modelCalls) ? `modelCalls=${event.modelCalls}` : ''].filter(Boolean).join(' ');
    case 'degraded':
      return [event.capability ?? event.role ?? event.scope ?? '', clip(event.cause ?? event.reason ?? event.message, 500),
        event.fallback ? `(fallback: ${clip(event.fallback, 160)})` : ''].filter(Boolean).join(' — ');
    case 'finding':
      return [event.role, event.severity, event.category, event.path, clip(event.summary, 200)].filter(Boolean).join(' ');
    case 'tool_started':
    case 'tool_finished':
      return String(event.tool ?? '');
    case 'run_failed':
      return clip(event.error, 800);
    case 'message':
      return `(${String(event.content ?? '').length} chars)`;
    case 'maintenance_action':
      return `${event.action ?? '?'} target=${event.target ?? '-'}`;
    case 'maintenance_result':
      return `${event.action ?? '?'} target=${event.target ?? '-'} status=${event.status ?? '?'}${event.error ? ` — ${clip(event.error, 500)}` : ''}`;
    case 'approval_required':
      return clip(event.reason, 200);
    default:
      return clip(event.message ?? event.reason ?? event.status ?? '', 300);
  }
}

export function formatGatewayEvent(event, { mode = 'on', run = {} } = {}) {
  if (!event || mode === 'off' || SILENT.has(event.type)) return null;
  if (TOOL_EVENTS.has(event.type) && mode !== 'tools') return null;
  const failed = event.type === 'run_failed' || (event.type === 'maintenance_result' && event.status === 'failed');
  const level = failed ? 'ERROR' : (event.type === 'degraded' ? 'WARN' : 'INFO');
  const scope = [`run=${event.runId ?? run.runId ?? '?'}`, run.capability ? `cap=${run.capability}` : '',
    run.workspace ? `ws=${run.workspace}` : ''].filter(Boolean).join(' ');
  const text = detail(event);
  return `${event.ts ?? new Date().toISOString()} ${level.padEnd(5)} ${scope} ${event.type}${text ? ` ${text}` : ''}`;
}

/**
 * Rate-limited warning: a manager re-probing /health every scan with a wrong
 * token would otherwise write one line per probe. One line per key and window,
 * with the count of repeats it absorbed.
 */
export function createRateLimitedWarn({ windowMs = 60_000, now = () => Date.now(), write = (line) => console.warn(line) } = {}) {
  const last = new Map();
  return (key, line) => {
    const entry = last.get(key);
    const at = now();
    if (entry && at - entry.at < windowMs) {
      entry.suppressed += 1;
      return;
    }
    const suffix = entry?.suppressed ? ` (+${entry.suppressed} similar in the last ${Math.round(windowMs / 1000)}s)` : '';
    last.set(key, { at, suppressed: 0 });
    write(`${new Date(at).toISOString()} WARN  ${line}${suffix}`);
  };
}
