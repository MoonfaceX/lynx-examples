import { runOnMainThread, useEffect } from "@lynx-js/react";

import type { DanmakuV2MainThreadRefs } from "./types";

/**
 * 主线程 effects（BG→MT 同步与重置）
 *
 * ## 这个文件负责什么
 * - 重置部分主线程运行态（拖拽/惯性/normalize 锁等），避免跨数据代际污染。
 * - 同步数据代际（epoch/safeRows）到主线程 refs，使主线程状态机按“当前代际”运行。
 * - 同步 BG 侧的镜像数据（rowBaseLens/repeatByRow）到主线程，供 autoScroll/normalize 判断使用。
 *
 * ## 数据流
 * - 输入：safeRows/epoch/rowBaseLens/effectiveRepeatByRow
 * - 输出：写入 refs（主线程可读），并在合适时机触发 scheduleAttemptStartAutoScrollMT
 * *
 * 术语/线程模型说明（BG/MT、epoch、safeRows 等）统一见 `mainThread/index.ts` 文件头。
 */

export function useDanmakuV2MainThreadEffects(params: {
  safeRows: number;
  /** 数据代际号（epoch）：用于主线程门禁与跨代重置 */
  epoch: number;
  debug: boolean;

  // BG 渲染期可得：用于 autoScroll 首屏判断“哪些行需要滚动”
  rowBaseLens: number[];
  // BG → MT 镜像同步
  // - 记录每行当前 repeatTimes
  // - 长度始终等于 `safeRows`
  // - 每个值都是整数且 >= 1
  effectiveRepeatByRow: number[];

  refs: DanmakuV2MainThreadRefs;
  lastEpochSyncedToMTRef: { current: number | null };

  scheduleAttemptStartAutoScrollMT: () => void;
}) {
  const {
    safeRows,
    epoch,
    debug,
    rowBaseLens,
    effectiveRepeatByRow,
    refs,
    lastEpochSyncedToMTRef,
    scheduleAttemptStartAutoScrollMT,
  } = params;

  const {
    listMTRefs,
    isDraggingRef,
    momentumRunningRef,
    restoreScheduledRef,
    autoScrollingMTRef,
    autoScrollBlockedUntilMsMTRef,
    autoScrollLayoutEverReadyByRowMTRef,
    autoScrollEpochMTRef,
    listEpochByRowMTRef,
    autoScrollLayoutReadyRef,
    autoScrollProbeAttemptsByRowMTRef,
    autoScrollLastProbeAtMsByRowMTRef,
    autoScrollAttemptScheduledMTRef,
    autoScrollWaitEpochMTRef,
    autoScrollWaitStartedAtMsMTRef,
    normalizingRef,
    lastNormalizedAtMsRef,
    rowBaseLensMTRef,
    repeatByRowMTRef,
    repeatStableEpochByRowMTRef,
  } = refs;

  /**
   * 统一的 epoch/代际同步 effect：
   *
   * 将原先 3 个独立 useEffect 中的 runOnMainThread 合并为 1 次，减少跨线程调用开销。
   *
   * 合并内容：
   * 1. 重置主线程运行态（拖拽/惯性/normalize 锁等），避免跨数据代际污染
   * 2. 同步代际（epoch + rowsCount）到主线程 refs，维护按行数组长度与初始化状态
   * 3. 同步 BG 数据镜像（rowBaseLens/repeatByRow）到主线程
   *
   * 触发时机：epoch 或 safeRows 变化时一次性完成所有 MT 写入。
   */
  useEffect(() => {
    const last = lastEpochSyncedToMTRef.current;
    const epochChanged = last === null || last !== epoch;
    lastEpochSyncedToMTRef.current = epoch;

    // 拷贝：避免把 React state/props 数组直接"借用"给主线程
    const baseLensCopy = [...rowBaseLens];
    const repeatCopy = [...effectiveRepeatByRow];

    if (!epochChanged) {
      // epoch 未变化，仅同步镜像数据（独立路径，与原第 3 个 effect 等价）
      runOnMainThread(() => {
        "main thread";
        rowBaseLensMTRef.current = baseLensCopy;
        repeatByRowMTRef.current = repeatCopy;
        scheduleAttemptStartAutoScrollMT();
      })().catch(() => {});
      return;
    }

    // epoch 变化：一次性完成所有 MT 同步（合并原 3 个 runOnMainThread）
    runOnMainThread((epoch: number, rowsCount: number) => {
      "main thread";

      // === 原 effect 1：重置主线程运行态 ===
      isDraggingRef.current = false;
      momentumRunningRef.current = false;
      restoreScheduledRef.current = false;
      autoScrollingMTRef.current = false;
      autoScrollBlockedUntilMsMTRef.current = 0;

      if (normalizingRef.current.length !== rowsCount) {
        normalizingRef.current = Array(rowsCount).fill(false);
      }
      if (lastNormalizedAtMsRef.current.length !== rowsCount) {
        lastNormalizedAtMsRef.current = Array(rowsCount).fill(0);
      }

      // === 原 effect 2：同步代际（epoch + rowsCount） ===
      autoScrollEpochMTRef.current = epoch;

      if (!listMTRefs.current) listMTRefs.current = [];
      listMTRefs.current.length = rowsCount;

      if (!listEpochByRowMTRef.current) listEpochByRowMTRef.current = [];
      listEpochByRowMTRef.current.length = rowsCount;

      if (!autoScrollLayoutReadyRef.current) autoScrollLayoutReadyRef.current = [];
      autoScrollLayoutReadyRef.current.length = rowsCount;

      if (!autoScrollProbeAttemptsByRowMTRef.current) {
        autoScrollProbeAttemptsByRowMTRef.current = [];
      }
      autoScrollProbeAttemptsByRowMTRef.current.length = rowsCount;

      if (!autoScrollLastProbeAtMsByRowMTRef.current) {
        autoScrollLastProbeAtMsByRowMTRef.current = [];
      }
      autoScrollLastProbeAtMsByRowMTRef.current.length = rowsCount;

      if (!repeatStableEpochByRowMTRef.current) repeatStableEpochByRowMTRef.current = [];
      const stableEpochArr = repeatStableEpochByRowMTRef.current;
      if (stableEpochArr.length < rowsCount) {
        for (let i = stableEpochArr.length; i < rowsCount; i++) {
          stableEpochArr[i] = -1;
        }
      }
      stableEpochArr.length = rowsCount;

      for (let i = 0; i < rowsCount; i++) {
        const el = listMTRefs.current[i];
        listEpochByRowMTRef.current[i] = el ? epoch : 0;
        autoScrollLayoutReadyRef.current[i] = false;
        autoScrollProbeAttemptsByRowMTRef.current[i] = 0;
        autoScrollLastProbeAtMsByRowMTRef.current[i] = 0;
        // 优化：如果该行曾经 ready 过（非首次切换），预设 stableEpoch=epoch，
        // 跳过 repeat 收敛等待，因为 list 未 remount 时 repeat 不会变
        const everReady = autoScrollLayoutEverReadyByRowMTRef.current?.[i] ?? false;
        if (everReady && el) {
          stableEpochArr[i] = epoch;
        }
      }

      autoScrollingMTRef.current = false;
      restoreScheduledRef.current = false;
      autoScrollAttemptScheduledMTRef.current = false;
      autoScrollWaitEpochMTRef.current = epoch;
      autoScrollWaitStartedAtMsMTRef.current = 0;

      // === 原 effect 3：同步镜像数据 ===
      rowBaseLensMTRef.current = baseLensCopy;
      repeatByRowMTRef.current = repeatCopy;

      // 统一触发一次启动尝试
      scheduleAttemptStartAutoScrollMT();
    })(epoch, safeRows).catch(() => {});
  }, [
    autoScrollAttemptScheduledMTRef,
    autoScrollBlockedUntilMsMTRef,
    autoScrollLayoutEverReadyByRowMTRef,
    autoScrollEpochMTRef,
    autoScrollLastProbeAtMsByRowMTRef,
    autoScrollLayoutReadyRef,
    autoScrollProbeAttemptsByRowMTRef,
    autoScrollWaitEpochMTRef,
    autoScrollWaitStartedAtMsMTRef,
    autoScrollingMTRef,
    isDraggingRef,
    lastEpochSyncedToMTRef,
    lastNormalizedAtMsRef,
    listEpochByRowMTRef,
    listMTRefs,
    momentumRunningRef,
    normalizingRef,
    repeatStableEpochByRowMTRef,
    restoreScheduledRef,
    rowBaseLens,
    effectiveRepeatByRow,
    rowBaseLensMTRef,
    repeatByRowMTRef,
    safeRows,
    scheduleAttemptStartAutoScrollMT,
    epoch,
  ]);
}
