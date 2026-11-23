---
name: rajcord-ui
description: Implement and review Rajcord workspace UI using its design system, responsive layouts, accessible controls and local interaction checks.
---

# Rajcord workspace UI

Start with the [workspace design system](../../../docs/design-system.md) and the feature’s existing components and tests. Keep styles with the owning feature and reuse the shared semantic tokens. Preserve both Original and Retro appearance.

1. Keep the conversation or stream in focus. Reuse the unified directory, optional Activity panel and persistent call controls. Keep message bodies aligned through sender changes and grouping.
2. Preserve drafts, reply targets, keyboard focus and access checks. Keep menu and picker actions available to touch and keyboard users. Opening a quote should reach its authorized original on the first activation.
3. Open panels immediately and show the state of their request. Keep typing responsive during loading, retries and panel transitions. Bound message windows and large catalogs. Keep media loading and device access tied to the user’s actions.
4. Use shared motion timings for brief feedback. Respect reduced motion and keep the timeline stable during panel transitions.
5. Exercise the affected interaction using a disposable fixture. Inspect desktop and narrow layouts, long text, keyboard focus and failure recovery. Measure render or request costs when the change could affect them. [Verification workflow](../rajcord-verify/SKILL.md)
