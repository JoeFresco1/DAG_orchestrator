#!/usr/bin/env node
// Install the agent instructions where each tool looks for them, so any agent
// CLI (or a teammate's) can drive this orchestrator without being told how.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillFile = join(here, 'SKILL.md');
const TOOLS = ['opencode', 'claude', 'cursor', 'codex', 'copilot'];

const FRONTMATTER = /^---[\s\S]*?---\s*/;
const MARKER_START = '<!-- dag-orchestrator:start -->';
const MARKER_END = '<!-- dag-orchestrator:end -->';

const body = () => readFileSync(skillFile, 'utf8').replace(FRONTMATTER, '').trim();

function skillTarget(tool, projectDir) {
  const project = resolve(projectDir);
  switch (tool) {
    case 'opencode':
      return {
        tool,
        path: join(homedir(), '.config', 'opencode', 'skills', 'dag-orchestrator', 'SKILL.md'),
        scope: 'user',
      };
    case 'claude':
      return {
        tool,
        path: join(project, '.claude', 'skills', 'dag-orchestrator', 'SKILL.md'),
        scope: 'project',
      };
    case 'cursor':
      return { tool, path: join(project, '.cursor', 'rules', 'dag-orchestrator.mdc'), scope: 'project' };
    case 'codex':
      return { tool, path: join(project, 'AGENTS.md'), scope: 'project' };
    case 'copilot':
      return { tool, path: join(project, '.github', 'copilot-instructions.md'), scope: 'project' };
    default:
      throw new Error(`unknown tool: ${tool} (expected one of ${TOOLS.join(', ')}, or "all")`);
  }
}

function render(tool) {
  if (tool === 'cursor') {
    return `---\ndescription: Plan and execute work as a dependency graph with the dag CLI\nglobs:\nalwaysApply: false\n---\n\n${body()}\n`;
  }
  if (tool === 'codex' || tool === 'copilot') {
    return `${MARKER_START}\n# DAG Orchestrator (agent instructions)\n\n${body()}\n${MARKER_END}\n`;
  }
  // opencode / claude: their own skill file, with the tool's frontmatter.
  return readFileSync(skillFile, 'utf8');
}

export function installSkill(tool, projectDir) {
  const target = skillTarget(tool, projectDir);
  mkdirSync(dirname(target.path), { recursive: true });
  const content = render(tool);

  if (tool === 'codex' || tool === 'copilot') {
    // Shared files: replace our marked section in place, never the whole file.
    const existing = existsSync(target.path) ? readFileSync(target.path, 'utf8') : '';
    const start = existing.indexOf(MARKER_START);
    const end = existing.indexOf(MARKER_END);
    const next =
      start >= 0 && end > start
        ? `${existing.slice(0, start)}${content}${existing.slice(end + MARKER_END.length).replace(/^\n+/, '')}`
        : `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${content}`;
    writeFileSync(target.path, next.endsWith('\n') ? next : `${next}\n`);
    return target;
  }

  if (existsSync(target.path)) copyFileSync(target.path, `${target.path}.bak`);
  writeFileSync(target.path, content.endsWith('\n') ? content : `${content}\n`);
  return target;
}

function main() {
  const args = process.argv.slice(2);
  const projectFlag = args.indexOf('--project');
  const projectDir = projectFlag >= 0 ? args[projectFlag + 1] : process.cwd();
  const wanted = args.filter((a) => !a.startsWith('--') && a !== projectDir);
  const tools = wanted.length === 0 || wanted[0] === 'all' ? TOOLS : wanted;
  for (const tool of tools) {
    const target = installSkill(tool, projectDir);
    console.log(`${tool.padEnd(9)} ${target.scope.padEnd(7)} ${target.path}`);
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
