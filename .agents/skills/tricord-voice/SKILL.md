---
name: tricord-voice
description: Implement or diagnose Tricord community voice, LiveKit signaling, exact audio-device routing, Electron media permissions, reconnect recovery and local multi-client capacity.
---

# Tricord voice work

Read [AGENTS.md](../../../AGENTS.md), [the API voice implementation](../../../apps/api/src/voice/service.ts), [gateway.ts](../../../apps/api/src/voice/gateway.ts) and the relevant [client controller](../../../apps/web/src/voice-controller.ts) or [desktop permissions](../../../apps/desktop/src/media-permissions.ts). Follow the current code when historical milestone notes differ.

## Invariants to preserve

- Voice reservations are ephemeral, tied to an authenticated account/session, one per account and capped at ten people per room. The design assumes one API process.
- The browser receives an opaque lease. The authenticated same-origin signaling gateway creates internal short-lived microphone-only credentials and redacts refresh credentials. Keep LiveKit control private and usable JWTs out of the renderer/logs.
- Reconnect and heartbeat handling recheck current session, approval and lease. Leave, expiry and revocation close owned media/signaling resources; service failures must not grant access.
- For calls, capture only the explicitly selected microphone. User-triggered device discovery may briefly open and stop the default microphone to reveal device labels. Missing devices stop transmission/playback rather than selecting defaults. Route incoming audio to the chosen output before playing it.
- Preserve room/generation fences around asynchronous capture, publication and output routing. Stop obsolete tracks and prevent stale completions from reviving a departed call.
- Electron microphone consent is restricted to the trusted main frame. Camera/display capture remains denied until a separately scoped feature deliberately implements it.

## Diagnosis and verification

First identify the failing layer: service readiness, account/lease authorization, signaling, ICE/media connection, capture or output. Read the relevant configuration without exposing credentials. The development Compose advertises loopback addresses; it cannot prove remote connectivity.

Use `pnpm --filter @tricord/api test:voice:check` for the read-only service preflight. If needed, start Docker Desktop, then existing `pnpm db:up`, `pnpm voice:setup`, `pnpm voice:up` and `pnpm db:migrate`. Initial database setup is described in [README](../../../README.md); preserve initialized passwords. For a browser compatibility report, check secure context, WebRTC availability and user-selected privacy settings before treating one browser profile as an unsupported browser. Do not silently alter those settings.

Run focused controller/service regressions and the relevant checks in [tricord-verify](../tricord-verify/SKILL.md). `pnpm test:voice` runs two real Chromium clients with synthetic audio. `pnpm test:voice:load` adds a ten-client steady phase, rejection of an eleventh client, recovery and owned-resource cleanup. Capacity/reconnect/rate-limit work warrants the latter; a text-only style change does not.

Use test-owned profiles, database and media-room prefix. Do not connect synthetic clients to real user rooms or open physical microphones as an incidental automated check. Inspect packet progression, active tracks, connection cleanup, API responsiveness and throttling outcomes rather than equating a connected label with working audio.

Reports under artifacts are local diagnostics and remain ignored. State whether evidence is unit, local synthetic, physical-device or cross-network; local passing results do not establish WAN/TURN quality or human listening quality.
