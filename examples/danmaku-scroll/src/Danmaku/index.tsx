import { useCallback, useEffect, useRef } from "@lynx-js/react";

import "./index.css";

import { useStableCallback, useStableOptionalCallback } from "./hooks";
import { DanmakuV2RenderTree } from "./renderTree";
import type { DanmakuV2DebugMetrics, DanmakuV2MomentumMode, DanmakuV2Props } from "./types";

/**
 * DanmakuV2（外层控制组件）
 *
 * ## 为什么需要这个文件
 * 这个文件的职责不是渲染 `<list>`，而是：
 * - 将上层传入的函数型 props（renderItem/onItemClick 等）包装为“引用稳定但语义最新”的回调，
 *
 * ## 数据流（高层）
 * - UI/业务层传入 `autoScroll`、`momentumMode` 等 → 本文件通过命令通道把开关下发给主线程（start/stop）。
 * - UI/业务层传入各种回调函数 → 本文件用稳定 wrapper 传给渲染子树：
 *   - wrapper 的函数引用固定（不会因为父组件 rerender 而变化）
 *   - wrapper 内部通过 ref 读取最新的业务回调，保证语义更新不丢失
 * - 真实的 `<list>` 渲染逻辑在 `renderTree.tsx`。
 */

/**
 * DanmakuV2：对外导出的弹幕组件入口。
 *
 * 注意：这里仅做“控制 + 轻量桥接”，不把 `<list-item>` 的大规模渲染逻辑放在这里；
 * 否则任意 state/prop 变化（例如仅切换 autoScroll/momentumMode）都可能触发昂贵的 UI 提交。
 */
export function Danmaku<T>({
  dataEpoch,
  items,
  rows,
  rowGapPx = 12,
  itemGapPx = 12,
  autoScroll = true,
  normalizeWatchdogSweepMs,
  momentumMode = "normal",
  blockNativeEventAreas,
  rowHeightPx,
  rowOffsetPx = 50,
  debug = false,
  firstScreenOptimize,
  renderItem,
  getItemKey,
  onItemClick,
  onUserScroll,
  onItemExpose,
  onDebugMetricsChange,
  perfMetrics,
  screenInfo,
  isFeatured,
}: DanmakuV2Props<T>) {
  /**
   * 主线程开关的“首帧初值”。
   *
   * 原因：主线程 refs 的初始化发生在首次挂载阶段，这里锁定初值可避免在极端情况下
   * （例如父组件在首屏连续更新）造成初始化语义抖动。
   *
   * 后续的开关切换不依赖这个值，而是通过命令通道下发。
   */
  const initialAutoScroll = useRef(autoScroll).current;
  const initialMomentumMode = useRef<DanmakuV2MomentumMode>(momentumMode).current;

  /**
   * autoScroll 命令通道（由渲染子树在挂载后回填）。
   *
   * 目标：仅切换开关时，不需要触发 `<list>` 子树的 props 变化与重新提交；
   * 只要把“开关状态”作为命令下发到主线程即可。
   *
   * 数据流：
   * 外部（BG）：父组件传入 autoScroll=false
   * `Danmaku/index.tsx`（BG）：useEffect([autoScroll]) 触发 → 调用 autoScrollControlRef.current(false)
   * `renderTree.tsx`（BG）：此前已把 mt.setAutoScrollEnabled 回填给外层，所以这里实际调用的是 mt.setAutoScrollEnabled(false)
   * `mainThread/index.ts`（BG → MT）：mt.setAutoScrollEnabled(false) 内部 runOnMainThread(...)
   * 主线程（MT）：
   * 写 autoScrollEnabledMTRef.current = false（主线程读取开关的唯一来源）
   * stopNativeAutoScrollMT() 立刻停止原生 autoScroll
   * 清理 attempt / wait / restore / autoScrolling 等挂起状态
   */
  const autoScrollControlRef = useRef<((enabled: boolean) => void) | null>(null);
  const desiredAutoScrollRef = useRef<boolean>(autoScroll);

  const bindAutoScrollControl = useCallback((setEnabled: (enabled: boolean) => void) => {
    autoScrollControlRef.current = setEnabled;
    // 绑定完成后立即对齐到最新期望值，缩短“已切到 OFF 但主线程尚未收到关闭命令”的窗口。
    setEnabled(desiredAutoScrollRef.current);
  }, []);

  useEffect(() => {
    desiredAutoScrollRef.current = autoScroll;
    autoScrollControlRef.current?.(autoScroll);
  }, [autoScroll]);

  /**
   * momentumMode 命令通道（由渲染子树在挂载后回填）。
   *
   * 目标：切换惯性模式时，不触发 `<list>` 子树的大规模 props/事件重写，只把模式下发到主线程 refs。
   */
  const momentumModeControlRef = useRef<((mode: DanmakuV2MomentumMode) => void) | null>(null);
  const desiredMomentumModeRef = useRef<DanmakuV2MomentumMode>(momentumMode);

  const bindMomentumModeControl = useCallback((setMode: (mode: DanmakuV2MomentumMode) => void) => {
    momentumModeControlRef.current = setMode;
    setMode(desiredMomentumModeRef.current);
  }, []);

  useEffect(() => {
    desiredMomentumModeRef.current = momentumMode;
    momentumModeControlRef.current?.(momentumMode);
  }, [momentumMode]);

  /**
   * 将函数型 props 包装为“引用稳定但语义最新”的回调：
   *
   * - **引用稳定**：传给渲染子树的函数 identity 不随父组件 rerender 改变
   * - **语义最新**：wrapper 内部始终调用最新的业务回调
   *
   * 这样即便父组件只改了 autoScroll（导致自身 rerender），渲染子树也不会因为回调引用变化被迫重渲染。
   */
  const renderItemStable = useStableCallback(renderItem);

  const getItemKeyStable = useStableOptionalCallback(getItemKey, () => "");

  const onItemClickStable = useStableOptionalCallback(onItemClick, () => {});

  const onUserScrollStable = useStableOptionalCallback(onUserScroll, () => {});

  const onItemExposeStable = useStableOptionalCallback(onItemExpose, () => {});

  const onDebugMetricsChangeStable = useStableOptionalCallback(
    onDebugMetricsChange,
    (_m: DanmakuV2DebugMetrics) => {},
  );

  const perfMetricsRef = useRef(perfMetrics);
  perfMetricsRef.current = perfMetrics;

  return (
    <DanmakuV2RenderTree<T>
      dataEpoch={dataEpoch}
      items={items}
      rows={rows}
      rowGapPx={rowGapPx}
      itemGapPx={itemGapPx}
      blockNativeEventAreas={blockNativeEventAreas}
      rowHeightPx={rowHeightPx}
      rowOffsetPx={rowOffsetPx}
      debug={debug}
      normalizeWatchdogSweepMs={normalizeWatchdogSweepMs}
      initialAutoScroll={initialAutoScroll}
      initialMomentumMode={initialMomentumMode}
      bindAutoScrollControl={bindAutoScrollControl}
      bindMomentumModeControl={bindMomentumModeControl}
      renderItem={renderItemStable}
      getItemKey={getItemKey ? getItemKeyStable : undefined}
      onItemClick={onItemClick ? onItemClickStable : undefined}
      onUserScroll={onUserScroll ? onUserScrollStable : undefined}
      onItemExpose={onItemExpose ? onItemExposeStable : undefined}
      onDebugMetricsChange={onDebugMetricsChange ? onDebugMetricsChangeStable : undefined}
      perfMetrics={perfMetrics}
      screenInfo={screenInfo}
      firstScreenOptimize={firstScreenOptimize}
      isFeatured={isFeatured}
    />
  );
}

export {
  type DanmakuV2FirstScreenPhase,
  type DanmakuV2PhaseSnapshot,
  getDanmakuV2PhaseSnapshot,
  subscribeDanmakuV2Phase,
} from "./phaseSignal";
