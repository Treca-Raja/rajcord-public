# Contributing to Tricord

Thanks for helping build Tricord. Contributions are welcome from anyone. You do not need write access to contribute.

## Setup

1. Fork this repository (unless you are an invited collaborator), then clone your fork or the main repository.
2. Install Node.js and pnpm compatible with the versions declared in `package.json`. Install Docker if you will run the database locally.
3. From the repository root, run `pnpm install`.
4. Copy the relevant `.env.example` files to local `.env` files and adjust settings for your machine. Never commit `.env` files, credentials, or personal data.
5. Start PostgreSQL with `pnpm db:up` and apply migrations using `pnpm db:migrate`.
6. Follow the README for starting the API, web, and desktop applications (`pnpm dev:desktop` is available for the desktop stack).

## Submitting changes

- Use [the ticket template](docs/ticket-template.md) when drafting work items. AI-created Trello cards and GitHub issues must follow it; keep personal Trello access/routing in [personal MCP configuration](docs/trello-mcp.md), not the repository.
- For larger work, open an issue or discussion first to align on scope.
- Follow `feature/* -> develop -> main` for features, fixes, documentation and CI changes.
- Create a descriptive `feature/<short-description>` branch from an up-to-date `develop`, for example `feature/message-search` or `feature/fix-login-redirect`. Inspect local work before fetching or switching; only fast-forward shared branches and never discard unrelated changes.
- Open feature pull requests against `develop`. Release pull requests go from `develop` to `main`; do not open feature pull requests directly against `main` or push changes directly to either shared branch.
- Keep PRs focused. Explain what changed and how you tested it.
- Add tests for implemented behavior and run applicable local checks from [tricord-verify](.agents/skills/tricord-verify/SKILL.md). Database tests (`pnpm test:db`) require the documented local services. Documentation-only changes need formatting/link checks, not the runtime stack.
- Update existing documentation for changed features or commands, using [tricord-document-change](.agents/skills/tricord-document-change/SKILL.md). Keep code comments limited to non-obvious intent or constraints.
- Do not include generated output, dependencies, secrets, or unrelated formatting changes.
- Be respectful and follow the Code of Conduct.

Trusted collaborators may push their feature branches when authorized. Contributors without write access can submit pull requests from forks, also targeting `develop`. Check the PR source/base pair and required checks before merging. Preserve configured branch protections; this document does not change GitHub settings. Review is encouraged for security-sensitive and substantial changes.

Verification runs on feature/develop branches and pull requests without publishing or deploying. Only verified `main` commits enter the separately gated release pipeline; a PR merge does not authorize bypassing production approval.

## Licensing

By submitting a contribution, you agree that your contribution may be distributed under the repository's MIT License. Only submit material you have the right to contribute.
