# Milestone 2A verification

Windows 11, 2026-10-23. Repository: F:\tricord. Foundation commit 1576549 retained.

| Check                         | Result                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL                    | Existing postgres:17-alpine container healthy, bound only to 127.0.0.1:5432                                             |
| Migration                     | Original 0000 preserved; additive 0001 applied; five expected public tables and singleton owner constraint verified     |
| Migration reruns              | Repeated migration execution leaves schema, journal and fixtures unchanged                                              |
| Database persistence          | Disposable account, Argon2 hash, remembered session, audit entry and migration journal survive actual container restart |
| Foundation suite              | 4 passing tests                                                                                                         |
| Database suite                | 7 passing tests                                                                                                         |
| Authentication/security suite | 29 passing tests                                                                                                        |
| Total Vitest tests            | **40 passing tests**                                                                                                    |
| Browser integration           | Actual headless Edge, isolated profile/database; 11 flow checks plus desktop/mobile screenshots                         |
| Electron integration          | Three actual Electron launches; 13 authentication/lifecycle checks                                                      |
| Static checks/builds          | Formatting, ESLint, TypeScript and all production builds pass                                                           |
| Dependency checks             | No peer dependency issues; production dependency audit reports no known vulnerabilities                                 |

The built API and Vite development proxy were also started together: PostgreSQL readiness returned 200, anonymous authentication returned 401 through Vite, and login validation reached the backend through the same-origin proxy. Built web assets were served successfully by Fastify.

## Security coverage

Successful registration; case-insensitive duplicates; password hashing; input/privilege injection rejection; login failure parity; legacy users without credentials; HttpOnly/SameSite cookie flags; production Secure cookies; temporary/remembered expiry; login session rotation; anonymous/pending/rejected restrictions; Origin and CSRF validation including malformed tokens; self-action and owner protection including uppercase UUIDs; administrator approval/rejection; audit actor/time; concurrent conflicting decisions; owner-only removal/suspension/restoration; safe bootstrap repetition; ownership transfer; logout; expiry; per-device revocation ownership; password-change revocation; protected sockets; live approval; per-event status checks; immediate suspension disconnect; backend restart persistence; authentication rate limits.

Production-mode cookie configuration is tested through API injection. Public HTTPS deployment and reverse-proxy behavior have not been deployed or certified.

## Browser evidence

The production web build was exercised in real headless Microsoft Edge through its DevTools protocol, with no personal browser profile involved:

1. Register through the rendered form; sign in with Remember enabled.
2. Observe pending screen and denied private member API.
3. Approve through the real API; observe automatic transition and authenticated Socket.IO.
4. Verify HttpOnly/SameSite persistent cookie and empty localStorage.
5. Use the member administration UI to approve another pending account.
6. Reload and retain the session.
7. Suspend through the owner API and observe the private UI disappear immediately.
8. Verify the 390-pixel mobile sign-in layout has no horizontal overflow.

Ignored artifacts: auth-browser.json, auth-browser-signin.png, auth-browser-approved.png and auth-browser-mobile.png. Screenshots were visually reviewed. These checks cover Chromium/Edge on Windows; they are not a claim of Safari/Firefox or physical mobile-device testing.

## Electron evidence

The production renderer was exercised in an actual sandboxed Electron process across three launches with a separate temporary profile:

- Register and sign in pending; receive live approval; enter the private shell and verify the socket; change display name; log out and sign back in without Remember.
- Minimize and confirm the temporary session remains active. Fully quit and confirm server revocation. Relaunch and require sign-in.
- Sign in with Remember; fully quit; relaunch and retain the approved account and display name; explicitly log out and confirm revocation.
- Verify no renderer Node/process access, the narrow platform preload and empty localStorage.

Ignored report: artifacts/auth-desktop.json. These are orderly online lifecycle tests; offline/crash limits are documented in README.

## Reproduction and preservation

Use the exact commands in [README](../README.md). Smoke commands use disposable databases and unique temporary profiles, not your development owner/account. PostgreSQL remains running after verification. No existing records, database volumes or migration history were removed. No actual owner credentials were generated for the development database. No cloud deployment, publishing or push occurred.

Milestone 1's original verification remains recorded in Git at 1576549. Its unauthenticated socket expectation has been replaced by denial; authenticated socket round trips now run in the database-backed security suite.
