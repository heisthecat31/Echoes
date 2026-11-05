# Echoes — Design Spec

A desktop client for YouTube Music. You still sign in with your Google account. Echoes
wraps the official web player in a native window and replaces the chrome around it with its
own UI.

## 1. Principles

1. **The music sets the color.** Every surface takes its accent from the current album art.
   The app looks different on every song.
2. **Quiet chrome, loud content.** The title bar and player bar are dark glass and stay out
   of the way. Artwork is the only big color on screen.
3. **One motion language.** Everything eases with `cubic-bezier(.2,.8,.2,1)` over
   180 / 320 / 600 ms (micro / panel / scene).
4. **Native feel.** Frameless window, custom window controls, drag regions, taskbar
   thumbnail buttons, tray, OS media keys through the Media Session.

## 2. Architecture (why it looks the way it does)

```
┌──────────────────────── BrowserWindow (frameless, "shell") ───────────────────────┐
│  Title bar 48px   ← shell HTML: back / forward / home · brand · window controls   │
├────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                    │
│      WebContentsView → music.youtube.com  (transparent background,               │
│      restyled with injected CSS; its own player bar is hidden)                     │
│                                                                                    │
├────────────────────────────────────────────────────────────────────────────────────┤
│  Player bar 92px  ← shell HTML, drives the YT player through IPC                  │
└────────────────────────────────────────────────────────────────────────────────────┘
        behind everything: ambient layer = blurred album art + accent gradients
```

* The YTM view is transparent, so the shell's ambient glow shows through behind it.
* **Now Playing** and **Mini Player** hide the YTM view and use the whole window as the
  shell's own scene.
* A bridge script in YTM's page reads the `#movie_player` API and the Media Session, then
  sends state to the shell. Commands go back the same way.
* The main process samples the album art (via `nativeImage`, so no CORS problems) and works
  out the accent color.

## 3. Design tokens

| Token | Value | Use |
|---|---|---|
| `--bg-0` | `#07070a` | window base |
| `--bg-1` | `rgba(16,16,22,.62)` | glass surfaces |
| `--line` | `rgba(255,255,255,.07)` | hairlines |
| `--text-1` | `#f5f5f7` | primary text |
| `--text-2` | `rgba(245,245,247,.62)` | secondary text |
| `--text-3` | `rgba(245,245,247,.38)` | tertiary / timestamps |
| `--accent` | dynamic (default `#ff4e6a`) | progress, active states, glow |
| `--accent-soft` | accent @ 18% | hover fills, chips |
| `--radius-s/m/l` | 8 / 12 / 20px | buttons / cards / artwork |
| `--blur` | `saturate(160%) blur(28px)` | glass |

**Type:** `Inter`, then `Segoe UI Variable`, `SF Pro`, `system-ui`.
Sizes: 11 (meta) · 13 (body) · 15 (title in the bar) · 40–64 clamp (Now Playing title,
weight 750, tracking −0.03em).

**Accent derivation:** sample the art down to 24×24 px. Score each pixel as
`saturation × (1 − |lightness − 0.55|)`. Keep the top-weighted color, clamp its lightness to
0.55–0.70 so it reads on dark, and blend between colors over 600 ms.

## 4. Components

### Title bar (48px, drag region)
`[◀] [▶] [⌂]  ·  ◉ Echoes  ·············  [⤢ now playing] [▣ mini] │ [—] [▢] [✕]`
* Nav buttons are 32px ghost icons that hover to `--accent-soft`.
* Close hovers to `#e5484d`. On macOS the native traffic lights are used instead.

### Player bar (92px, glass)
```
┌ art 56 ┐ Title ♥              ⤮   ⏮   ( ▶ )   ⏭   ⟲              ≡  ▣  🔊 ━━━━○──
└────────┘ Artist · Album      0:42 ━━━━━━━━━━━━○──────────── 3:31
```
* Play is a 40px white circle with a dark glyph, and it scales to 1.06 on hover.
* Progress is a 4px track that grows to 6px on hover. The fill is `--accent` and a knob
  appears on hover. A hover tooltip shows the time at the cursor.
* Like is a heart that fills with the accent and plays a small pop animation.
* Active shuffle / repeat get an accent dot underneath. Repeat-one gets a "1" badge.

### Now Playing (full-window scene)
* Background: the artwork at 140% scale with `blur(90px) saturate(180%)` and opacity .55,
  under a vignette and a 3% film-grain noise layer.
* Left: artwork up to 520px, radius 20, with a long accent-colored shadow. It "breathes"
  (scale 1 → 1.015) while playing and shrinks to .94 when paused.
* Right: title (display size), artist, album, a big progress bar, a big controls row, and an
  **Up Next** list (click to jump, current track highlighted).
* `Esc` or the collapse chevron closes it.

### Mini Player (340×340, always on top)
* The artwork fills the window. On hover a gradient scrim fades in with the title, the
  controls, and a thin progress bar at the bottom edge.
* Drag anywhere to move. The expand button goes back to the full window.

## 5. YouTube Music restyle (injected CSS)
* Transparent backgrounds on the app, nav bar, and guide, so the ambient glow shows through.
* YTM's own player bar is hidden and its reserved height is removed.
* Thin translucent scrollbars, 12px card radius, a softer hover lift on cards.
* The font stack is swapped to match the shell.

## 6. Accessibility
* Every icon button has an `aria-label` and a tooltip.
* Visible focus rings (2px accent).
* `prefers-reduced-motion` turns off the breathing, blur transitions, and scene animations.
* Text contrast is at least 4.5:1 against `--bg-0` for primary and secondary text.
