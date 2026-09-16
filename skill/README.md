# Agent instructions

`SKILL.md` here is the canonical guide for driving this orchestrator from an
agent CLI. Install it wherever your tool looks for instructions:

```bash
node skill/install-skill.mjs all        # every supported tool, current directory
node skill/install-skill.mjs opencode   # or one at a time
```

| Tool | Where it lands | Scope |
|---|---|---|
| opencode | `~/.config/opencode/skills/dag-orchestrator/SKILL.md` | user |
| Claude Code | `<project>/.claude/skills/dag-orchestrator/SKILL.md` | project |
| Cursor | `<project>/.cursor/rules/dag-orchestrator.mdc` | project |
| Codex | `<project>/AGENTS.md` (marked section, appended) | project |
| GitHub Copilot | `<project>/.github/copilot-instructions.md` (marked section) | project |

`AGENTS.md` and `copilot-instructions.md` are shared files, so the installer
appends a delimited section and updates it in place on re-run — it never
clobbers the rest of the file. Anything else it writes is a dedicated file.

Tools without an installer entry still work: paste `SKILL.md` into whatever
context file your CLI reads. The instructions are plain Markdown on purpose —
they describe the `dag` CLI, not any one agent.
