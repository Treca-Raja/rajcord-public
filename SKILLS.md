# Tricord repository skills

These workflows live in `.agents/skills/` and travel with the repository. Each skill has a valid SKILL.md manifest. This file is an index; [AGENTS.md](AGENTS.md) supplies common rules and [MEMORY.md](MEMORY.md) supplies dated context. Neither this index nor MEMORY.md needs a custom global Codex configuration.

| Skill                                                        | Use when                                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [tricord-verify](.agents/skills/tricord-verify/SKILL.md)     | Choosing and running checks for a Tricord change, or diagnosing a failed project check             |
| [tricord-database](.agents/skills/tricord-database/SKILL.md) | Changing PostgreSQL/Drizzle persistence, generating migrations or testing data recovery            |
| [tricord-voice](.agents/skills/tricord-voice/SKILL.md)       | Working on LiveKit, device routing, permissions, reconnects or voice capacity                      |
| [tricord-hosting](.agents/skills/tricord-hosting/SKILL.md)   | Preparing the server image, evaluating deployment readiness or performing an authorized deployment |

Invoke a skill explicitly, for example `$tricord-database`, or let Codex select it when the task matches its description. Open this checkout in Codex so repository discovery uses the correct root. If the current session has not discovered a new skill, read its linked file directly or reopen the repository session.

Repository discovery and manifest format follow [OpenAI's skill documentation](https://learn.chatgpt.com/docs/build-skills); root guidance follows [AGENTS.md documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md). MEMORY.md is a project convention read through AGENTS.md, not a built-in persistent-memory feature.

When maintaining these skills, keep descriptions specific, verify commands against package.json, resolve links relative to each skill folder, and use the Skill Creator validator when available. Do not turn a one-time request for three reviews or a push into a permanent approval or review requirement.
