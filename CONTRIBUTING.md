# Contributing to Rajcord

Thanks for helping build Rajcord. Contributions are welcome from anyone. You do not need write access to contribute.

## Setup

1. Fork this repository (unless you are an invited collaborator), then clone your fork or the main repository.
2. Install Node.js and pnpm compatible with the versions declared in `package.json`. Install Docker if you will run the database locally.
3. From the repository root, run `pnpm install`.
4. Copy the relevant `.env.example` files to local `.env` files and adjust settings for your machine. Never commit `.env` files, credentials, or personal data.
5. Start PostgreSQL with `pnpm db:up` and apply migrations using `pnpm db:migrate`.
6. Follow the README for starting the API, web, and desktop applications (`pnpm dev:desktop` is available for the desktop stack).

## Web feature ownership

Web features live in `apps/web/src/features/`: account, appearance, channels, chat, notifications, presence, sounds, voice and screen sharing. Each directory owns its components, local state/controllers, styles and tests. Its `index.ts` exposes the operations and components other features need; use named exports and keep implementation helpers private. `contracts.ts` provides type-only integration contracts where needed, and `styles.css` is the public stylesheet entrypoint.

Windows desktop publishing uses the supervised OBS helper under `apps/desktop/native/obs`. Run `pnpm desktop:obs:setup` before desktop media or installer checks. Ordinary browsers retain their capture implementation and share the existing session and viewer authorization contracts. The [OBS handoff](docs/screen-sharing-handoff.md#windows-obs-publisher) covers build inputs, fixtures and the release hold.

`apps/web/src/app/` assembles those features and owns cross-feature navigation and verified authentication/call lifetimes. `Auth` retains session verification, CSRF, socket and logout coordination; `CallProvider` retains the single call owner and voice/screen cleanup. Voice/session constructors and the screen application factory are exposed through `composition.ts`, which only `app/` and the bootstrap entrypoint may import. Account forms use the account context, and media UI uses the shared typed call context. Screen sharing depends on the voice binding/revocation contract rather than the full voice controller. Shared modules may import feature contracts as types, and must not depend on feature runtime implementations.

Feature-specific form input parsing stays with its owner: channel metadata is parsed by channels, and DM/group fields by chat. Forms report their conversation kind to the app coordinator, which owns the shared submission/reload/navigation lifecycle. Adding a field to an existing form should not require adding parsing logic to `App`.

For a new feature, create `features/<name>/index.ts`, keep its implementation and tests together, and add only the required composition wiring under `app/`. Import other features through their public entrypoints. Prefer existing helpers or a narrow callback/type contract when connecting features; feature internals must not import `app/` or another app's implementation. Shared types that are also used by the API or desktop continue to belong in `packages/shared`. API services and Electron permission boundaries remain in their existing application layers.

`pnpm lint` checks ordinary imports, exports, literal dynamic imports and import types; portable tests cover private-import failures and scan current product modules. Use literal dynamic imports so dependencies can be checked. Co-located test/integration fixtures may access implementation details. Do not move runtime code into fixtures, `shared/`, or `app/` to bypass a boundary.

`app/styles.ts` preserves the existing stylesheet cascade during this migration. Feature styles remain in their owning directory; chat's public stylesheet gathers its private picker, GIF and message styles. Keep new selectors scoped to their feature. Changes to a shared public contract or application lifetime can require coordinated updates; ordinary feature work should stay within its owner and tests.

## Coding safeguards

`pnpm lint` checks React hook ordering/dependencies and typed promise handling in production web, API and desktop modules, enforces web and API feature import boundaries, and runs `pnpm check:cycles` over both runtime import graphs. API features compose in `app.ts`; production dependencies currently flow from chat to auth, voice to auth/database, screen sharing to auth/voice, and auth bootstrap to database. Type-only dependencies do not form runtime cycles. Tests, integration fixtures and operational smoke scripts may cross these boundaries where setup requires it. Keep any rule exception local and explain the invariant; generation-counter cleanup deliberately invalidates the latest counter rather than capturing a DOM node.

Handle expected asynchronous failures in the owning feature's UI. Await dependent work; use `shared/background.ts`'s `runInBackground` only when an event/effect intentionally detaches work and unexpected rejections should reach the browser error reporter. A bare `void` is not rejection handling. Do not replace error handling with an empty catch or blanket lint suppression.

HTTP schemas are grouped by feature in `packages/shared/src/contracts/`; `api-response.ts` composes their route registry and validators. Authenticated browser features should use `AuthContext.requestContract`, which derives request and response types from the route schemas and binds writes to the verified session's CSRF token. The account bootstrap uses `apiContract` before that context exists. Fastify applies each contract to route validation and response serialization; browser requests and successful responses are also checked at runtime before feature state uses them. Add a contract for every new `/api` route. Unknown endpoint/method pairs and malformed payloads fail explicitly. Response contracts permit extra fields for forward compatibility and retain the legacy message adapter. Error responses preserve HTTP permission status, and validation errors contain no request or response contents. Shared Socket.IO client payload schemas live in `packages/shared/src/socket-contracts.ts`; the API rejects malformed event packets before feature handlers and returns the event's safe error acknowledgment. These transport checks complement service authorization, semantic validation, screen/media authority and lifetime checks.

`shared/FeatureBoundary` contains unexpected render failures. The app composes boundaries around messages, account settings, voice and screen sharing, plus a final application boundary. Put resource owners outside a recoverable UI boundary and invoke their existing cleanup controls when UI failure would hide active media: screen failure stops source/viewing while preserving voice, and voice failure leaves the call. Retry remounts the failed UI without automatically joining or sharing. Error boundaries do not handle asynchronous event failures; those still require explicit rejection handling.

The Linux verification workflow runs browser regressions against disposable services after building, before any tested image can be published. `pnpm test:browser:built` reuses an unchanged build; `pnpm test:browser` builds first. The test harness uses a private profile and synthetic media. Linux test Chromium runs without its process sandbox in the disposable CI environment; this does not change Electron's application sandbox or production permissions. Local browser checks do not establish remote CI, physical-device or WAN acceptance.

## Submitting changes

- Use [the ticket template](docs/ticket-template.md) when drafting work items. AI-created Trello cards and GitHub issues must follow it; keep personal Trello access/routing in [personal MCP configuration](docs/trello-mcp.md), not the repository.
- For larger work, open an issue or discussion first to align on scope. Use the [board workflow](docs/ticket-template.md#board-workflow): one accountable human owner per active ticket, linked dependencies, an explicit work claim, and coordination with overlapping PRs before AI-assisted changes to shared contracts, migrations or components. Do not invent a board assignment or change existing ticket status without authorization.
- Follow `feature/* -> develop -> main` for features, fixes, documentation and CI changes.
- Create a descriptive `feature/<short-description>` branch from an up-to-date `develop`, for example `feature/message-search` or `feature/fix-login-redirect`. Inspect local work before fetching or switching; only fast-forward shared branches and never discard unrelated changes.
- Open feature pull requests against `develop`. Release pull requests go from `develop` to `main`; do not open feature pull requests directly against `main` or push changes directly to either shared branch.
- CI checks PR source/base pairs, including retargeted PRs. Dependency-update branches (`dependabot/*`) also target `develop`; retarget any default-branch security-update PR before merging. Both Linux `verify` and Windows `build` checks must pass before merge.
- Keep PRs focused. Explain what changed and how you tested it; link the associated ticket when appropriate and safe. Resolve substantive review findings and run mandatory CI. Record functional acceptance separately from automated checks and keep integration distinct from deployment or desktop publication.
- Add tests for implemented behavior and run applicable local checks from [rajcord-verify](.agents/skills/rajcord-verify/SKILL.md). Database tests (`pnpm test:db`) require the documented local services. Documentation-only changes need formatting/link checks, not the runtime stack.
- Update existing documentation for changed features or commands, using [rajcord-document-change](.agents/skills/rajcord-document-change/SKILL.md). Keep code comments limited to non-obvious intent or constraints.
- Do not include generated output, dependencies, secrets, or unrelated formatting changes.
- Text checkouts use LF through `.gitattributes`, including on Windows; PNG and ICO assets remain binary. Preserve applied migration files rather than rewriting them to repair formatting.
- Be respectful and follow the Code of Conduct.

Trusted collaborators may push their feature branches when authorized. Contributors without write access can submit pull requests from forks, also targeting `develop`. Check the PR source/base pair and required checks before merging. Preserve configured branch protections; this document does not change GitHub settings. Review is encouraged for security-sensitive and substantial changes.

Verification runs on pull requests and pushes to develop without publishing or deploying. Feature pushes are checked through their pull request to avoid duplicate runs. Windows PR tests remain enabled. Only verified `main` commits enter the separately gated release pipeline; a PR merge does not authorize bypassing production approval.

## Licensing

By submitting a contribution, you agree that your contribution may be distributed under the repository's MIT License. Only submit material you have the right to contribute.
