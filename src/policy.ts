import { isAbsolute, relative, resolve } from 'node:path';
import type { Config } from './config.js';

const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead', 'Task', 'TaskOutput',
]);
const FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export class Policy {
  constructor(private agentHome: string, private bashAllowlist: RegExp[]) {}

  static fromConfig(cfg: Config): Policy {
    return new Policy(cfg.agentHome, cfg.bashAllowlist.map((s) => new RegExp(s)));
  }

  isSafe(toolName: string, input: Record<string, unknown>): boolean {
    if (READ_ONLY_TOOLS.has(toolName)) return true;
    if (toolName.startsWith('mcp__runtime__')) return true;
    if (FILE_EDIT_TOOLS.has(toolName)) {
      const p = String(input.file_path ?? input.notebook_path ?? '');
      return p !== '' && isInside(this.agentHome, p);
    }
    if (toolName === 'Bash') {
      const cmd = String(input.command ?? '');
      // shell chaining escapes the allowlisted prefix — reject compound commands
      if (/[;&|`$(]/.test(cmd)) return false;
      return this.bashAllowlist.some((r) => r.test(cmd));
    }
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
