---
name: rajcord-ui
description: Use for Rajcord UI/UX, chat layout, composer controls, menus, panels, emoji, animations or perceived performance; keep interactions quick, smooth and accessible.
---

# Rajcord UI interactions

1. Keep the existing dark shell coherent. Chat uses a small left avatar and a compact sender header directly above the text, with one shared text edge on every row; do not turn it into a table with a reserved sender column. Keep timestamps right-aligned, identity readable, reactions beneath/outside the highlight, and actions contextual. Avoid grouped-message indentation changes and generic CSS collisions. Keep composer tools inside the composer; make sidebar category management and Settings controls discoverable.
2. Provide quick, subtle motion for hover/focus feedback, buttons, menus and panel openings. Reuse shared motion tokens (roughly 120–160 ms), opacity and small transforms; avoid layout/size animations, `transition: all`, long staggered effects or animation delays before an action.
3. Show panel shells/loading feedback immediately, independently of network completion. Drawer triggers toggle open/closed; entry and exit must not snap the timeline width. Opening pins/threads must not re-render unchanged message rows or block typing. Bound rendered lists and lazy-load large optional catalogs; never trade away authorization, revocation cleanup or explicit errors for caching.
4. Preserve composer focus and text across sends, tool insertion, navigation and recoverable failures. Picker triggers toggle open/closed; outside/composer clicks dismiss them without stealing focus. Provider/category switches use quick shared motion, not layout jumps or blank resets. Reply targets remain visibly selected, and quote navigation must work on its first click against the main timeline DOM. Support keyboard and touch, not hover alone. Respect `prefers-reduced-motion` by removing motion without delaying interaction.
5. Test actual behavior and geometry with disposable fixtures: message density, quick panel feedback under a delayed response, contextual menus, focus, inline tools and narrow layouts. Visually inspect changed screens. Measure relevant bundle/render/request budgets rather than claiming smoothness from a passing typecheck.

Use the [verification workflow](../rajcord-verify/SKILL.md) for relevant checks and update existing behavior documentation. Do not fetch media or request permissions merely to animate a preview.
