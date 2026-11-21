---
version: alpha
name: AnyWear Client
description: "Design system for the AnyWear Client. Token values are the Tailwind CSS v4.3.3 defaults that the linked utilities resolve to; the project declares no @theme layer, so a token name is a documentation role and not a CSS custom property."
colors:
  # Surfaces
  surface: "oklch(96.7% 0.003 264.542)"            # bg-gray-100, main app shell
  surface-auth: "oklch(98.5% 0.002 247.839)"       # bg-gray-50, auth shell
  surface-card: "#ffffff"                          # bg-white, cards and panels
  # Text
  on-surface: "oklch(21% 0.034 264.665)"           # text-gray-900, titles
  on-surface-body: "oklch(37.3% 0.034 259.733)"    # text-gray-700, body
  on-surface-muted: "oklch(55.1% 0.027 264.364)"   # text-gray-500, secondary
  on-surface-subtle: "oklch(70.7% 0.022 261.325)"  # text-gray-400, subtle
  # Primary action and selection
  primary: "oklch(51.1% 0.262 276.966)"            # bg-indigo-600
  primary-hover: "oklch(45.7% 0.24 277.023)"       # bg-indigo-700
  primary-soft: "oklch(96.2% 0.018 272.314)"       # bg-indigo-50, selected tint
  # Destructive
  danger: "oklch(57.7% 0.245 27.325)"              # bg-red-600
  danger-hover: "oklch(50.5% 0.213 27.518)"        # bg-red-700
  danger-text: "oklch(63.7% 0.237 25.331)"         # text-red-500, error copy
  danger-soft: "oklch(93.6% 0.032 17.717)"         # bg-red-100, failed badge
  danger-soft-text: "oklch(44.4% 0.177 26.899)"    # text-red-800
  # Status
  warning-soft: "oklch(97.3% 0.071 103.193)"       # bg-yellow-100, processing
  warning-soft-text: "oklch(47.6% 0.114 61.907)"   # text-yellow-800
  info-soft: "oklch(93.2% 0.032 255.585)"          # bg-blue-100, pending look
  info-soft-text: "oklch(42.4% 0.199 265.638)"     # text-blue-800
  caution-soft: "oklch(96.2% 0.059 95.617)"        # bg-amber-100, low credits
  caution-soft-text: "oklch(47.3% 0.137 46.201)"   # text-amber-800
  caution-icon: "oklch(76.9% 0.188 70.08)"         # text-amber-500
  positive-soft: "oklch(96.2% 0.044 156.743)"      # bg-green-100, credits available
  positive-soft-text: "oklch(44.8% 0.119 151.328)" # text-green-800
  positive-icon: "oklch(72.3% 0.219 149.579)"      # text-green-500
typography:
  body:
    fontFamily: "Inter, system-ui, Avenir, Helvetica, Arial, sans-serif"
    fontSize: 0.875rem
    lineHeight: 1.25rem
  body-compact:
    fontSize: 0.75rem
    lineHeight: 1rem
  body-base:
    fontSize: 1rem
    lineHeight: 1.5rem
  title-sm:
    fontSize: 1.125rem
    lineHeight: 1.75rem
  title-md:
    fontSize: 1.25rem
    lineHeight: 1.75rem
  title-lg:
    fontSize: 1.5rem
    lineHeight: 2rem
  display:
    fontSize: 1.875rem
    lineHeight: 2.25rem
rounded:
  md: 0.375rem      # controls
  lg: 0.5rem        # cards, dialogs
  xl: 0.75rem       # modal panels
  full: 9999px      # pills, circular controls
spacing:
  "1": 0.25rem
  "2": 0.5rem
  "3": 0.75rem
  "4": 1rem
  "6": 1.5rem
  "8": 2rem
  "12": 3rem
components:
  page-surface:
    backgroundColor: "{colors.surface}"
  auth-surface:
    backgroundColor: "{colors.surface-auth}"
  card:
    backgroundColor: "{colors.surface-card}"
    rounded: "{rounded.lg}"
    padding: "{spacing.6}"
  dialog-panel:
    backgroundColor: "{colors.surface-card}"
    rounded: "{rounded.xl}"
  heading:
    textColor: "{colors.on-surface}"
    typography: "{typography.title-lg}"
  body-text:
    textColor: "{colors.on-surface-body}"
    typography: "{typography.body}"
  muted-text:
    textColor: "{colors.on-surface-muted}"
  subtle-text:
    textColor: "{colors.on-surface-subtle}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface-card}"
    rounded: "{rounded.md}"
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  selection-surface:
    backgroundColor: "{colors.primary-soft}"
    rounded: "{rounded.md}"
  button-destructive:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.surface-card}"
    rounded: "{rounded.md}"
  button-destructive-hover:
    backgroundColor: "{colors.danger-hover}"
  text-error:
    textColor: "{colors.danger-text}"
  badge-pending:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.info-soft-text}"
    rounded: "{rounded.full}"
    typography: "{typography.body-compact}"
  badge-processing:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.warning-soft-text}"
    rounded: "{rounded.full}"
    typography: "{typography.body-compact}"
  badge-failed:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger-soft-text}"
    rounded: "{rounded.full}"
    typography: "{typography.body-compact}"
  credits-low:
    backgroundColor: "{colors.caution-soft}"
    textColor: "{colors.caution-soft-text}"
    rounded: "{rounded.full}"
  credits-low-icon:
    textColor: "{colors.caution-icon}"
  credits-positive:
    backgroundColor: "{colors.positive-soft}"
    textColor: "{colors.positive-soft-text}"
    rounded: "{rounded.full}"
  credits-positive-icon:
    textColor: "{colors.positive-icon}"
  input-field:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.on-surface-body}"
    rounded: "{rounded.md}"
    typography: "{typography.body}"
---

# AnyWear Client Design System

The design system of the AnyWear Client, a Tauri build of the AnyWear wardrobe and virtual
try-on app for desktop and mobile. It covers the auth routes (`/login`, `/register`,
`/verify`), `/dashboard`, `/wardrobe`, `/fitting-room`, `/settings`, and their shared shells.

This document states the system the source defines, and it is the input to UI work. A
defect in the shipped UI belongs in a GitHub issue, not in this file.

## Overview

AnyWear is a quiet, light interface built around wardrobe and try-on photography: white
cards on gray page surfaces, dark gray text, compact controls, restrained feedback, and no
decoration that competes with the clothing.

- **Imagery carries the color.** Surfaces stay near-neutral so garments, base photos, and
  generated results supply the visual focus. Image and action hierarchy outranks any change
  to the primary color.
- **One light palette.** The system defines no dark variant, no theme switch, and no
  persisted theme preference.
- **Few color roles.** Indigo marks primary action, input focus, and image or outfit
  selection; red marks failure and destructive actions; yellow processing, blue pending,
  amber and green credit levels.
- **Two surfaces, one hierarchy each.** The Wardrobe manages the pieces themselves; the
  Fitting Room is where an outfit is composed — a room stages candidates in `To try on`, and
  one primary action either renders the ticked set (1 credit) or saves it without a look (0
  credits). A page names its own areas with one heading level per level: the tab title is the
  only `h1`, and each area is an `h2`.
- **Text and inline SVG carry the identity.** "AnyWear" renders as text in
  [AuthLayout](src/layouts/AuthLayout.tsx) and [MainLayout](src/layouts/MainLayout.tsx).
  There is no logo component and no icon library: icons are inline SVG, emoji, or text.
- **Tailwind utilities only.** [index.css](src/index.css) imports Tailwind, sets the body
  defaults and carries the global mobile touch layer described under
  [Components](#components); there are no CSS modules and no component stylesheet.

## Colors

[index.css](src/index.css) imports Tailwind with `@import "tailwindcss";`, and
[vite.config.ts](vite.config.ts) uses the Tailwind Vite plugin; [pnpm-lock.yaml](pnpm-lock.yaml)
pins **4.3.3**. There is no project `@theme`, no semantic custom color variable, and no
dark palette. The `--color-*` variables are framework defaults; the `colors` map in this
file's front matter restates the ones the system uses under documentation role names.

The body declares the literals `background-color: #f9fafb` and `color: #111827`. They are
separate from `bg-gray-50` and `text-gray-900`, whose v4 defaults are OKLCH. Use the pinned
default theme's own representation; do not substitute a v3 hex value.

| Role | Utility | Value (v4.3.3 default) |
| --- | --- | --- |
| Auth surface | `bg-gray-50` | `oklch(98.5% 0.002 247.839)` |
| App surface | `bg-gray-100` | `oklch(96.7% 0.003 264.542)` |
| Card, dialog, input | `bg-white` | `#fff` |
| Image overlay | `bg-black/50` | `#000` at 50% |
| Primary action | `bg-indigo-600`, hover `bg-indigo-700` | `oklch(51.1% 0.262 276.966)`, `oklch(45.7% 0.24 277.023)` |
| Selection and focus | `*-indigo-500` | `oklch(58.5% 0.233 277.117)` |
| Selected tint | `bg-indigo-50` | `oklch(96.2% 0.018 272.314)` |
| Title text | `text-gray-900` | `oklch(21% 0.034 264.665)` |
| Body text | `text-gray-700` | `oklch(37.3% 0.034 259.733)` |
| Secondary text | `text-gray-500` | `oklch(55.1% 0.027 264.364)` |
| Subtle text | `text-gray-400` | `oklch(70.7% 0.022 261.325)` |
| Borders and skeletons | `*-gray-200` | `oklch(92.8% 0.006 264.531)` |
| Input border | `border-gray-300` | `oklch(87.2% 0.01 258.338)` |
| Destructive action | `bg-red-600`, hover `bg-red-700` | `oklch(57.7% 0.245 27.325)`, `oklch(50.5% 0.213 27.518)` |
| Error text | `text-red-500` | `oklch(63.7% 0.237 25.331)` |
| Failed badge | `bg-red-100 text-red-800` | `oklch(93.6% 0.032 17.717)` / `oklch(44.4% 0.177 26.899)` |
| Processing badge | `bg-yellow-100 text-yellow-800` | `oklch(97.3% 0.071 103.193)` / `oklch(47.6% 0.114 61.907)` |
| Pending badge | `bg-blue-100 text-blue-800` | `oklch(93.2% 0.032 255.585)` / `oklch(42.4% 0.199 265.638)` |
| Low credits | `bg-amber-100 text-amber-800`, icon `text-amber-500` | `oklch(96.2% 0.059 95.617)` / `oklch(47.3% 0.137 46.201)` / `oklch(76.9% 0.188 70.08)` |
| Credits available | `bg-green-100 text-green-800`, icon `text-green-500` | `oklch(96.2% 0.044 156.743)` / `oklch(44.8% 0.119 151.328)` / `oklch(72.3% 0.219 149.579)` |

Status is never carried by color alone: every colored badge or message states its condition
in text.

## Typography

The body stack is `Inter, system-ui, Avenir, Helvetica, Arial, sans-serif`, declared in
[index.css](src/index.css). Inter is a preferred family name only: no bundled font,
`@font-face`, or download is configured, so the face depends on the host's installed fonts.
There is no display face and no project type token.

| Utility | Size / default line height | Role |
| --- | --- | --- |
| `text-xs` | 0.75rem / 1rem | Metadata, credit and history badges, mobile navigation, prompt counter |
| `text-sm` | 0.875rem / 1.25rem | Controls, helper text, history and outfit labels |
| `text-base` | 1rem / 1.5rem | Add-item action text below `sm` |
| `text-lg` | 1.125rem / 1.75rem | Fitting Room area headings, settings, and outfit-editor titles (`font-semibold`); auth and Add/Details titles (`font-medium leading-6`) |
| `text-xl` | 1.25rem / 1.75rem | Main brand (`font-bold`), loading and error headings (`font-semibold`), outfit heading |
| `text-2xl` | 1.5rem / 2rem | Fitting Room and wardrobe page headings (`font-semibold tracking-tight`) |
| `text-3xl` | 1.875rem / 2.25rem | Auth brand (`font-extrabold`) |
| `text-4xl` | 2.25rem / 2.5rem | Weather temperature (`font-bold`) |
| `text-5xl` | 3rem / 3rem | Weather emoji |

Weights in use are 400, 500, 600, 700, and 800. Three local exceptions exist and define no
new scale: `leading-relaxed` with `line-clamp-2` for weather advice, `uppercase
tracking-wider` for popular-city chips, and `text-[10px] leading-none` for the remove-image
control.

## Layout

Spacing follows Tailwind's default `--spacing` of **0.25rem**: `1` 0.25rem, `1.5` 0.375rem,
`2` 0.5rem, `3` 0.75rem, `4` 1rem, `6` 1.5rem, `8` 2rem, `12` 3rem. Half steps appear in the
room switcher and the try-on action (`py-1.5`).

| Area | Layout |
| --- | --- |
| Auth shell | `min-h-screen`, centered column, `py-12 sm:px-6 lg:px-8`; form `sm:max-w-md` (28rem); white card `py-8 px-4 sm:px-10` |
| App shell | `min-h-screen bg-gray-100`; top bar `h-16`; nav `max-w-7xl mx-auto px-4 sm:px-6 lg:px-8`; main `flex-1 px-4 pt-6 pb-24 sm:px-6 sm:pb-6 lg:px-8` |
| Fitting Room | `space-y-6 sm:space-y-8`; the room switcher is a white `rounded-xl border border-gray-200 p-3 shadow-sm sm:p-4` strip below the `h1`; the two areas are white `rounded-xl border border-gray-200 p-4 shadow-sm sm:p-6` sections; the base-photo and prompt cards sit in `grid grid-cols-1 gap-6 md:grid-cols-2`; the compose panel is `rounded-xl border border-indigo-100 bg-indigo-50/40 p-4 sm:p-6`; the wardrobe area grids `grid-cols-2 sm:grid-cols-3 md:grid-cols-4` |
| Wardrobe | grids `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5` |
| Settings and dashboard | Settings `max-w-lg` (32rem) centered with `space-y-8` and `p-6` cards; dashboard `space-y-6`, details `sm:grid-cols-3` |
| Wardrobe and Fitting Room dialogs | fixed `inset-0`: Add/Details `z-10` with `sm:max-w-lg shadow-xl`; the Add dialog's photo list is one `rounded-md` row per photo in `space-y-2`, each with `border-gray-200` and `px-3 py-2`; the outfit dialog, the room-name dialog and the room-delete dialog are `z-50` with `max-w-lg w-full p-5 sm:p-6` (the room dialogs `max-w-md`) |

Main content runs full width to its maximum. Image proportions are fixed by role: garment
and base-photo frames use `aspect-[4/5]` with `object-cover`; history thumbnails keep 3:4;
generated results use a `max-h-[70vh] object-contain` area.

Below `sm` the main column reserves `pb-24` so the last card can scroll clear of the fixed
bottom navigation; the `sm` breakpoint returns `pb-6` for the desktop layout, which has no
bottom bar. `index.html` declares `viewport-fit=cover`, and the Android shell's
`MainActivity` pads its content view once for `systemBars | displayCutout | ime` — the CSS
therefore adds no `env(safe-area-inset-*)` of its own. One owner for the inset, no double
padding, and the keyboard covered by the same code path.

## Elevation & Depth

Depth comes from Tailwind's default shadow scale and a small z-index set. There is no
project elevation token.

| Utility | Default shadow | Used for |
| --- | --- | --- |
| `shadow` / `shadow-sm` | `0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)` | Cards and widgets |
| `shadow-md` | `0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)` | Wardrobe card hover |
| `shadow-xl` | `0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)` | Dialog panels |

Wardrobe cards gain `hover:shadow-md`. Overlays stack in three bands: `z-10` for the
Add/Details dialogs, `z-50` for the outfit dialog, the room-name and room-delete dialogs,
the Amplify bootstrap overlay, and the history image viewer. The `z-50` full-page `FullPageLoading` overlay is now the bootstrap
splash only. There are two full-page states, not one: that bootstrap splash, and the
blocking update-required screen, which replaces the whole shell — navigation included —
when the Service refuses this Client version. A profile read, a route-module wait and a
route-module failure are all in-page surfaces inside the content column, beside the
navigation. These three shadows are the whole elevation system; the document
format defines no token group for elevation, so it stays in prose.

## Shapes

Controls use `rounded-md` (0.375rem), cards and dialogs `rounded-lg` (0.5rem), modal panels
`rounded-xl` (0.75rem), and pills or circular controls `rounded-full`. Borders are 1px
(`border`); selected photos and items use `border-2`; selection adds `ring-1` or `ring-2`.

Border and ring color has no component sub-token in the document format, which accepts
`backgroundColor`, `textColor`, `typography`, `rounded`, `padding`, `size`, `height`, and
`width`. Those colors therefore stay here: `border-gray-200` for skeletons,
`border-gray-300` for inputs, and the `*-indigo-500` selection and focus family from
[Colors](#colors).

## Components

The system defines styling for these reusable pieces. It is not a component library: there
is no generic `Button`, `Input`, `Card`, `Badge`, or `Modal` component, and each screen
composes the utilities below.

| Piece | Styling |
| --- | --- |
| Primary action | `bg-indigo-600 text-white rounded-md`, hover `bg-indigo-700`; busy or unavailable states use native `disabled` with `disabled:opacity-50` and change the label |
| Secondary action | White surface with a gray border, paired with the primary action |
| Destructive action | `bg-red-600 text-white rounded-md`, hover `bg-red-700` |
| Card | `bg-white rounded-lg shadow`, `p-6` for page-level cards; `hover:shadow-md` where the card is a link or tile |
| Outfit card cover | The `aspect-[4/5]` cover of a saved outfit shows one of five states, in this precedence: a completed look with a signed `url` paints the image and the action reads `New look`; a `Pending` or `Processing` generation without a look paints an `animate-pulse` skeleton with `aria-busy="true"` and the action row reads `Generating…` with no button; a `Failed` last generation without a look paints `Last try-on failed` and the action reads `Retry`; a completed look whose `url` is null paints `Image unavailable` and the action reads `New look`; no generation at all (`latestGeneration` and `look` both null) paints the bundled placeholder graphic with the caption `No look yet` and the action reads `Generate look`. The two no-image states keep separate predicates and are never collapsed: the placeholder is a Client resource and makes no image request, while `Image unavailable` reports a completed generation whose signed URL is missing. A failed last generation keeps `Retry` while an older completed look stays painted, and the status badge stays beside the action. |
| History card actions | `bg-black/50` scrim over the card's image area only: an `absolute inset-0` child of the `relative aspect-[3/4]` media wrapper, revealed by pointer hover anywhere in the card or by focus within the overlay itself; the actions stay in the tab order and the accessibility tree while hidden, and Delete keeps the overlay visible while it swaps the action set in place for a confirmation (`Yes, Delete` / `Cancel`) rather than opening a dialog. The base-photo card takes the same in-place swap for its own `Delete this base photo?` question with `Yes, Delete` and `Cancel`, closes it on `Escape`, and keeps that question's overlay visible while it is open; its `Escape` handler sits on that card's media wrapper, which holds the focused answers, so a keydown from elsewhere in the selector leaves the question up. The card body — timestamp, status badge, item count, rating and any rating-failure sentence — is outside the overlay and stays visible and pressable while the actions are revealed |
| Dialog panel | White surface, `rounded-xl shadow-xl`, `z-10` for Add/Details and `z-50` for the outfit dialog, the Fitting Room's room-name and room-delete dialogs, the wardrobe delete confirmation and the history image viewer, whose panel is the image itself; dismissed by backdrop click and Escape, with focus moved into the panel on open and restored to the control that opened it on close. While any panel is open the page behind it does not scroll: the shared dialog hook hides body overflow on the first open panel and restores the previous inline value when the last one closes. |
| Text input | White surface with `border-gray-300` and `rounded-md`; focus moves the border to indigo and, in the dialogs, paints the 2px indigo ring inset where a scrolling form would clip an offset. |
| Status badge | `rounded-full` pill with `text-xs`, one of the pending, processing, or failed pairs from [Colors](#colors), always paired with text. The Add dialog's photo rows use the same pill for their step: the pending pair for `queued`, the processing pair for `preparing`, `reserving`, `uploading` and `confirming`, the failed pair for `failed`, and the app surface and body text colors (`bg-gray-100 text-gray-700`) for `created`. |
| Capture entry | The platform the app runs on decides the entries, and the window size never does. In the web build and the desktop client each photo surface renders one upload entry: the Fitting Room's Step 1 button `Upload`, the Add Item dialog's `Upload a file or take a photo` (multi-select), and the item details dialog's `w-16 h-16` dashed `+` tile named `Add image`. Each entry drives one `<input type="file">` with `accept="image/jpeg,image/png,image/webp"` and no `capture` attribute — hidden in the Fitting Room and in the item details dialog, `sr-only` under the Add Item dialog's label — so the click always opens the picker. In the Android app each of the three surfaces renders two entries beside each other: `Choose from library` (the same narrow list; multi-select only in the Add dialog) and `Take photo` (`accept="image/*"`, `capture="environment"`, one file). The `image/*` token is what makes wry open the system camera through `ACTION_IMAGE_CAPTURE`; the narrower library list only ever opens the picker, which is why the camera entry is the one that reaches a camera. Both Android entries stay visible while the other path is disabled or has just failed, so a cancelled or undecodable shot leaves the library one click away. A cancelled chooser (no file) shows no hint on either platform; a decode or format failure shows an inline message beside the entries. |
| Touch behaviour | [index.css](src/index.css) sets `touch-action: manipulation` on controls, `user-select: none` with `-webkit-touch-callout: none` on interactive shells and imagery, and restores `user-select: text` on inputs, textareas and `contenteditable` nodes; `overscroll-behavior-y: contain` stops the whole-page rubber band. Inside the Tauri shell [touch.ts](src/lib/touch.ts) additionally cancels `contextmenu` outside editable fields, covering the Android WebView long-press menu that CSS cannot close. |
| Selection card | `aspect-[4/5]` image with `rounded-lg`; unselected uses a gray border, selected uses an indigo border with `ring` and a text label. The base-photo card's image button and its action overlay share one `relative` media wrapper, so the overlay's box ends with the image: `absolute inset-x-0 bottom-0` with a `bg-gradient-to-t from-black/60 to-transparent` scrim, always visible below `sm` and hover- or focus-revealed at and above it, and a flat `bg-black/60` while its confirmation is open. While its DELETE is in flight the card reads `Removing…` and every delete control is disabled |
| Fitting Room `Wardrobe` area | The room's full active wardrobe: a white card holding one search input (`type="search"`, `rounded-md border-gray-300 px-3 py-1.5 text-sm`) and two `Select` controls labelled `Color` and `Material`, then `rounded-full` category chips (`bg-indigo-600 text-white` when pressed, `bg-gray-100 text-gray-700` otherwise) over a `grid-cols-2 sm:grid-cols-3 md:grid-cols-4` grid capped at `max-h-96` with its own scroll. Each card is an `article` with an `aspect-[4/5]` cover and one `Add to try on` action (`w-full rounded-md bg-indigo-50 px-2 py-1.5 text-xs font-medium text-indigo-700`) whose accessible name is `Add <name> to try on`. Search filters the fetched list on the client; the request carries only `category`, `color` and `material`. |
| Fitting Room `To try on` area | A `divide-y divide-gray-100 rounded-lg border border-gray-200` list of staged rows, each `flex flex-wrap items-center gap-3 p-2.5` with an `h-12 w-12` thumbnail, the piece name, an optional `Archived` pill (`bg-amber-100 text-amber-800`, `rounded-full px-2 py-0.5 text-xs`), a `Select`/`Deselect` toggle (`aria-pressed`; `bg-indigo-600 text-white` when on, `bg-gray-100 text-gray-700` when off) named `Select <name>` / `Deselect <name>`, and a red-text `Remove` named `Remove <name> from try on`. An archived row keeps its place but its toggle is disabled. The counter is one `rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold` pill reading `N / 5`, beside the `aria-live` sentence `N of 5 selected`. |
| Room switcher | One white strip below the page `h1`: a `role="group"` named `Fitting rooms` of `rounded-full px-3 py-1 text-sm` buttons — the open room `bg-indigo-600 text-white`, the others `bg-gray-100 text-gray-700` — each followed by its staged count in `text-xs`; beside it `New room` (`bg-indigo-50 text-indigo-700`), `Rename` (`bg-gray-100 text-gray-700`) and `Delete` (`bg-red-50 text-red-700`), all `rounded-md px-3 py-1.5 text-xs font-medium`. Switching reports the room id only; `Rename` and `Delete` are disabled when no room is open. |
| `TryItOnSwitch` | The compose step's option, a `button` with `role="switch"` and `aria-checked`, named exactly `Try it on now (1 credit)`; its visible text is the same sentence, so the price of the on state is always readable. The track is `h-5 w-9 rounded-full` (`bg-indigo-600` when on, `bg-gray-300` when off) with an `h-4 w-4` white knob that slides between `translate-x-0.5` and `translate-x-4`. It changes only which primary action renders below it; it never changes which `To try on` rows are ticked. |
| Compose primary action | One full-width `w-full rounded-lg px-4 py-3 text-sm font-semibold` button whose identity the switch decides. On: `Generate try-on` with the statement `This uses 1 of your daily credits.`; off: `Save outfit` with `No credit is charged for saving an outfit.` The busy labels are `Generating...` and `Saving...`; the on state keeps `Credits Unavailable` for an unknown balance and `Out of Credits` for zero. Disabled paints `bg-gray-300 text-gray-500`; otherwise `bg-indigo-600` with `hover:bg-indigo-700`. Both identities are disabled with nothing ticked, and the off identity stays enabled at zero credits because it spends none. |
| Credit pill | `rounded-full px-3 py-1.5 text-sm font-medium`. A known balance is colored by remaining credits: green above 2, amber at 1–2, red at 0. With no profile (or a null balance) it states the unknown state instead of `0/10`: `bg-gray-100 text-gray-600`, the text `Credits unavailable`, and `aria-label="Daily credits unavailable"`. |
| Page-area route loading card | Rendered inside `MainLayout` and `AuthLayout` as the keyed `Suspense` fallback, sized to the content column (`rounded-xl border border-gray-200 bg-white px-6 py-12 text-center shadow-sm`), never `fixed` and never full-screen, so the navigation stays usable. `role="status"`; an `aria-hidden` spinner; the visible sentence `Loading {destination}...` where the destination is `dashboard`, `wardrobe`, `the fitting room`, `settings`, `sign in`, `registration` or `email verification` (anything else is `page`). |
| Route error card | The in-page card for a route subtree whose module failed to load: `role="alert"`, `rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm`, heading `This page didn't load`, body `The page could not be loaded. Check your connection and reload the app.`, one `Reload` button and the router links `Back to dashboard` and `Back to wardrobe`. Reload is the only recovery control, because React caches a rejected `lazy()` promise and a remount re-throws; the links only navigate. |
| Update-required screen | The blocking full-page card shown in place of the whole shell when the Service refuses this Client version with `400 CLIENT_VERSION_UNSUPPORTED`: `fixed inset-0 z-50` on `bg-gray-100`, holding a `max-w-lg` white card with `rounded-xl border border-gray-200 p-6 text-center shadow-sm` and `role="alert"`. It states the required version and this build's version, then offers exactly one platform action: on the web build a `Reload` button that reloads the document; in the Android and desktop shells a read-only `text` field on `bg-gray-50` and `border-gray-300` whose value is the Releases page address, with one `Copy` button beside it, and the desktop variant also states that no desktop build is published. Nothing on it offers a retry, a wait, a pending state or a navigation, and when the Clipboard API is absent or rejects, `Copy` selects the field's whole value and the hint names the gesture instead of claiming the copy happened. |
| Profile notice | Inside `MainLayout` above the routed page, in normal flow and never full-page or `fixed`. Pending: a `role="status"` white notice with the sentence `Checking your profile...`. Failure, after the shared query policy's retries: a `role="status"` amber notice (`bg-amber-100 text-amber-800`) with `We couldn't load your profile. Some features may be unavailable until it loads.` and a `Retry` button that re-runs `GET /users/me` (disabled while fetching). It renders nothing once a profile exists, including when a cached profile survives a failed refetch, and it never replaces the navigation or the page. |
| Weather states | Pending: a `role="status"` card with the visible label `Loading weather...` and `aria-hidden` pulse placeholders; no `Set Location` and no error card. 404: the `Set Location` card. Any other failure: the sentence `Unable to load weather data. Please try again later.` and a `Retry` button that calls the query's `refetch()`; cached data stays on screen through a failed refresh. |
| Unknown credit state | With no profile the Fitting Room disables its primary action, which reads `Credits Unavailable`, and states `Your credit balance is unavailable. Try-on is disabled until your profile loads.` The history section's retry blocker reads `Your credit balance is unavailable.` A known zero balance keeps `Out of Credits` and `Out of daily credits. Credits reset at midnight.` |
| Error message | `text-red-500` for field and inline errors; `role="alert"` for a failure the user must notice. A failed photo row states its cause in `text-xs text-red-500`. A refused base-photo delete states its sentence in `text-xs text-red-500` in a `role="alert"` paragraph after the card's media wrapper, so the action overlay never covers it. The wording follows the cause the Service reported: a 409 that names try-ons reads `This photo is used by N try-on(s). Delete it/them in History first.`, or `This photo is used by a try-on. Delete it in History first.` when the count is absent; any other 409 keeps the Service's own hint; a 403 and every other refused status keep the Service's `message` (`A shared system base photo cannot be deleted` for a system photo); a 5xx reads `Could not remove this photo (server error N). Try again.`; a request that never reached the server reads `Could not reach the server. Check your connection and try again.`; and a 404 reports nothing because the row is already gone and leaves with the refreshed list. A refused wardrobe item delete states its sentence in a `role="alert"` inside the confirmation that sent it, from one mapping shared by both surfaces: a 409 that names the `outfit` dependent reads `Nothing was deleted: this item is still in 1 outfit. Remove it from that outfit, or delete the outfit. An outfit cannot be saved with no items, so if this is its only item, delete it.`, `… is still in 3 outfits. Remove it from those outfits, or delete them. … an outfit holding only this item has to be deleted.` with the Service's number, or the same `one or more outfits` wording when the count is absent; a 409 naming no `outfit` keeps the Service's `hint`, or reads `Something still depends on this item, so it was not deleted.` when it sent none; a 5xx reads `Could not delete this item (server error N). Try again.`; a request that never reached the server reads `Could not reach the server. Check your connection and try again.`; any other refused status keeps the Service's `message`, or reads `Could not delete this item.` when it sent none; and a 401 paints nothing because the interceptor is redirecting to `/login`. A wardrobe item delete `404` is not a failure: the surface closes, the card leaves, and the page's dismissible `role="status"` notice reads `This item is no longer in your wardrobe, so it was removed from this list.`, beside the started re-tag's `Re-tagging started. Check back shortly.` and the outfit-cleanup sentence above. A failed item update reads `Failed to update item` and a failed re-tag reads `Failed to start re-tagging`, each in a `role="alert"` paragraph above the details dialog's action row; a failed single-photo Add Item upload reads `Failed to upload image: <cause, else Unknown error>` in a `role="alert"` paragraph beside the batch summary. A failed rating save states its sentence in `text-xs text-red-700` directly under the stars that sent it — inside the result area's `Complete` card or the history card — in a `role="alert"` paragraph that takes no focus and adds no control; choosing a star again is the retry. |
| Outfit delete confirmation | Inside the edit dialog, the confirmation states exactly one number, the `generationCount` the Service reports: `Delete this outfit? This also deletes its N try-on record(s) and their images. This cannot be undone.` A true zero keeps `Delete this outfit? This cannot be undone.`, and an absent or null count keeps the wording without a number. A `Pending` or `Processing` generation appends `A try-on that is still running is cancelled and its credit is not returned.` A `404` and a `502 OBJECT_DELETION_INCOMPLETE` both finish the delete: the dialog closes and the page refreshes its list. The 502 leaves a dismissible page-level `role="status"` notice near My Outfits reading `Outfit deleted. 2 images are still being cleaned up in the background.` (`1 image is …` in the singular) and never a failure sentence or retry control. Any other status keeps the dialog open with a `role="alert"` sentence `Delete failed with status N.`, or `Delete failed.` when the request never reached the Service. |
| Wardrobe item delete confirmation | Both delete surfaces render their own question; neither is a host script dialog, so the one bundle asks and answers identically on the browser, Windows, macOS and Android builds. The grid card opens a page-level `role="dialog"` `aria-modal` panel titled `Delete this item?` over a `bg-gray-500/75` backdrop, whose body names the item — its name, then its category, then `This item` — as `<name> will be removed from your wardrobe. This cannot be undone.`, with `Cancel` focused first and `Delete item` beside it. The item details dialog replaces its own `Delete` control in place with the sentence `Delete this item? This cannot be undone.` and `Cancel` (focused) and `Delete`, while Save Changes, Re-tag and the dialog's own Cancel keep their places. Nothing is sent until the affirmative is pressed. While the `DELETE` is out the affirmative reads `Deleting...` and is disabled and every exit is inert — the panel's `Cancel`, its backdrop and `Escape`, and inside the details dialog its close control, backdrop, action-row `Cancel` and `Escape` — so one confirmation cannot issue two requests and no surface closes under a settling delete. Declining sends nothing and returns focus to the control that asked; a confirmed delete closes the surface, trims the row from every cached wardrobe list, re-reads the list once and moves focus to the `Wardrobe items` region, because the card that asked is gone. |
| Rating control | Five stars in a `div` with `role="radiogroup"` named Rate this result, each star a `button` with `role="radio"` and `aria-checked`; one tab stop with arrow-key selection; the focused star paints a 2px indigo ring (`focus-visible:ring-2 focus-visible:ring-indigo-500`); filled stars use `text-indigo-500` and outline stars `text-gray-300`, and the sentence uses `text-sm text-gray-600`. A chosen star shows `N of 5 selected` until the API holds it, then `Your rating: N/5` (`Your rating: N out of 5` for screen readers); a read-only rating is text (`Your rating: N/5`) with the stars as decoration. A failed save restores the stored stars through `echoResetToken` in place, without moving focus or remounting the widget. |

The History card actions row costs a second Components entry for one surface and restates
Tailwind's `focus-within` and `group-hover` utilities instead of naming a project token. It is
recorded because the reveal is the component's new interaction state, and an undocumented
interaction state is the larger cost. The overlay is contained rather than stacked: its box is
the media wrapper's padding box, and that wrapper's `overflow-hidden` clips a taller action stack
at the image edge instead of letting it spill onto the rating row. Containing the overlay puts it
before the card body in the DOM, so a card's tab and reading order runs actions, then timestamp,
badge, item count and rating.

Focus in the Wardrobe dialogs is a 2px indigo ring, defined per control rather
than inherited from a shared component: `focus:` on controls, `focus-within:` on the labels
that paint for AddItem's `sr-only` file inputs (the multi-select picker, and on Android the
camera input), `ring-offset-2` on buttons outside a clipping container, `ring-inset` where a
scrolling form or list would clip an offset, and `focus:border-indigo-500` on the text inputs
and the View select; `:focus` also paints on the panel's opening focus and on a pointer
click. The Add dialog's photo rows add two such controls, the per-row remove button and
`Retry failed`, both `focus:ring-2 focus:ring-indigo-500`. While a batch runs, the dialog
disables its file inputs and every per-row remove button so the row list cannot diverge from
the run's targets: the remove buttons keep those ring tokens and dim through
`disabled:opacity-50`, and the file-input labels dim with `opacity-50 cursor-not-allowed` while
keeping their `focus-within:` tokens. The dialogs set both a width and a
color, so the ring is indigo whatever the control's text color. A ring color without a ring
width is not a focus treatment, and a width alone falls back to `currentColor`, which does not
reliably contrast; both are set here. Other surfaces keep their own focus rules and are not
changed here.

Motion uses Tailwind's defaults: `transition-*` utilities at 150ms with `cubic-bezier(0.4, 0,
0.2, 1)`, plus `animate-spin` for busy spinners and `animate-pulse` for skeletons. No custom
duration, easing, or animation library is defined.

## Do's and Don'ts

- Do keep garment, base-photo, and result imagery as the loudest element on every screen.
- Do reserve indigo for primary action, focus, and selection, and keep the status pairs
  meaningful and text-labelled.
- Do list a design token only when source resolves to its value. A proposed palette, font,
  scale, or geometry is not part of this system until it ships.
- Do record a framework default in its native representation, including OKLCH where the
  pinned default theme uses OKLCH.
- Do keep the fixed image proportions: `aspect-[4/5]` covers for garments and base photos,
  contain for generated results.
- Do pair every colored state with text, because color alone does not carry the meaning.
- Do name every control from its own text: `htmlFor`/`id` or a wrapping `<label>` for one
  control, `role="group"` with `aria-labelledby` (or `<fieldset>`/`<legend>`) for a group, and
  `sr-only` text or `aria-label` for an icon-only control.
- Don't describe a role such as "primary action" as a CSS custom property. The project
  declares no `@theme` layer, and the token layer is documentation.
- Don't add a color, font, spacing step, or radius without a source definition in the same
  change.
- Don't claim WCAG conformance, measured contrast, or device parity from source inspection
  alone.
- Don't give a terminal, non-dismissible state a way to wait, retry or navigate away: the
  update-required screen names one way to a new build and nothing else.
- Do keep the two heading levels apart on the Fitting Room: the tab is the only `h1`, and the
  areas named `Wardrobe` and `To try on` are `h2` with one purpose sentence each, because the
  area shares its name with the tab on purpose.
- Do state the price on the action that is currently there. The switch changes the primary
  button and its credit sentence together; it never changes the ticks.
- Do paint a saved-without-look outfit with the bundled placeholder and `Generate look`, and
  keep `Image unavailable` for a completed generation whose signed URL is missing.
- Don't move a defect into this document. Fix it, or track it in a GitHub issue.
