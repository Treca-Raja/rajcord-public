# Milestone 1 verification

Verified on Windows 11, 2026-10-23. Active repository: F:\tricord.

| Check                              | Result                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| PostgreSQL                         | postgres:17-alpine container healthy; host binding 127.0.0.1:5432                                          |
| Migration                          | Existing initial SQL applied; users table, enum and Drizzle journal verified                               |
| Real database operations           | Drizzle insert/read/delete passed using uniquely identified disposable rows                                |
| Persistence                        | Committed probe row survived a container restart and was then deleted by exact ID                          |
| Migration reruns                   | Passed twice inside integration tests with unchanged schema, constraints, journal and fixture              |
| Fastify database access            | /ready returns 200 using real PostgreSQL and 503 for unreachable PostgreSQL                                |
| Automated tests                    | 4 API/socket + 7 database integration tests; 11 total                                                      |
| Formatting, lint, types and builds | Run for the active monorepo                                                                                |
| Existing browser/Electron checks   | Previously verified shared UI, live Socket.IO and isolated renderer; hidden screenshot capture unavailable |

No existing records or volumes were removed. The initial Docker inspection found no containers or volumes; Compose created infrastructure_tricord_postgres. Local credentials are in ignored files and are not included in Git. Tests explicitly clean up only their own generated IDs. The database remains running for development.

The persistence probe is deliberately a separate command because restarting PostgreSQL interrupts local connections. Database tests are opt-in but fail loudly when infrastructure is unavailable; they are not silently skipped. No authentication, messaging, media, cloud, multi-user performance or mobile compatibility claims are made.
