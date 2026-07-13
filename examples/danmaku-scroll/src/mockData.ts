// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

/** A single danmaku (bullet-comment) item. Pure mock data, no business logic. */
export interface DanmakuItem {
  id: string;
  text: string;
  /** Background color of the pill. */
  color: string;
  /** Leading emoji shown before the text. */
  emoji: string;
}

const PALETTE = [
  "#FF6B6B",
  "#F7A072",
  "#FFD166",
  "#06D6A0",
  "#4ECDC4",
  "#5B8DEF",
  "#9B5DE5",
  "#F15BB5",
];

const EMOJIS = ["🔥", "🎉", "😂", "👍", "💯", "✨", "🚀", "❤️", "😎", "🥳", "👀", "🌟"];

const MESSAGES = [
  "Lynx is blazing fast!",
  "Smooth 60fps scrolling",
  "Main thread scripting rocks",
  "Infinite marquee, no jank",
  "Bullet comments incoming",
  "A/B segment recycling",
  "Boundary normalization ftw",
  "Cross-platform rendering",
  "Zero-copy list items",
  "Look ma, no business logic",
  "Horizontal auto scroll",
  "Try dragging me around",
  "Momentum feels native",
  "Featured comment pinned",
  "Built with ReactLynx",
  "Hello from Lynx Examples",
  "Danmaku never stops",
  "Powered by worklets",
  "Buttery smooth transitions",
  "Tap me to interact",
  "Multi-row layout demo",
  "Recycle & reuse cells",
  "Edge-triggered reset",
  "Seamless loop scrolling",
];

/** Generate a deterministic list of mock danmaku items. */
export function createMockDanmaku(count: number): DanmakuItem[] {
  const items: DanmakuItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      id: `danmaku-${i}`,
      text: MESSAGES[i % MESSAGES.length]!,
      color: PALETTE[i % PALETTE.length]!,
      emoji: EMOJIS[i % EMOJIS.length]!,
    });
  }
  return items;
}
