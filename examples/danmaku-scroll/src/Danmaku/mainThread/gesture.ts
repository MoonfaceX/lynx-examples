import { runOnBackground, useCallback } from "@lynx-js/react";
import type { MainThread } from "@lynx-js/types";

import {
  AUTO_SCROLL_USER_COOLDOWN_MS,
  MOMENTUM_DECAY_K,
  MOMENTUM_MAX_DX,
  MOMENTUM_MAX_VELOCITY,
  MOMENTUM_START_VELOCITY,
  MOMENTUM_STOP_VELOCITY,
} from "../utils";
import {
  clampAbs,
  clampDtMs,
  computeInstantVelocityPxPerSec,
  computeMomentumDx,
  decayVelocityExp,
  ema,
  nowMs,
  shouldStopMomentum,
  shouldUpdateVelocity,
} from "./mainThreadMath";
import type { DanmakuV2MainThreadRefs } from "./types";

/**
 * 手势与惯性子系统（主线程）
 *
 * ## 这个文件负责什么
 * - 处理外层容器的 touch 事件（touchstart/touchmove/touchend/cancel）
 * - 将手势移动转换为对所有行 list 的 scrollBy
 * - 在 touchend 后根据速度决定是否启动惯性滚动，并在惯性结束后触发 normalize 与（按开关）恢复 autoScroll
 * - 注意：item 点击事件应在 BG 侧用 `bindtap` 处理（避免大量 `<list-item>` 绑定 `main-thread:*` 导致渲染提交压力）
 *
 * ## 数据流
 * - 外层触摸事件（MT）→ 更新 refs（拖拽状态、速度、总位移等）→ scrollAllListsMT(dx)
 * - touchend：
 *   - 上报用户滚动（BG）
 *   - 触发 onDragEndMT：可能启动惯性；否则直接 final normalize + 尝试恢复 autoScroll
 *
 * 统一说明：
 * - BG/MT 运行时边界（何时必须 runOnMainThread / runOnBackground）统一见 `mainThread/index.ts` 文件头。
 */

export function useDanmakuV2GestureSubsystem(params: {
  /**
   * 兼容字段（历史遗留）：
   * - 旧版本的 gesture 子系统会接收 `safeRows/rowsData/onItemClick` 用于 per-item 点击回传。
   * - 当前实现已将 item 点击迁移到 BG（renderTree.tsx 使用 bindtap），这些字段不再需要。
   * - 为避免上层调用方/增量编译缓存导致的类型不匹配，这里保留为可选字段（不参与逻辑）。
   */
  safeRows?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rowsData?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onItemClick?: any;

  refs: DanmakuV2MainThreadRefs;

  reportUserScrollBG: (payload: {
    velocityX: number;
    totalDeltaAbsPx: number;
    durationMs: number;
  }) => void;

  // list ops
  scrollAllListsMT: (dx: number) => void;
  stopNativeAutoScrollMT: () => void;

  // normalize coordination
  finalCheckAllRowsMT: () => void;
  restoreAutoScrollAfterNormalizeMT: () => void;
}) {
  const {
    refs,
    reportUserScrollBG,
    scrollAllListsMT,
    stopNativeAutoScrollMT,
    finalCheckAllRowsMT,
    restoreAutoScrollAfterNormalizeMT,
  } = params;

  const {
    isDraggingRef,
    lastTouchXRef,
    lastMoveTimeMsRef,
    swipeVelocityRef,
    touchStartTimeRef,
    totalDeltaRef,
    momentumRunningRef,
    momentumModeMTRef,
    userScrollReportedForGestureMTRef,
    autoScrollBlockedUntilMsMTRef,
    interactionLockedMTRef,
  } = refs;

  /**
   * 惯性滚动结束：做一次 final normalize（收敛边界），然后按开关状态尝试恢复 autoScroll。
   * restoreAutoScrollAfterNormalizeMT 内部会读取主线程开关值决定是否恢复。
   */
  const onMomentumEndMT = useCallback(() => {
    "main thread";
    // 惯性结束：明确退出惯性态，再做收尾（normalize + 恢复）
    momentumRunningRef.current = false;
    // 更保守：把“用户手动滚动后 5s 才恢复 autoScroll”锚定在惯性结束时刻（而不是手指抬起时刻）。
    const now = nowMs();
    autoScrollBlockedUntilMsMTRef.current = Math.max(
      autoScrollBlockedUntilMsMTRef.current || 0,
      now + AUTO_SCROLL_USER_COOLDOWN_MS,
    );
    finalCheckAllRowsMT();
    restoreAutoScrollAfterNormalizeMT();
  }, [
    autoScrollBlockedUntilMsMTRef,
    finalCheckAllRowsMT,
    momentumRunningRef,
    restoreAutoScrollAfterNormalizeMT,
  ]);

  /**
   * 启动惯性滚动：
   * - 先 stop 原生 autoScroll，避免与手势/惯性并发
   * - 用 requestAnimationFrame 循环做指数衰减
   * - 每一帧把 dx 应用到所有行 list
   */
  const startMomentumMT = useCallback(
    (initialVelocity: number) => {
      "main thread";
      // 若当前模式禁止惯性：不启动（直接走收尾），避免在主线程进入无意义的 rAF 循环
      if (momentumModeMTRef.current === "none") {
        momentumRunningRef.current = false;
        onMomentumEndMT();
        return;
      }
      // 手势优先：进入惯性前先停止原生 autoScroll，避免两个滚动源同时作用
      stopNativeAutoScrollMT();
      momentumRunningRef.current = true;

      let velocity = clampAbs(initialVelocity, MOMENTUM_MAX_VELOCITY);
      let lastTs = 0;

      const step = () => {
        if (!momentumRunningRef.current || isDraggingRef.current) return;

        // 运行中切换模式：允许立即生效（例如切到 'none' 时立刻停止）
        const mode = momentumModeMTRef.current;
        if (mode === "none") {
          momentumRunningRef.current = false;
          onMomentumEndMT();
          return;
        }

        const now = nowMs();
        if (lastTs === 0) {
          lastTs = now;
          requestAnimationFrame(step);
          return;
        }

        const dtRaw = now - lastTs;
        if (dtRaw <= 0) {
          requestAnimationFrame(step);
          return;
        }
        // dtMs 夹紧：避免极端卡顿导致 dt 过大，从而一帧滚动跳太远
        const dtMs = clampDtMs(dtRaw, 40);
        lastTs = now;

        const dx = computeMomentumDx(velocity, dtMs, MOMENTUM_MAX_DX);

        // 很小的 dx 直接跳过，减少无意义 invoke('scrollBy')
        if (Math.abs(dx) >= 0.1) scrollAllListsMT(dx);

        // 指数衰减：让速度逐步趋近于 0
        // fastStop：更强衰减（更快停），其余保持现有行为
        const decayK = mode === "fastStop" ? MOMENTUM_DECAY_K * 2 : MOMENTUM_DECAY_K;
        velocity = decayVelocityExp(velocity, decayK, dtMs);

        if (shouldStopMomentum(velocity, MOMENTUM_STOP_VELOCITY)) {
          momentumRunningRef.current = false;
          onMomentumEndMT();
          return;
        }

        requestAnimationFrame(step);
      };

      requestAnimationFrame(step);
    },
    [
      isDraggingRef,
      momentumRunningRef,
      momentumModeMTRef,
      onMomentumEndMT,
      scrollAllListsMT,
      stopNativeAutoScrollMT,
    ],
  );

  /**
   * 拖拽结束：
   * - 速度够大：进入惯性
   * - 否则：立即 final normalize，并按开关恢复 autoScroll
   */
  const onDragEndMT = useCallback(
    (velocity: number) => {
      "main thread";
      // 模式开关：'none' 直接跳过惯性，立即收尾
      if (momentumModeMTRef.current === "none") {
        finalCheckAllRowsMT();
        restoreAutoScrollAfterNormalizeMT();
        return;
      }
      // 速度阈值：超过阈值进入惯性，否则直接收尾
      if (Math.abs(velocity) >= MOMENTUM_START_VELOCITY) {
        startMomentumMT(velocity);
        return;
      }
      finalCheckAllRowsMT();
      restoreAutoScrollAfterNormalizeMT();
    },
    [finalCheckAllRowsMT, momentumModeMTRef, restoreAutoScrollAfterNormalizeMT, startMomentumMT],
  );

  /**
   * touchstart：
   * - 立即 stop autoScroll，保证拖拽手势优先
   * - 重置本次手势的累计数据（起点时间/总位移/速度等）
   */
  const onTouchStartMT = useCallback(
    (e: MainThread.TouchEvent) => {
      "main thread";
      if (interactionLockedMTRef.current) return;
      const x = e.detail?.x ?? 0;
      const now = nowMs();

      stopNativeAutoScrollMT();
      momentumRunningRef.current = false;

      // 重置本次手势状态
      isDraggingRef.current = false;
      lastTouchXRef.current = x;
      lastMoveTimeMsRef.current = now;
      swipeVelocityRef.current = 0;
      touchStartTimeRef.current = now;
      totalDeltaRef.current = 0;
      userScrollReportedForGestureMTRef.current = false;
    },
    [
      isDraggingRef,
      interactionLockedMTRef,
      lastMoveTimeMsRef,
      lastTouchXRef,
      momentumRunningRef,
      stopNativeAutoScrollMT,
      swipeVelocityRef,
      totalDeltaRef,
      touchStartTimeRef,
      userScrollReportedForGestureMTRef,
    ],
  );

  /**
   * touchmove：
   * - 计算 delta，并通过 EMA 平滑速度
   * - 对所有行执行 scrollBy，实现联动拖拽
   */
  const onTouchMoveMT = useCallback(
    (e: MainThread.TouchEvent) => {
      "main thread";
      if (interactionLockedMTRef.current) return;
      const x = e.detail?.x ?? 0;
      const delta = lastTouchXRef.current - x;
      if (isDraggingRef.current || Math.abs(delta) > 8) {
        isDraggingRef.current = true;
        if (isDraggingRef.current) {
          lastTouchXRef.current = x;
          // totalDelta 用于 tap 判定（只累计绝对值，方向无关）
          totalDeltaRef.current += Math.abs(delta);

          const now = nowMs();
          const dtMs = now - lastMoveTimeMsRef.current;
          if (shouldUpdateVelocity(dtMs, 80)) {
            const instV = computeInstantVelocityPxPerSec(delta, dtMs);
            // EMA 平滑：减少瞬时噪声，让惯性启动/停止更稳定
            swipeVelocityRef.current = ema(swipeVelocityRef.current, instV, 0.25);
          }
          lastMoveTimeMsRef.current = now;

          if (Math.abs(delta) >= 0.1) scrollAllListsMT(delta);
          return;
        }
      } else {
        return;
      }
    },
    [
      isDraggingRef,
      interactionLockedMTRef,
      lastMoveTimeMsRef,
      lastTouchXRef,
      scrollAllListsMT,
      swipeVelocityRef,
      totalDeltaRef,
    ],
  );

  /**
   * touchend：
   * - 结束拖拽状态
   * - 上报一次用户滚动（后台线程）
   * - 根据速度走惯性或直接收尾（normalize + 恢复 autoScroll）
   */
  const onTouchEndMT = useCallback(() => {
    "main thread";
    if (interactionLockedMTRef.current) return;
    if (!isDraggingRef.current) {
      restoreAutoScrollAfterNormalizeMT();
      return;
    }

    isDraggingRef.current = false;
    // 用户发生过实际拖拽滚动：从“本次手势结束”开始计时，5s 后才允许恢复 autoScroll。
    // 若后续进入惯性，会在惯性结束时再把计时更新到更晚的时刻（见 onMomentumEndMT）。
    const now = nowMs();
    autoScrollBlockedUntilMsMTRef.current = Math.max(
      autoScrollBlockedUntilMsMTRef.current || 0,
      now + AUTO_SCROLL_USER_COOLDOWN_MS,
    );
    const velocity = swipeVelocityRef.current;

    // 单次手势只上报一次用户滚动：避免多次 touchend/cancel（含 capture 与 bubble）导致重复上报
    if (!userScrollReportedForGestureMTRef.current) {
      userScrollReportedForGestureMTRef.current = true;
      const totalDeltaAbs = totalDeltaRef.current;
      const duration = nowMs() - touchStartTimeRef.current;
      runOnBackground(reportUserScrollBG)({
        velocityX: velocity,
        totalDeltaAbsPx: totalDeltaAbs,
        durationMs: duration,
      });
    }

    // 手势收尾：按速度进入惯性或直接收尾（normalize + 恢复 autoScroll）
    onDragEndMT(velocity);
  }, [
    autoScrollBlockedUntilMsMTRef,
    isDraggingRef,
    interactionLockedMTRef,
    onDragEndMT,
    reportUserScrollBG,
    swipeVelocityRef,
    totalDeltaRef,
    touchStartTimeRef,
    userScrollReportedForGestureMTRef,
    restoreAutoScrollAfterNormalizeMT,
  ]);

  return {
    onTouchStartMT,
    onTouchMoveMT,
    onTouchEndMT,
  };
}
