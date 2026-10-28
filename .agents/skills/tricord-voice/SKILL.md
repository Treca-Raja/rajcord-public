---
name: tricord-voice
description: Use for Tricord voice/LiveKit, exact audio devices, Electron media permissions, reconnects or capacity.
---

# Tricord voice work

Identify the failing/changed layer first. Read only relevant [service](../../../apps/api/src/voice/service.ts), [gateway](../../../apps/api/src/voice/gateway.ts), [controller](../../../apps/web/src/voice-controller.ts) or [desktop permission](../../../apps/desktop/src/media-permissions.ts) paths, then expand across their affected contracts.

## Invariants to preserve

- Ephemeral authenticated leases, one per account, ten people per room; one API process assumed.
- Same-origin gateway, internal short-lived microphone-only credentials, redacted refresh credentials and private LiveKit control. No usable JWTs in renderer/logs.
- Recheck session/approval/lease on reconnect and heartbeat. Leave/expiry/revocation clean up owned resources; failures never grant access.
- Capture/play only the selected devices, with no silent fallback. User-triggered discovery may briefly open/stop the default microphone for labels. Route output before playing; missing devices stop affected media.
- Preserve room/generation fences, stop obsolete tracks and prevent stale asynchronous completions reviving calls.
- Electron microphone access requires the trusted main frame; camera/display capture stays denied without a separately scoped feature.

## Diagnosis and verification

- Separate readiness, authorization, signaling, ICE/media, capture and output failures. Use `pnpm --filter @tricord/api test:voice:check` for local preflight; consult [setup](../../../README.md) only for missing prerequisites, preserving credentials.
- For browser reports, inspect secure context, WebRTC and chosen privacy settings; never silently change them.
- Run focused regressions and `pnpm test:voice` where voice behavior changes. Capacity/reconnect/rate-budget changes also need `pnpm test:voice:load`: ten clients, eleventh rejection, recovery and cleanup. No stack for text-only documentation edits.
- Use test-owned profiles, database and media-room prefix, never real user rooms or incidental physical microphones. Check packets, tracks, cleanup, API responsiveness and throttling, not just a connected label.
- Keep artifacts private/ignored. Distinguish unit, synthetic, device and WAN evidence; loopback Compose/synthetic audio cannot prove cross-network or human listening quality.
