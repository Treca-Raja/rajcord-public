# Rajcord repository skills

Optional discovery index, not a startup checklist. Use the existing skill metadata first; load a body only for the current task/phase. Links are references, not instructions to recursively read every document or invoke every linked skill.

- [Plan](.agents/skills/rajcord-plan-change/SKILL.md): substantial designs, not routine fixes.
- [Ticket](.agents/skills/rajcord-ticket/SKILL.md): ticket drafts, creation or substantial rewrites.
- [Document](.agents/skills/rajcord-document-change/SKILL.md): changed features, commands or decisions.
- [Verify](.agents/skills/rajcord-verify/SKILL.md): choose/run relevant checks or diagnose failures.
- [Database](.agents/skills/rajcord-database/SKILL.md): persistence, migrations and recovery.
- [Voice](.agents/skills/rajcord-voice/SKILL.md): LiveKit, devices, permissions and capacity.
- [Hosting](.agents/skills/rajcord-hosting/SKILL.md): packaging, CI/release and authorized operations.
- [Deployment option](.agents/skills/rajcord-deployment-option/SKILL.md): future boolean selectors; no component switches exist yet.

Keep `.agents/skills/` canonical. In Copilot/VS Code, use Agent Customizations, available `/` commands or request a skill by name. In Codex, use skill selection or `$rajcord-database`. After changes, check discovery in a fresh repository-scoped chat; if missing, read the required manifest directly and report the limitation, rather than duplicating files.

For discovery problems, consult [VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills) or [Codex](https://learn.chatgpt.com/docs/build-skills). [Trello setup](docs/trello-mcp.md) is needed only for connection/authentication issues. Skills require no particular paid model. Validate changed manifests, relative links, commands and formatting; keep descriptions specific and avoid permanent rules derived from one-off requests.
