// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { useCallback, useMemo, useRef, useState } from "@lynx-js/react";

import "./App.css";
import { Danmaku } from "./Danmaku/index.jsx";
import type { DanmakuV2MomentumMode } from "./Danmaku/types.js";
import { createMockDanmaku, type DanmakuItem } from "./mockData.js";

const ROW_HEIGHT_PX = 44;
const ROW_GAP_PX = 12;
const MOMENTUM_MODES: DanmakuV2MomentumMode[] = ["normal", "fastStop", "none"];

/** Renders a single colorful danmaku pill. Pure UI, no business logic. */
function DanmakuCard(props: { item: DanmakuItem }) {
  const { item } = props;
  return (
    <view className="danmaku-card" style={{ backgroundColor: item.color }}>
      <text className="danmaku-card__emoji">{item.emoji}</text>
      <text className="danmaku-card__text">{item.text}</text>
    </view>
  );
}

export function App() {
  const [rows, setRows] = useState(4);
  const [autoScroll, setAutoScroll] = useState(true);
  const [momentumIndex, setMomentumIndex] = useState(0);
  const [lastTapped, setLastTapped] = useState<string>("(none)");

  // dataEpoch must advance whenever the item set changes semantically.
  const epochRef = useRef(1);
  const [dataEpoch, setDataEpoch] = useState(1);
  const [items, setItems] = useState<DanmakuItem[]>(() => createMockDanmaku(24));

  const momentumMode = MOMENTUM_MODES[momentumIndex]!;

  const renderItem = useCallback((item: DanmakuItem) => <DanmakuCard item={item} />, []);
  const getItemKey = useCallback((item: DanmakuItem) => item.id, []);
  const onItemClick = useCallback((item: DanmakuItem) => {
    setLastTapped(`${item.emoji} ${item.text}`);
  }, []);

  const reloadData = useCallback(() => {
    const nextCount = 12 + Math.floor(Math.random() * 24);
    epochRef.current += 1;
    setItems(createMockDanmaku(nextCount));
    setDataEpoch(epochRef.current);
  }, []);

  const cycleRows = useCallback(() => {
    setRows((prev) => (prev >= 5 ? 3 : prev + 1));
  }, []);

  const cycleMomentum = useCallback(() => {
    setMomentumIndex((prev) => (prev + 1) % MOMENTUM_MODES.length);
  }, []);

  const stageHeight = useMemo(
    () => rows * ROW_HEIGHT_PX + (rows - 1) * ROW_GAP_PX,
    [rows],
  );

  return (
    <view className="page">
      <view className="header">
        <text className="header__title">Danmaku Scroll</text>
        <text className="header__subtitle">
          Infinite horizontal bullet-comment marquee
        </text>
      </view>

      <view className="stage" style={{ height: `${stageHeight + 24}px` }}>
        <Danmaku<DanmakuItem>
          dataEpoch={dataEpoch}
          items={items}
          rows={rows}
          rowHeightPx={ROW_HEIGHT_PX}
          rowGapPx={ROW_GAP_PX}
          autoScroll={autoScroll}
          momentumMode={momentumMode}
          renderItem={renderItem}
          getItemKey={getItemKey}
          onItemClick={onItemClick}
        />
      </view>

      <view className="panel">
        <view className="row">
          <text className="label">Auto scroll</text>
          <view
            className={`toggle ${autoScroll ? "toggle--on" : ""}`}
            bindtap={() => setAutoScroll((v) => !v)}
          >
            <text className="toggle__text">{autoScroll ? "ON" : "OFF"}</text>
          </view>
        </view>

        <view className="row">
          <text className="label">Rows: {rows}</text>
          <view className="btn" bindtap={cycleRows}>
            <text className="btn__text">Change</text>
          </view>
        </view>

        <view className="row">
          <text className="label">Momentum: {momentumMode}</text>
          <view className="btn" bindtap={cycleMomentum}>
            <text className="btn__text">Switch</text>
          </view>
        </view>

        <view className="row">
          <text className="label">Items: {items.length}</text>
          <view className="btn btn--primary" bindtap={reloadData}>
            <text className="btn__text">Reload</text>
          </view>
        </view>

        <view className="row">
          <text className="label">Last tapped</text>
          <text className="value">{lastTapped}</text>
        </view>
      </view>
    </view>
  );
}
