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

- For larger work, open an issue or discussion first to align on scope.
- Create a descriptive branch, e.g. `feat/message-search` or `fix/login-redirect`.
- Keep PRs focused. Explain what changed and how you tested it.
- Run the applicable scripts in `package.json`, including `pnpm test`; database tests (`pnpm test:db`) require a working test database.
- Do not include generated output, dependencies, secrets, or unrelated formatting changes.
- Be respectful and follow the Code of Conduct.

Trusted collaborators may push branches directly. Contributors without write access can submit pull requests from forks. PR approval is not mandatory, but review is encouraged for security-sensitive and substantial changes.

## Licensing

By submitting a contribution, you agree that your contribution may be distributed under the repository's MIT License. Only submit material you have the right to contribute.
