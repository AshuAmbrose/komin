Project context for AI coding agents lives in AGENTS.md, which is shared by every tool. Claude Code loads it through this import:

@AGENTS.md

AGENTS.md lists the topic files in docs/agents/. Read them when a task needs them; they are deliberately not imported here, so every session stays small.
