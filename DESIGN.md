# Kapsula v4 — Visual World & Motion Specification (`DESIGN.md`)

> **Aesthetic:** Tactile Obsidian Craft — calm spatial hierarchy inspired by Things 3, MyMind, Raycast, and Apple Wallet / Dynamic Island, with Emil Kowalski's crisp dark-surface lighting and restrained physics.

## 1. Obsidian Surface Hierarchy
Depth comes from tonal layering, neutral elevation shadows (`0 20px 48px rgba(0, 0, 0, 0.62)`), and crisp neutral specular highlights (`inset 0 1px 0 rgba(255, 255, 255, 0.065)`) — never colored ambient glows, radial spotlights, nested boxes, or `1px` colored side tabs.

| Surface Role | Value | Usage |
| --- | --- | --- |
| `--bg-canvas` | `#090B0F` | Vault window backdrop |
| `--bg-rail` | `#0C0F15` | Left navigation rail |
| `--bg-card` | `#11151D` | Resting masonry & list items |
| `--bg-card-hover` | `#151A24` | Pointer hover elevation (`hover: hover`) |
| `--bg-matte` | `#171C26` | Adaptive dark matte for light OpenGraph banners |
| `--bg-floating` | `#131822` | Popovers, Select menus, Quick Pocket, HUD |
| `--bg-drawer` | `#0F131B` | Floating overlay Inspector & AI Chat sheets |
| `--border-hairline` | `rgba(255, 255, 255, 0.07)` | Hairline surface separation |
| `--border-focus` | `rgba(245, 165, 36, 0.55)` | Keyboard & input focus ring |

## 2. Accent & Text Contrast
- **Primary Accent (Warm Amber):** `#F5A524` (bright focus `#FBBF24`) — primary capture CTA, active ring, Orb core, pinned accent.
- **Security Accent (Vault Emerald):** `#10B981` / text `#34D399` — encrypted vault actions and active clipboard countdown.
- **Voice Live Indicator (Coral):** `#F43F5E` — reserved strictly for active microphone capture.
- **Text Scale (WCAG AA compliant on `#090B0F`–`#171C26`):**
  - Primary `--text-1`: `#F3F5F9`
  - Secondary `--text-2`: `#C3CAD7`
  - Muted `--text-3`: `#8E97AA`

## 3. Typography & Numeric Discipline
- **UI & Editorial Sans:** `'Onest Variable', 'Segoe UI Variable Text', system-ui, sans-serif` (distinctive modern geometric-humanist Cyrillic + Latin variable face).
- **Mono (Card Digits, Shortcuts, Code, Timers):** `'JetBrains Mono Variable', 'Cascadia Mono', monospace`.
- **Numbers:** `font-variant-numeric: tabular-nums` on every counter, countdown (`25с`), audio timestamp (`01:24`), card pan, and file size.

## 4. Motion Choreography & Layout Stability
- **Canonical Easing & Springs:**
  - `--ease-out`: `cubic-bezier(0.23, 1, 0.32, 1)` (`150–180ms` for popovers, dropdowns, pills, card hover, slot swaps).
  - `--ease-drawer`: `cubic-bezier(0.32, 0.72, 0, 1)` (`220ms` for floating `InspectorDrawer` and `AskVaultDrawer` overlays).
  - `SPRING_TACTILE`: `{ type: 'spring', duration: 0.36, bounce: 0.14 }` (Orb <-> Quick Pocket morph, `AnimatedSegmented` pill, `FamilyDrawer` dialog height).
- **Zero Geometry Jump Laws:**
  - Drawers slide over `<main>` as floating overlays (`0px` Masonry reflow).
  - Scroll containers use `OverlayScrollbarsComponent` (`0px` gutter jump when accordions expand).
  - Cards pre-reserve metadata & action slots (`0px` bank-card reveal height jump, `0px` note pin height jump, `0px` copy button wrap/resize).
  - Popovers/Dialogs scale from `0.96 -> 1` around `var(--transform-origin)`.
  - `prefers-reduced-motion: reduce` simplifies transforms to gentle `120ms` opacity crossfades without removing interactive confirmation.

## 5. Transparent Electron Window Constraints
- `.surface-capsule` (`420x548`) and `.surface-hud` (`680x460`) enforce `backdrop-filter: none !important` and maintain a `24px+` clear margin so outer `2px` window pixels stay strictly `alpha === 0`.
