# Danmaku Scroll

An example that shows how to build an **infinite horizontal danmaku (bullet-comment) marquee** in Lynx, driven entirely by main thread scripts for jank-free scrolling.

This example is UI-only and ships with mock data — there is no networking or business logic.

## What it demonstrates

- **Infinite horizontal scrolling** built on `<list scroll-orientation="horizontal">`.
- **A/B dual-segment recycling**: each row renders its data twice (segment A + segment B) so the content can loop seamlessly.
- **Main thread boundary normalization**: `scrollToPosition` runs on the main thread to re-center the list at the A/B seam, keeping the loop invisible to the user.
- **Auto scroll, gesture drag and momentum** modes (`normal` / `fastStop` / `none`).
- **Multi-row layout** with configurable row count, row height and gaps.
- A small control panel to toggle auto scroll, switch momentum mode, change the number of rows and reload the mock data set.

## Project structure

- `src/App.tsx` — the demo page: mock data wiring, the item renderer and the control panel.
- `src/mockData.ts` — deterministic mock danmaku items (text, color, emoji).
- `src/Danmaku/` — the reusable, generic danmaku engine (background + main thread logic). It is data-type agnostic and exposes a single `<Danmaku>` component.

## Getting Started

First, install the dependencies:

```bash
pnpm install
```

Then, run the development server:

```bash
pnpm run dev
```

Scan the QRCode in the terminal with your LynxExplorer App to see the result.

You can start editing the page by modifying `src/App.tsx`. The page auto-updates as you edit the file.
