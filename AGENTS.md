# Agent Skills

Agent skills for this project and their usage scenarios.

Harnesses that expand `@` imports (such as Claude Code) inline the referenced skill file automatically. Harnesses
that do not (such as DeepSeek Harness) must read the referenced file before applying the skill.

## DCO Skill

**When to use:** Every time you commit code (`git commit`), to ensure the commit message complies with the Developer Certificate of Origin (DCO) and automatically appends the `Signed-off-by:` line.

Read `skills/DCO.md` before running `git commit`.

@skills/DCO.md

## Gitmoji Skill

**When to use:** Every time you commit code (`git commit`), to pick an appropriate gitmoji shortcode as the commit message title prefix based on the change.

Read `skills/GITMOJI.md` before running `git commit`.

@skills/GITMOJI.md
