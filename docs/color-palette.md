# Copyyt color palette

Copyyt uses the same color direction on Android and in the Chrome extension: **Warm Paper** in light mode and **Harbor Dark** in dark mode. The Copyyt mark keeps its established blue (`#2D9CDB`) in both modes. The extension follows the operating system's color setting; it does not store a separate theme preference.

| Role | Warm Paper | Harbor Dark | Use |
| --- | --- | --- | --- |
| Brand | `#2D9CDB` | `#2D9CDB` | Copyyt mark and brand accents |
| Primary action | `#1E6892` | `#56B3E6` | Buttons, links, focus outline |
| On primary | `#FFFFFF` | `#002235` | Text on primary actions |
| Page | `#F7F5F1` | `#08141C` | Popup surround and page background |
| Surface | `#FFFFFF` | `#0F2230` | Popup, cards, form fields |
| Soft surface | `#E3F3FB` | `#16303F` | Selected tabs, fingerprints, quiet highlights |
| Text selection | `#A9D8F2` on `#0F3449` | `#1E6892` on `#FFFFFF` | Highlighted (selected) text, including on soft panels |
| Main text | `#0F3449` | `#E2EEF5` | Headings and body text |
| Muted text | `#4B5F6C` | `#A9BCC8` | Supporting copy and placeholders |
| Border | `#D5E3E9` | `#2B4A5C` | Card and form outlines |
| Connected | `#3C7D72` | `#75C7B0` | Success and connected states |
| Error | `#FF2635` | `#FF6B75` | Destructive and error states |

Status surfaces use quieter shades of these colors. Amber is reserved for waiting states. The full set, including hover, disabled, and status foregrounds, lives in [the extension theme tokens](../src/index.css). Android's matching palette is defined in `android/app/src/main/java/com/psami/copyyt/android/ui/Theme.kt` in the sibling repository.

## Applying the palette

Use semantic Tailwind utilities from `src/index.css` in extension views and components: `bg-page`, `bg-surface`, `bg-soft`, `text-ink`, `text-muted`, `border-line`, `bg-primary`, and `text-on-primary`. Use `success`, `warning`, and `danger` roles for feedback. These utilities switch automatically in dark mode, so avoid fixed hex colors in popup components. Keep the Copyyt logo and Chrome Store icons on the original brand blue; the Google sign-in logo keeps Google's own colors.

For a new button, pair `bg-primary` with `text-on-primary`. For a new status panel, use the matching `*-soft` surface and `on-*-soft` text color. Use the browser's `prefers-color-scheme` behavior when checking both modes, and keep visible focus outlines. The focused palette test checks shared colors, dark-mode coverage, and the principal text contrast pairs.
