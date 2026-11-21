# Rajcord workspace design system

The workspace is built for long conversations, games and shared screens. Give the conversation or the stream the largest usable area. Original uses flat, opaque surfaces and reserves citron for a few recognizable landmarks and actions.

## Color and type

| Role in Original                 | Value                             | Use                                                          |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| Conversation                     | `#101019`                         | Timeline and main canvas                                     |
| Navigation                       | `#1D1929`                         | Sidebar and Windows caption                                  |
| Elevated surface                 | `#302A40`                         | Composer and contextual panels                               |
| Primary / secondary / muted text | `#F5F4F8` / `#C3BED1` / `#9B95B1` | Content, supporting text and metadata                        |
| Electric citron                  | `#D4FF57`                         | Waveform brand mark, selected navigation and primary actions |
| Media blue                       | `#75B9FF`                         | Streams, links and keyboard focus                            |
| Voice mint                       | `#5DE9B3`                         | Connected voice and presence                                 |

Use the semantic tokens for hover, selection, boundaries, warning, failure and disabled states. Pair status color with text, an icon or an accessible control state. Check normal text at 4.5:1 and keyboard focus and essential control boundaries at 3:1 against their rendered surfaces. Retro supplies its own values for the same roles. [Shared tokens](../apps/web/src/shared/tokens.css) · [Appearance variants](../apps/web/src/features/appearance/styles.css)

Use locally bundled IBM Plex Sans. Messages use 15px type with a 23px line height, navigation uses 14px, supporting metadata uses 12px, and panel headings use 17px. Reserve IBM Plex Mono for technical values such as recovery codes. Space related items on a 4px scale. The standard control and panel radii are 8px and 12px.

## Workspace conventions

- **Navigation.** Use one directory for channels, voice rooms and direct messages. Keep each section’s disclosure and actions together. The sidebar is 256px on wide windows and becomes a drawer on phones. Activity starts closed and opens from the conversation header.
- **Conversation.** Align each message body with its sender. Put the time beside the sender or beside the text of a grouped follow-up. Limit prose to 82ch while the timeline and composer use the available workspace. Keep reactions below their message and expose actions through keyboard, pointer and touch.
- **Panels and forms.** Show a loading state as soon as a panel opens. Give empty states, failures and results separate presentations. Size pins to their contents and scroll longer lists beneath the header. Keep a visible focus indicator, return focus on dismissal and retain drafts through recoverable errors. When Activity opens account settings, move focus into settings and return it to the Activity button when settings closes.
- **Voice and streams.** Keep the current room and its controls available while reading chat. Adapt the header and toolbar to the call's available width so the sidebar cannot push controls outside the panel. Preserve the source aspect ratio when watching. On portrait phones the stream sits above chat or participants. Keep the composer visible and focused when the on-screen keyboard shortens the viewport. Use the elevated surface and its text tokens for stream settings. Focus settings when they open, disable interaction with covered chat, and restore focus to the opener on dismissal. Show the ended-stream message when a watched share disappears. Clear it when returning to the channel. Make stopping playback, stopping publication and leaving voice distinct actions.

Use `NavigationSectionHeader` for directory headings with disclosure buttons and contextual actions. Use `AppearanceBrand` for the waveform. The browser favicon, Windows window and tray icons, and packaged executable icon are generated from the same geometry. After changing that source, regenerate the assets with `node scripts/desktop-icons.mjs` and verify them with `--check`. [Directory heading](../apps/web/src/shared/NavigationSection.tsx) · [Brand component](../apps/web/src/features/appearance/Appearance.tsx) · [Icon generator](../scripts/desktop-icons.mjs)

Use the shared 120ms feedback and 160ms panel transitions for small changes in color, opacity or position. Honor reduced motion. Check the affected view with long content, keyboard focus and a narrow viewport using the [local review fixture](../README.md#review-the-workspace-with-sample-activity).
