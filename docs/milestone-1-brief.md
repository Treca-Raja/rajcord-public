
You are my lead software engineer for a project called Tricord.

We are building a private, self-hosted Discord alternative for a small group of close friends.

I want you to actively implement the project, not just provide advice or write a plan.

IMPORTANT CONTEXT
- Development machine: Windows 11.
- Development environment: VS Code, PowerShell, Git and GitHub.
- I am relatively new to developing large applications.
- Use clear architecture, readable code, secure defaults, and maintainable patterns.
- Explain important decisions without overwhelming me.
- Work incrementally and verify your changes.
- The currently opened folder is the project root.

PRODUCT VISION

Tricord is a Discord-like communication application with:
- Shared text and voice channels.
- One-to-one direct messages and private calls.
- Group DMs and group calls.
- Low-latency voice communication.
- Game and screen streaming with audio.
- Multiple simultaneous streams and pop-out windows.
- A Windows desktop application.
- Browser access for Windows, macOS, Linux, Android and iOS.
- A common backend and as much shared frontend code as practical.

Discord is our default reference for familiar behavior and UX unless a custom requirement says otherwise.

CUSTOM REQUIREMENTS

1. One shared private platform, not multiple Discord servers.
2. Anybody can register, but their account must be approved before accessing the application.
3. Every approved user can approve new registrations and manage shared channels.
4. A designated platform owner alone can remove approved users and change critical security settings.
5. Messages and attachments remain stored indefinitely until explicitly deleted.
6. Only message authors can delete their own messages.
7. Administrators do not automatically gain access to private DMs or group conversations.
8. Any group DM member can invite another approved user, but the recipient must accept before joining.
9. Only the designated group DM manager can remove participants. Group management is transferable.
10. Returning group DM members can access messages from their previous membership periods but not messages sent while they were absent.
11. Each account may participate in only one active voice session at a time.
12. Voice connections should recover gracefully from network interruptions.
13. Windows desktop functionality must eventually support system-wide push-to-talk, tray operation, reliable audio device selection, and game capture.
14. Screen sharing must stop when Windows locks and must never restart automatically after unlocking.
15. Streams should support approximately 1-3 viewers efficiently, preferably using WebRTC P2P with TURN fallback.
16. We prioritize security, reliability, performance, and low hosting costs.

TECHNOLOGY STACK

Use these technologies unless you discover a serious incompatibility:

- TypeScript throughout.
- React + Vite for the shared interface.
- Electron for the Windows desktop application.
- Node.js + Fastify for the backend.
- Socket.IO for real-time messaging and application events.
- PostgreSQL for persistent relational storage.
- Drizzle ORM for database access and migrations.
- pnpm workspaces for the monorepo.
- Vitest for appropriate unit and integration tests.
- Docker Compose for local database infrastructure.

FUTURE TECHNOLOGIES, NOT FOR INITIAL IMPLEMENTATION
- LiveKit for voice and group calls.
- WebRTC P2P and TURN for game streaming.
- Native Windows capture integration if needed.

Choose compatible maintained stable dependency versions and verify their compatibility.

YOUR CURRENT TASK: MILESTONE 1 ONLY

Build the working technical foundation.

1. Inspect the current project directory and installed development tools.
2. Initialize a clean Git repository if necessary.
3. Create a pnpm monorepo with a practical directory structure:

   apps/
     web/
     desktop/
     api/

   packages/
     shared/
     ui/

   infrastructure/
   docs/

4. Configure TypeScript appropriately for each workspace.
5. Create a React + Vite web application with a clean, dark, Discord-inspired initial interface.
6. Create an Electron application that loads the shared React interface.
7. Implement Electron security best practices:
   - contextIsolation enabled
   - sandbox enabled where appropriate
   - nodeIntegration disabled
   - narrow preload bridge
   - restrictive window and navigation permissions
   - no disabling web security
8. Create a Fastify API server with a working /health endpoint.
9. Configure Socket.IO on the backend and demonstrate a working client connection.
10. Add a local PostgreSQL configuration using Docker Compose.
11. Configure Drizzle ORM with a minimal initial schema and a repeatable migration workflow.
12. Add shared TypeScript types between frontend and backend.
13. Configure formatting, linting, type checking, testing, and production builds.
14. Add environment-variable examples without committing secrets.
15. Add a README containing exact PowerShell commands for setup and running the project on Windows.
16. Add sensible .gitignore rules.
17. Add basic automated tests covering the foundation.

DESIGN EXPECTATIONS

The initial interface should be visually polished but simple.

Create:
- Left navigation sidebar.
- Text-channel list.
- Main chat area.
- Member/profile area.
- Basic placeholder controls for voice and settings.
- Responsive layout.

Use mock conversation content only where necessary for the visual shell.

Do not pretend authentication or messaging works if it has not been implemented yet. Clearly distinguish demo UI from functional features.

SCOPE RESTRICTIONS

Do NOT implement the entire application.

For Milestone 1:
- No complete authentication system yet.
- No real messaging persistence yet.
- No voice or video implementation yet.
- No WebRTC implementation yet.
- No streaming implementation yet.
- No cloud deployment yet.
- No elaborate permissions or role system.
- No unnecessary microservices.
- No speculative frameworks or dependencies.

Focus on a genuinely working, well-structured foundation.

WORKING RULES

- First inspect the workspace and available tools.
- Briefly present the implementation sequence.
- Then actually create the files and run the necessary commands.
- Do not stop after generating a plan.
- Make reasonable technical decisions independently.
- Use PowerShell-compatible commands on Windows.
- Do not modify unrelated folders or projects.
- Do not push code, publish a repository, deploy anything, or create paid services without my permission.
- If Docker or another required tool is missing, do not fake a successful test. Implement what is possible and clearly explain what remains blocked.
- Fix errors you encounter before declaring the milestone complete.
- Run available linting, type checks, tests, and builds.
- Verify that both the browser application and Electron application can launch and connect to the API.
- Keep the code modular and avoid unnecessary abstraction.
- Document key technical decisions.

DEFINITION OF DONE

Milestone 1 is complete when:
1. The React application runs in a browser.
2. The same interface runs inside Electron on Windows.
3. The backend starts and exposes a working health endpoint.
4. Socket.IO connects successfully.
5. PostgreSQL is configured with working migrations, if local infrastructure is available.
6. The monorepo builds and available tests pass.
7. I have documented commands to start and stop everything.

At the end, provide:
- What you implemented.
- Files and folders created.
- Exact PowerShell commands to run the project.
- Test and build results.
- Anything incomplete or blocked.
- Your recommendation for Milestone 2.

Start working on Milestone 1 now.
