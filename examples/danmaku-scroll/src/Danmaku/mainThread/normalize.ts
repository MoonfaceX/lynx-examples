import { useCallback, useMainThreadRef } from "@lynx-js/react";

import type { MainThread } from "@lynx-js/types";
import type { GetVisibleCellsResult, NormalizeDispatchResult, NormalizeReason } from "../types";
import {
  ensureRefLenFilledMT,
  NORMALIZE_COOLDOWN_MS,
  NORMALIZE_EVENT_STORM_TRIGGER_COUNT,
  NORMALIZE_EVENT_STORM_WINDOW_MS,
  THRESHOLD_ITEM_COUNT_DEFAULT,
} from "../utils";
import { invokeListMethod } from "./invoke";
import {
  chooseJumpDir,
  computeNormalizeGuards,
  computeNormalizeTargetIndex,
  computeUnsafeBand,
  hasSafeBand,
  nowMs,
  selectAnchorFromAttachedCells,
} from "./mainThreadMath";
import type { DanmakuV2MainThreadRefs } from "./types";

/**
 * normalize 子系统（主线程）
 *
 * 目标：
 * - DanmakuV2 的每行 `<list>` 内容是 A+B 双段的循环结构（totalLen = 2 * blockLen）。
 * - 当滚动接近边界时，`<list>` 会触发 threshold/edge 事件。
 * - normalize 的作用是在这些事件触发时，把滚动位置“跳回”安全区，避免长期处于边界/阈值命中态，
 *   进而减少高频事件与潜在的状态机抖动。
 *
 * 这份文件在系统中的位置（读懂它的关键）：
 * - 触发源：`renderTree.tsx` 给每行 `<list>` 绑定了以下主线程事件：
 *   - `main-thread:bindscrolltoupper / bindscrolltolower`（threshold）
 *   - `main-thread:bindscrolltoupperedge / bindscrolltoloweredge`（edge）
 * - 这些事件最终都会调用本文件导出的 handler → `requestNormalizeRowMT`。
 * - 手势/惯性结束后，也会触发一次 `finalCheckAllRowsMT` 作为“收尾 normalize”。
 *
 * 事件方向说明（容易误解）：
 * - Lynx 事件名是 `scrolltoupper/scrolltolower`（即使 list 是横向滚动也沿用这套命名）。
 * - 在本组件的横向列表里，你可以把它理解为：
 *   - `upper`：靠近“起点侧”（更接近 index=0 的一侧）
 *   - `lower`：靠近“终点侧”（更接近 index=totalLen-1 的一侧）
 * - 我们使用 `dir: 'upper' | 'lower'` 来表达“向哪一侧接近边界”。
 *
 * 数据来源（主线程镜像）：
 * - baseLen：`rowBaseLensMTRef`（该行 repeat 前的 item 数）
 * - repeatTimes：`repeatByRowMTRef`（该行 repeat 次数）
 * - blockLen = baseLen * repeatTimes（单段长度）
 * - totalLen = 2 * blockLen（A+B 两段总长度）
 *
 * 关键机制：
 * - **epoch 门禁**：`autoScrollEpochMTRef` + `listEpochByRowMTRef` 过滤旧实例/迟到事件
 * - **layoutReady 门禁**：`autoScrollLayoutReadyRef` 确保 invoke 安全
 * - **锁与 cooldown**：避免并发 scrollToPosition 与过于频繁的 normalize
 * - **queued（按行排队）**：当因锁跳过 edge/threshold 的 normalize 时，记录一条“待补做请求”，在锁释放时自动补做一次
 * - **恢复 autoScroll**：normalize 完成后，如果开关允许且没有拖拽/惯性，会尝试恢复 autoScroll
 *
 * 为什么 normalize 需要“锁 + 排队（queued）”：
 * - `scrollToPosition` 是一个异步调用；如果同一行并发调用多次，会造成锚点漂移与来回跳动。
 * - 但 edge/threshold 事件在边界处可能非常密集：如果我们简单丢弃，会出现“越界后不回中间”的卡死感。
 * - 因此策略是：
 *   - 同一行同一时间只允许一个 normalize（锁）
 *   - 锁期间收到 edge/threshold：记录为 queued，当前 normalize 结束释放锁时再补做一次
 */
export function useDanmakuV2NormalizeSubsystem(params: {
  safeRows: number;
  debug: boolean;
  refs: DanmakuV2MainThreadRefs;
  scheduleAttemptStartAutoScrollMT: () => void;
  /**
   * normalize watchdog 一轮扫完的目标时间（ms）。
   * - safeRows<=5：默认 3000ms → 最多 3 秒完成一轮（每次 tick 只检查一行）
   */
  watchdogSweepMs?: number;
}) {
  const { safeRows, debug, refs, scheduleAttemptStartAutoScrollMT, watchdogSweepMs } = params;

  const {
    listMTRefs,
    autoScrollEpochMTRef,
    listEpochByRowMTRef,
    autoScrollLayoutReadyRef,
    rowBaseLensMTRef,
    repeatByRowMTRef,
    normalizingRef,
    lastNormalizedAtMsRef,
    pendingNormalizeDirByRowMTRef,
    pendingNormalizeReasonByRowMTRef,
    autoScrollEnabledMTRef,
    restoreScheduledRef,
    isDraggingRef,
    momentumRunningRef,
    interactionLockedMTRef,

    normalizeWatchdogRunningRef,
    normalizeWatchdogNextAtMsRef,
    normalizeWatchdogCursorRef,
    normalizeWatchdogEpochRef,
  } = refs;

  const WATCHDOG_SWEEP_MS = Math.max(300, Math.floor(watchdogSweepMs ?? 3000));

  /**
   * normalize 事件风暴熔断（终极兜底，按 epoch 生效）
   *
   * 触发条件：在 NORMALIZE_EVENT_STORM_WINDOW_MS 内，threshold/edge 事件触发次数 >= NORMALIZE_EVENT_STORM_TRIGGER_COUNT。
   * 生效范围：当前 epoch 内禁用所有 normalize（edge/threshold/final/watchdog），直到 epoch 推进自动重置。
   *
   * 设计约束：
   * - 不通过 props 传入（参数常量在 utils.ts）
   * - 不依赖 BG 侧 effects 重置：在主线程入口处自对齐 epoch，保证计数器随 epoch 自动刷新
   * - 主线程热点路径仅做 O(1) 标量计算与比较
   */
  const normalizeStormEpochMTRef = useMainThreadRef<number>(0);
  const normalizeStormWindowStartMsMTRef = useMainThreadRef<number>(0);
  const normalizeStormCountMTRef = useMainThreadRef<number>(0);
  const normalizeStormDisabledEpochMTRef = useMainThreadRef<number>(0);

  const isNormalizeStormDisabledMT = useCallback(() => {
    "main thread";
    const currentEpoch = autoScrollEpochMTRef.current;
    if (normalizeStormEpochMTRef.current !== currentEpoch) {
      normalizeStormEpochMTRef.current = currentEpoch;
      normalizeStormWindowStartMsMTRef.current = 0;
      normalizeStormCountMTRef.current = 0;
      normalizeStormDisabledEpochMTRef.current = 0;
      return false;
    }
    return normalizeStormDisabledEpochMTRef.current === currentEpoch;
  }, [
    autoScrollEpochMTRef,
    normalizeStormCountMTRef,
    normalizeStormDisabledEpochMTRef,
    normalizeStormEpochMTRef,
    normalizeStormWindowStartMsMTRef,
  ]);

  const recordNormalizeStormEventAndMaybeDisableMT = useCallback(() => {
    "main thread";
    const currentEpoch = autoScrollEpochMTRef.current;
    if (normalizeStormEpochMTRef.current !== currentEpoch) {
      normalizeStormEpochMTRef.current = currentEpoch;
      normalizeStormWindowStartMsMTRef.current = 0;
      normalizeStormCountMTRef.current = 0;
      normalizeStormDisabledEpochMTRef.current = 0;
    }
    if (normalizeStormDisabledEpochMTRef.current === currentEpoch) return true;

    const now = nowMs();
    const start = normalizeStormWindowStartMsMTRef.current || 0;
    if (start === 0 || now - start >= NORMALIZE_EVENT_STORM_WINDOW_MS) {
      normalizeStormWindowStartMsMTRef.current = now;
      normalizeStormCountMTRef.current = 1;
      return false;
    }

    const nextCount = (normalizeStormCountMTRef.current || 0) + 1;
    normalizeStormCountMTRef.current = nextCount;
    if (nextCount < NORMALIZE_EVENT_STORM_TRIGGER_COUNT) return false;

    // 熔断：禁用当前 epoch 的所有 normalize，并清理 queued + 停止 watchdog 循环
    normalizeStormDisabledEpochMTRef.current = currentEpoch;
    normalizeWatchdogRunningRef.current = false;

    ensureRefLenFilledMT(pendingNormalizeDirByRowMTRef, safeRows, null);
    ensureRefLenFilledMT(pendingNormalizeReasonByRowMTRef, safeRows, null);
    for (let i = 0; i < safeRows; i++) {
      pendingNormalizeDirByRowMTRef.current[i] = null;
      pendingNormalizeReasonByRowMTRef.current[i] = null;
    }

    return true;
  }, [
    autoScrollEpochMTRef,
    normalizeStormCountMTRef,
    normalizeStormDisabledEpochMTRef,
    normalizeStormEpochMTRef,
    normalizeStormWindowStartMsMTRef,
    normalizeWatchdogRunningRef,
    pendingNormalizeDirByRowMTRef,
    pendingNormalizeReasonByRowMTRef,
    safeRows,
  ]);

  const restoreAutoScrollAfterNormalizeMT = useCallback(() => {
    "main thread";
    if (interactionLockedMTRef.current) return;

    // 若开关关闭：不需要恢复，也要清掉 restoreScheduled（避免后续被轮询占用）
    if (!autoScrollEnabledMTRef.current) {
      restoreScheduledRef.current = false;
      return;
    }
    if (restoreScheduledRef.current) {
      return;
    }
    restoreScheduledRef.current = true;

    const tryRestore = () => {
      // 轮询等待所有行的 normalize 锁释放，再尝试恢复 autoScroll
      if (!autoScrollEnabledMTRef.current) {
        restoreScheduledRef.current = false;
        return;
      }
      const locks = normalizingRef.current || [];
      for (let i = 0; i < locks.length; i++) {
        if (locks[i]) {
          // 仍有行在 normalize：继续等下一帧，避免“normalize 与 autoScroll 同时抢 list”
          requestAnimationFrame(tryRestore);
          return;
        }
      }
      restoreScheduledRef.current = false;
      // 唤醒 autoScroll 启动状态机：是否能启动仍由 autoScroll.ts 的门禁判断决定
      scheduleAttemptStartAutoScrollMT();
    };
    requestAnimationFrame(tryRestore);
  }, [
    autoScrollEnabledMTRef,
    interactionLockedMTRef,
    normalizingRef,
    restoreScheduledRef,
    scheduleAttemptStartAutoScrollMT,
  ]);

  const normalizeRowMT = useCallback(
    (
      rowIndex: number,
      dir: "upper" | "lower",
      reason: NormalizeReason,
    ): NormalizeDispatchResult => {
      "main thread";

      /**
       * 重要说明（这次 “lexical variable is not initialized” 的根因）：
       * - 在 Lynx worklet 的编译/运行时中，如果在 worklet 回调内部引用 `normalizeRowMT`（useCallback 的返回值），
       *   会形成“自引用 lexical binding 捕获”，从而触发 TDZ（lexical variable is not initialized）。
       * - 因此 normalize 内部（尤其是 safeFinish 的 drain queued）必须调用**本地函数**，而不是 `normalizeRowMT(...)`。
       */
      function normalizeRowMTWorklet(
        rowIndex: number,
        dir: "upper" | "lower",
        reason: NormalizeReason,
      ): NormalizeDispatchResult {
        "main thread";
        // 风暴熔断：当前 epoch 直接跳过所有 normalize（含 final/watchdog/queued drain）
        if (isNormalizeStormDisabledMT()) return "skip:cooldown";
        /**
         * normalizeRowMT：对单行执行一次 normalize（可能是异步完成）。
         *
         * 注意：
         * - 这个函数本身只负责“发起一次 normalize”。
         * - 事件门禁（epoch/layoutReady/baseLen>0）主要在外层 handler 中做；
         *   这里会做最基础的防御（无 el、baseLen/repeat 异常、锁/cooldown 等）。
         *
         * 参数解释：
         * - rowIndex：第几行
         * - dir：事件方向（upper/lower，表示更靠近起点/终点侧）
         * - reason：
         *   - 'threshold'：阈值触发（接近边界）
         *   - 'edge'：真正到达边界
         *   - 'final'：手势/惯性结束后的收尾检查
         *
         * 返回值：
         * - 'started'：本次成功发起了 scrollToPosition（异步完成）
         * - 'skip:*'：由于门禁/锁/数据异常等原因跳过（不会产生副作用）
         */
        const el = listMTRefs.current?.[rowIndex];
        if (!el) {
          if (debug) {
            console.warn("[DanmakuV2][N] skip:no-el", {
              row: rowIndex,
              dir,
              reason,
            });
          }
          return "skip:no-el";
        }

        // 主线程镜像：baseLen/repeatTimes 由 `effects.ts` 与 list 的 `main-thread:bindlayoutcomplete` 同步
        const baseLen = rowBaseLensMTRef.current?.[rowIndex] ?? 0;
        const currentRepeat = repeatByRowMTRef.current?.[rowIndex] ?? 1;

        // baseLen/repeatTimes 是后续所有计算的前提：异常输入直接跳过（避免在主线程做无意义/危险操作）
        if (!Number.isFinite(baseLen) || baseLen <= 0) {
          if (debug) {
            console.warn("[DanmakuV2][N] skip:bad-base-len", {
              row: rowIndex,
              dir,
              reason,
              baseLen,
              repeat: currentRepeat,
            });
          }
          return "skip:bad-base-len";
        }
        if (!Number.isFinite(currentRepeat) || currentRepeat <= 0) {
          if (debug) {
            console.warn("[DanmakuV2][N] skip:bad-repeat", {
              row: rowIndex,
              dir,
              reason,
              baseLen,
              repeat: currentRepeat,
            });
          }
          return "skip:bad-repeat";
        }

        // 术语回顾：
        // - blockLen：单段长度（A 段或 B 段的 item 数）= baseLen * repeatTimes
        // - totalLen：A+B 两段总长度 = 2 * blockLen
        const blockLen = baseLen * currentRepeat;
        const totalLen = blockLen * 2;
        if (blockLen <= 0 || totalLen <= 0) return "skip:bad-base-len";

        /**
         * 安全区检查：
         * - 对于 edge/threshold 这种“边界强制类”事件，如果 totalLen 太小根本不存在安全区，
         *   此时 normalize 反而可能无意义或造成来回跳动，因此选择跳过。
         */

        if (reason === "edge" || reason === "threshold") {
          const { upperGuard, lowerGuard } = computeNormalizeGuards(THRESHOLD_ITEM_COUNT_DEFAULT);

          if (!hasSafeBand(totalLen, upperGuard, lowerGuard)) {
            return "skip:no-safe-band";
          }
        }

        // 锁数组/时间戳数组需要与 safeRows 对齐（防御：避免 rows 变化后的越界）
        if (!normalizingRef.current || normalizingRef.current.length !== safeRows) {
          normalizingRef.current = Array(safeRows).fill(false);
        }
        if (!lastNormalizedAtMsRef.current || lastNormalizedAtMsRef.current.length !== safeRows) {
          lastNormalizedAtMsRef.current = Array(safeRows).fill(0);
        }

        // 同一行不允许并发 normalize：并发 scrollToPosition 容易造成锚点漂移与状态机不稳定
        if (normalizingRef.current[rowIndex]) {
          if (debug) {
            console.info("[DanmakuV2][N] skip:lock", {
              row: rowIndex,
              dir,
              reason,
            });
          }
          return "skip:lock";
        }

        const now = nowMs();
        const lastAt = lastNormalizedAtMsRef.current[rowIndex] || 0;
        const force = reason === "edge" || reason === "threshold";
        // cooldown：非强制类 normalize（例如 final）会受冷却控制，避免在短时间内重复跳动
        if (!force && now - lastAt < NORMALIZE_COOLDOWN_MS) {
          if (debug) {
            console.info("[DanmakuV2][N] skip:cooldown", {
              row: rowIndex,
              dir,
              reason,
              sinceLastMs: now - lastAt,
            });
          }
          return "skip:cooldown";
        }

        normalizingRef.current[rowIndex] = true;

        const finish = () => {
          normalizingRef.current[rowIndex] = false;
          lastNormalizedAtMsRef.current[rowIndex] = nowMs();
        };

        // 兜底超时：防止 invoke promise 永远不 resolve 导致锁永久不释放（否则该行将永远 skip:lock）
        let finished = false;
        const timeoutStartMs = nowMs();
        const timeoutCheck = () => {
          if (finished) return;
          if (nowMs() - timeoutStartMs >= 800) {
            finished = true;
            if (debug) {
              console.warn("[DanmakuV2] normalize-timeout", {
                rowIndex,
                dir,
                reason,
              });
            }
            safeFinish();
            return;
          }
          requestAnimationFrame(timeoutCheck);
        };
        requestAnimationFrame(timeoutCheck);

        const safeFinish = () => {
          if (finished) return;
          finished = true;
          finish();
          if (isNormalizeStormDisabledMT()) {
            // 熔断期间不做 queued drain，避免继续触发 normalize invoke
            ensureRefLenFilledMT(pendingNormalizeDirByRowMTRef, safeRows, null);
            ensureRefLenFilledMT(pendingNormalizeReasonByRowMTRef, safeRows, null);
            pendingNormalizeDirByRowMTRef.current[rowIndex] = null;
            pendingNormalizeReasonByRowMTRef.current[rowIndex] = null;
            return;
          }
          /**
           * drain queued（解锁后补做一次）：
           * - 如果锁期间收到了 edge/threshold 事件，我们只记录一条 queued 请求；
           * - 当前 normalize 结束（释放锁）后，立即尝试补做一次，避免边界事件被吞掉。
           *
           * 说明：
           * - 这里只补做一次；如果补做过程中又产生新的 queued，会在下一次 finish 时再补做。
           * - queued 只用于 edge/threshold；final 不排队。
           */
          const pDir = pendingNormalizeDirByRowMTRef.current?.[rowIndex] ?? null;
          const pReason = pendingNormalizeReasonByRowMTRef.current?.[rowIndex] ?? null;
          if (pDir && pReason) {
            // 先清空，再补做：避免覆盖“补做期间”产生的新 queued
            pendingNormalizeDirByRowMTRef.current[rowIndex] = null;
            pendingNormalizeReasonByRowMTRef.current[rowIndex] = null;

            /**
             * drain queued（解锁后补做一次）：
             *
             * 不能同步递归调用具名函数表达式（worklet 下可能丢失名字绑定）。
             * 同时直接同步调用 `normalizeRowMT(...)` 在部分环境/时序下可能触发
             * “lexical variable is not initialized”（模块初始化窗口期/TDZ）。
             *
             * 关键点：**这里绝对不能引用 `normalizeRowMT` 这个 lexical binding**，
             * 因为它会让 worklet 捕获一个“自引用闭包变量”，从而在运行时触发 TDZ。
             *
             * `normalizeRowMTWorklet(...)`（函数声明无 TDZ，且不会产生自引用捕获）。
             */
            try {
              const res = normalizeRowMTWorklet(rowIndex, pDir, pReason);
              if (res === "started" && !isDraggingRef.current && !momentumRunningRef.current) {
                restoreAutoScrollAfterNormalizeMT();
              }
            } catch {
              // no-op：queued 补做失败不应影响主流程稳定性
            }
          }
        };

        /**
         * 获取可见 cells 作为锚点：
         * - `getVisibleCells` 返回“当前可见的 items”（每个 item 包含 index/left 等几何信息）
         * - 我们选择一个“稳定锚点”（left 最小的那个）并记录它的：
         *   - `anchorIndex`：锚点 item 的 index
         *   - `anchorLeft`：锚点 item 在屏幕上的 left（px）
         *
         * 为什么要记录 anchorLeft：
         * - normalize 的核心是“把 index 从边界跳回安全区”，这会导致 scroll position 发生跃迁；
         * - 若不做 offset 修正，用户会看到明显的“跳动”；
         * - 因此在 `scrollToPosition` 里把 anchorLeft 作为 offset 传入，尽量让锚点在视觉上保持同一个位置。
         */
        (el.invoke("getVisibleCells") as Promise<GetVisibleCellsResult>)
          .then((res) => {
            const attachedCells = res;
            const anchor = selectAnchorFromAttachedCells(
              attachedCells as unknown as Array<{
                index: number;
                left: number;
              }>,
            );
            if (!anchor.ok) {
              if (debug) {
                console.warn("[DanmakuV2] normalize-no-anchor", {
                  rowIndex,
                  dir,
                  reason,
                  baseLen,
                  repeat: currentRepeat,
                  resType: typeof res,
                });
              }
              safeFinish();
              return;
            }

            const { upperGuard, lowerGuard } = computeNormalizeGuards(THRESHOLD_ITEM_COUNT_DEFAULT);
            const { unsafeUpper, unsafeLower } = computeUnsafeBand(
              anchor.minIndex,
              anchor.maxIndex,
              totalLen,
              upperGuard,
              lowerGuard,
            );

            if (reason === "final") {
              /**
               * final：只做“必要的收尾”。
               *
               * 只要当前不在任一侧不安全区（unsafeUpper/unsafeLower 都为 false），就不做跳转，避免无意义抖动。
               * 注意：这里不依赖 dir 做“是否跳过”的判定，这样每行 final 只需要调用一次即可覆盖两侧情况。
               */
              if (!unsafeUpper && !unsafeLower) {
                safeFinish();
                return;
              }
            }

            // 根据 unsafe band 与事件方向选择跳转方向（upper/lower）
            const jumpDir = chooseJumpDir(dir, unsafeUpper, unsafeLower);
            // 计算跳转目标：通常是 anchorIndex ± blockLen（跨一个单段），并做越界与 flip 保护
            const safeTarget = computeNormalizeTargetIndex(
              anchor.anchorIndex,
              blockLen,
              totalLen,
              jumpDir,
            );

            if (debug) {
              console.info("[DanmakuV2] normalize", {
                rowIndex,
                dir,
                reason,
                baseLen,
                repeat: currentRepeat,
                blockLen,
                totalLen,
                anchorIndex: anchor.anchorIndex,
                anchorLeft: anchor.anchorLeft,
                safeTarget,
              });
            }

            /**
             * scrollToPosition：
             * - position：目标 index（在 [0, totalLen-1]）
             * - offset：像素偏移（这里使用 anchorLeft，让"锚点在屏幕上的位置"尽量不变）
             * - smooth=false：normalize 是"纠偏"，要求立即生效（避免平滑动画期间再次触发 edge/threshold）
             *
             * 注意：
             * - list 是横向滚动（scroll-orientation="horizontal"）。
             * - Lynx 的 `scrollToPosition` 仍使用 alignTo/offset 的组合，这里 alignTo 取 'top' 是为了保持参数稳定；
             *   真正影响横向位置的是 `offset`（与 getVisibleCells 的 left 对齐）。
             */
            invokeListMethod(
              el,
              "scrollToPosition",
              {
                position: safeTarget,
                alignTo: "top",
                offset: anchor.anchorLeft,
                smooth: false,
              },
              {
                onSuccess: () => {
                  safeFinish();
                },
                onError: (e) => {
                  if (debug) {
                    console.warn("[DanmakuV2][N] scrollToPosition-reject", {
                      rowIndex,
                      dir,
                      reason,
                      errorType: e,
                    });
                  }
                  safeFinish();
                },
              },
            );
          })
          .catch((e: unknown) => {
            if (debug) {
              console.warn("[DanmakuV2][N] getVisibleCells-reject", {
                rowIndex,
                dir,
                reason,
                errorType: typeof e,
              });
            }
            safeFinish();
          });

        return "started";
      }

      return normalizeRowMTWorklet(rowIndex, dir, reason);
    },
    [
      debug,
      isNormalizeStormDisabledMT,
      lastNormalizedAtMsRef,
      listMTRefs,
      isDraggingRef,
      momentumRunningRef,
      normalizingRef,
      pendingNormalizeDirByRowMTRef,
      pendingNormalizeReasonByRowMTRef,
      repeatByRowMTRef,
      restoreAutoScrollAfterNormalizeMT,
      rowBaseLensMTRef,
      safeRows,
    ],
  );

  const requestNormalizeRowMT = useCallback(
    (
      rowIndex: number,
      dir: "upper" | "lower",
      reason: NormalizeReason,
    ): NormalizeDispatchResult => {
      "main thread";
      if (interactionLockedMTRef.current) return "skip:no-el";
      /**
       * requestNormalizeRowMT：对外的 normalize 请求入口。
       *
       * 与 normalizeRowMT 的差别：
       * - normalizeRowMT 只负责“尝试执行一次”（可能因为锁而跳过）
       * - requestNormalizeRowMT 负责处理“锁冲突时的 queued”（仅对 edge/threshold 生效）
       */
      const result = normalizeRowMT(rowIndex, dir, reason);

      if (result === "skip:lock" && (reason === "edge" || reason === "threshold")) {
        // 锁冲突：记录 queued，等当前 normalize 结束释放锁时补做一次（避免边界事件被吞掉）
        // 注意：只对 edge/threshold 记录 queued。
        // - 这两类属于“边界类事件”，如果丢掉会让列表长期停在边缘附近
        // - final 属于“收尾检查”，可以丢掉，不需要 queued（否则会造成过多补做）
        ensureRefLenFilledMT(pendingNormalizeDirByRowMTRef, safeRows, null);
        ensureRefLenFilledMT(pendingNormalizeReasonByRowMTRef, safeRows, null);

        // edge 的优先级高于 threshold：若已 queued threshold，后续 edge 到来应覆盖 reason
        const prevReason = pendingNormalizeReasonByRowMTRef.current[rowIndex];
        const nextReason: "edge" | "threshold" = reason;
        const nextIsHigher = prevReason !== "edge" && nextReason === "edge";
        if (!prevReason || nextIsHigher) {
          pendingNormalizeReasonByRowMTRef.current[rowIndex] = nextReason;
          pendingNormalizeDirByRowMTRef.current[rowIndex] = dir;
        } else {
          pendingNormalizeDirByRowMTRef.current[rowIndex] = dir;
        }
      }

      if (result === "started" && !isDraggingRef.current && !momentumRunningRef.current) {
        // 本次请求成功启动 normalize，并且不在拖拽/惯性中：可以尝试恢复 autoScroll
        restoreAutoScrollAfterNormalizeMT();
      }
      return result;
    },
    [
      isDraggingRef,
      interactionLockedMTRef,
      momentumRunningRef,
      normalizeRowMT,
      pendingNormalizeDirByRowMTRef,
      pendingNormalizeReasonByRowMTRef,
      restoreAutoScrollAfterNormalizeMT,
      safeRows,
    ],
  );

  const createScrollToUpperMT = useCallback(
    (rowIndex: number) => {
      const handler = () => {
        "main thread";
        if (interactionLockedMTRef.current) return;
        // 事件门禁：只处理当前 epoch 的行；且必须 layoutReady/baseLen 正常
        const epoch = autoScrollEpochMTRef.current;
        if ((listEpochByRowMTRef.current?.[rowIndex] ?? 0) !== epoch) return;
        if (!autoScrollLayoutReadyRef.current?.[rowIndex]) return;
        if ((rowBaseLensMTRef.current?.[rowIndex] ?? 0) <= 0) return;
        // 风暴熔断：仅在通过门禁后计数，保证正常情况不受影响
        if (recordNormalizeStormEventAndMaybeDisableMT()) return;
        if (debug) {
          console.info("[DanmakuV2][EVT] scrolltoupper(threshold)", {
            row: rowIndex,
          });
        }
        requestNormalizeRowMT(rowIndex, "upper", "threshold");
      };
      return handler;
    },
    [
      autoScrollEpochMTRef,
      autoScrollLayoutReadyRef,
      debug,
      interactionLockedMTRef,
      listEpochByRowMTRef,
      recordNormalizeStormEventAndMaybeDisableMT,
      requestNormalizeRowMT,
      rowBaseLensMTRef,
    ],
  );

  const createScrollToLowerMT = useCallback(
    (rowIndex: number) => {
      const handler = () => {
        "main thread";
        if (interactionLockedMTRef.current) return;
        // 事件门禁：只处理当前 epoch 的行；且必须 layoutReady/baseLen 正常
        const epoch = autoScrollEpochMTRef.current;
        if ((listEpochByRowMTRef.current?.[rowIndex] ?? 0) !== epoch) return;
        if (!autoScrollLayoutReadyRef.current?.[rowIndex]) return;
        if ((rowBaseLensMTRef.current?.[rowIndex] ?? 0) <= 0) return;
        if (recordNormalizeStormEventAndMaybeDisableMT()) return;
        if (debug) {
          console.info("[DanmakuV2][EVT] scrolltolower(threshold)", {
            row: rowIndex,
          });
        }
        requestNormalizeRowMT(rowIndex, "lower", "threshold");
      };
      return handler;
    },
    [
      autoScrollEpochMTRef,
      autoScrollLayoutReadyRef,
      debug,
      interactionLockedMTRef,
      listEpochByRowMTRef,
      recordNormalizeStormEventAndMaybeDisableMT,
      requestNormalizeRowMT,
      rowBaseLensMTRef,
    ],
  );

  const createScrollToUpperEdgeMT = useCallback(
    (rowIndex: number) => {
      const handler = () => {
        "main thread";
        if (interactionLockedMTRef.current) return;
        // 事件门禁：只处理当前 epoch 的行；且必须 layoutReady/baseLen 正常
        const epoch = autoScrollEpochMTRef.current;
        if ((listEpochByRowMTRef.current?.[rowIndex] ?? 0) !== epoch) return;
        if (!autoScrollLayoutReadyRef.current?.[rowIndex]) return;
        if ((rowBaseLensMTRef.current?.[rowIndex] ?? 0) <= 0) return;
        if (recordNormalizeStormEventAndMaybeDisableMT()) return;
        if (debug) {
          console.info("[DanmakuV2][EVT] scrolltoupperedge(edge)", {
            row: rowIndex,
          });
        }
        requestNormalizeRowMT(rowIndex, "upper", "edge");
      };
      return handler;
    },
    [
      autoScrollEpochMTRef,
      autoScrollLayoutReadyRef,
      debug,
      interactionLockedMTRef,
      listEpochByRowMTRef,
      recordNormalizeStormEventAndMaybeDisableMT,
      requestNormalizeRowMT,
      rowBaseLensMTRef,
    ],
  );

  const createScrollToLowerEdgeMT = useCallback(
    (rowIndex: number) => {
      const handler = () => {
        "main thread";
        if (interactionLockedMTRef.current) return;
        // 事件门禁：只处理当前 epoch 的行；且必须 layoutReady/baseLen 正常
        const epoch = autoScrollEpochMTRef.current;
        if ((listEpochByRowMTRef.current?.[rowIndex] ?? 0) !== epoch) return;
        if (!autoScrollLayoutReadyRef.current?.[rowIndex]) return;
        if ((rowBaseLensMTRef.current?.[rowIndex] ?? 0) <= 0) return;
        if (recordNormalizeStormEventAndMaybeDisableMT()) return;
        if (debug) {
          console.info("[DanmakuV2][EVT] scrolltoloweredge(edge)", {
            row: rowIndex,
          });
        }
        requestNormalizeRowMT(rowIndex, "lower", "edge");
      };
      return handler;
    },
    [
      autoScrollEpochMTRef,
      autoScrollLayoutReadyRef,
      debug,
      interactionLockedMTRef,
      listEpochByRowMTRef,
      recordNormalizeStormEventAndMaybeDisableMT,
      requestNormalizeRowMT,
      rowBaseLensMTRef,
    ],
  );

  const finalCheckAllRowsMT = useCallback(() => {
    "main thread";
    if (interactionLockedMTRef.current) return;
    if (isNormalizeStormDisabledMT()) return;
    /**
     * final normalize：用于手势/惯性结束的收尾。
     *
     * 特点：
     * - 不强调“立即强制跳转”，更像是把越界风险收敛回安全区
     * - 每行只调用一次：通过 getVisibleCells 评估是否进入任一侧不安全区，必要时才纠偏
     */
    for (let i = 0; i < safeRows; i++) {
      normalizeRowMT(i, "lower", "final");
    }
  }, [interactionLockedMTRef, isNormalizeStormDisabledMT, normalizeRowMT, safeRows]);

  const stopNormalizeWatchdogMT = useCallback(() => {
    "main thread";
    normalizeWatchdogRunningRef.current = false;
  }, [normalizeWatchdogRunningRef]);

  const kickNormalizeWatchdogMT = useCallback(() => {
    "main thread";
    if (interactionLockedMTRef.current) return;
    if (!autoScrollEnabledMTRef.current) return;
    if (isNormalizeStormDisabledMT()) return;

    // 幂等：允许多处 kick，但只跑一条循环
    const currentEpoch = autoScrollEpochMTRef.current;
    normalizeWatchdogEpochRef.current = currentEpoch;
    normalizeWatchdogNextAtMsRef.current = 0;

    if (normalizeWatchdogRunningRef.current) return;
    normalizeWatchdogRunningRef.current = true;

    if (debug) {
      console.info("[DanmakuV2][N] watchdog-kick", {
        epoch: currentEpoch,
        sweepMs: WATCHDOG_SWEEP_MS,
      });
    }

    function frame() {
      "main thread";
      if (!normalizeWatchdogRunningRef.current) return;
      if (isNormalizeStormDisabledMT()) {
        normalizeWatchdogRunningRef.current = false;
        return;
      }

      // 强门禁：只在允许自动滚动且可交互时运行；否则直接停止（由 enable/unlock 再次 kick）
      if (interactionLockedMTRef.current || !autoScrollEnabledMTRef.current) {
        normalizeWatchdogRunningRef.current = false;
        return;
      }

      // 拖拽/惯性期间不做巡检：手势结束有 finalCheckAllRowsMT；避免与手势/惯性抢 list
      if (isDraggingRef.current || momentumRunningRef.current) {
        requestAnimationFrame(frame);
        return;
      }

      // epoch 变化：自动停止，避免旧代际循环落到新代际
      const currentEpoch = autoScrollEpochMTRef.current;
      if (normalizeWatchdogEpochRef.current !== currentEpoch) {
        normalizeWatchdogRunningRef.current = false;
        return;
      }

      const now = nowMs();
      const nextAt = normalizeWatchdogNextAtMsRef.current || 0;
      if (now < nextAt) {
        requestAnimationFrame(frame);
        return;
      }

      const baseLens = rowBaseLensMTRef.current ?? [];
      let activeRows = 0;
      for (let i = 0; i < safeRows; i++) {
        if ((baseLens[i] ?? 0) > 0) activeRows += 1;
      }
      if (activeRows <= 0) {
        // 空数据：停止，避免无意义循环
        normalizeWatchdogRunningRef.current = false;
        return;
      }

      // 目标：在 WATCHDOG_SWEEP_MS 内扫完一轮（safeRows<=5 → 通常每秒 1 行）
      const intervalMs = Math.max(200, Math.ceil(WATCHDOG_SWEEP_MS / activeRows));
      normalizeWatchdogNextAtMsRef.current = now + intervalMs;

      // round-robin 找到下一条“有内容”的行
      let cursor = Math.max(0, Math.floor(normalizeWatchdogCursorRef.current));
      cursor %= safeRows;
      let picked: number | null = null;
      for (let attempt = 0; attempt < safeRows; attempt++) {
        const row = cursor;
        cursor = (cursor + 1) % safeRows;
        if ((baseLens[row] ?? 0) <= 0) continue;
        // 只处理当前 epoch 的行（避免旧 ref/迟到实例）
        if ((listEpochByRowMTRef.current?.[row] ?? 0) !== currentEpoch) continue;
        picked = row;
        break;
      }
      normalizeWatchdogCursorRef.current = cursor;

      if (picked !== null) {
        // 兜底：final normalize 本身会“安全区不跳”，且受 lock/cooldown/timeout 防护
        normalizeRowMT(picked, "lower", "final");
      }

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }, [
    WATCHDOG_SWEEP_MS,
    autoScrollEnabledMTRef,
    autoScrollEpochMTRef,
    debug,
    interactionLockedMTRef,
    isNormalizeStormDisabledMT,
    isDraggingRef,
    listEpochByRowMTRef,
    momentumRunningRef,
    normalizeRowMT,
    normalizeWatchdogCursorRef,
    normalizeWatchdogEpochRef,
    normalizeWatchdogNextAtMsRef,
    normalizeWatchdogRunningRef,
    rowBaseLensMTRef,
    safeRows,
  ]);

  return {
    createScrollToUpperMT,
    createScrollToLowerMT,
    createScrollToUpperEdgeMT,
    createScrollToLowerEdgeMT,
    finalCheckAllRowsMT,
    restoreAutoScrollAfterNormalizeMT,
    requestNormalizeRowMT,
    kickNormalizeWatchdogMT,
    stopNormalizeWatchdogMT,
  };
}
