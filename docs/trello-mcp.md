# Personal Trello MCP connection

Use the [official Trello MCP server](https://github.com/atlassian/trello-mcp-server), not an unreviewed community bridge. It is hosted by Atlassian, uses OAuth and supports Trello accounts on any plan. The official endpoint is `https://mcp.trello.com/v1`; no local Node package or manually pasted API key is required.

## Personal setup in Copilot / VS Code

1. Open the Rajcord checkout in a separate VS Code window with the Copilot harness selected. Copilot can remain signed into the account supplying its subscription; Trello authorization is separate.
2. Run **MCP: Add Server**, choose **HTTP**, enter the official endpoint and name it `trello-personal`. Choose **Global > Copilot Global**, not a shared workspace file. If it is already configured, open **Chat: Open Customizations > MCP Servers** instead of adding a duplicate.
3. Review the server and sign-in prompts. In the browser, use the personal Trello account and choose only the workspace containing the intended board. The current server authorizes one workspace per connection. Review the requested read/write permissions; organization MCP policies may still apply.
4. Complete OAuth in the client/browser. Never paste tokens into chat, JSON headers, committed environment files or tickets.
5. Start a fresh repository-scoped chat if necessary. Verify a read-only call to the intended board and list before requesting any card creation.

The portable personal configuration is stored under `$COPILOT_HOME/mcp-config.json`, defaulting to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "trello-personal": {
      "type": "http",
      "url": "https://mcp.trello.com/v1"
    }
  }
}
```

Merge this entry with existing servers; do not replace an existing configuration wholesale. A JSON entry or an unauthenticated HTTP response is not proof of an authorized MCP connection.

## Board routing and first verification

Keep the personal board URL and preferred list in the current request or a personal skill under `~/.copilot/skills/`, not in this public repository. A routing default is not an access restriction or standing permission to write.

For the first call, ask the agent to use `trello-personal` to read the chosen board and list its active lists, without creating or changing anything. Confirm:

- The actual Trello MCP tool ran and authenticated successfully.
- The returned board is the intended board in the authorized workspace.
- The destination list exists and has an unambiguous returned identifier.

If the board/list is missing, do not create replacements automatically. Check the personal account, authorized workspace and access permissions. If tools do not appear, inspect the MCP server status/authentication and restart the chat; do not report the server connected solely because the file exists.

## Ticket workflow

Every AI-created ticket follows [the ticket template](ticket-template.md) through [rajcord-ticket](../.agents/skills/rajcord-ticket/SKILL.md). Keep unspecified owners, estimates and dates unresolved rather than inventing them. Drafting or connecting does not create tickets.

Use the provider's returned identifiers and current action schemas. Archive, move, assignment and other write actions need to fall within the user's request. Verify the resulting card before reporting success. Markdown description fields provide the full template on Free plans without requiring custom fields or Planner features.

See [VS Code MCP setup](https://code.visualstudio.com/docs/agent-customization/mcp-servers), [configuration formats](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) and [official Trello tool guidance](https://github.com/atlassian/trello-mcp-server/blob/main/skills/trello-use/SKILL.md). Revoke the connection through the client or Trello account settings when it is no longer needed.
