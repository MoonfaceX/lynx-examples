import { useCallback, useMemo } from "@lynx-js/react";
import type { MainThread } from "@lynx-js/types";

import type { DanmakuV2PerfMetrics, DanmakuV2PerfResult, GetVisibleCellsResult } from "../types";
import { AUTO_SCROLL_RATE, ensureRefLenFilledMT } from "../utils";
import { invokeListMethod } from "./invoke";
import { computeProbeIntervalMs, nowMs } from "./mainThreadMath";
import type { DanmakuV2MainThreadRefs } from "./types";

/**
 * autoScroll 子系统（主线程）
 *
 * 这个文件负责“在主线程上安全地启动/停止原生 autoScroll”，并处理三类关键门禁：
 * - **代际门禁（epoch）**：屏蔽迟到事件与非当前代 ref/实例，避免污染当前状态机
 * - **就绪门禁（layoutReady/probe）**：确保 list 已经可以安全 invoke（否则 invoke 可能 reject/throw）
 * - **repeat 收敛门禁（stableEpoch）**：避免 repeat 仍在提升/重建时启动 autoScroll，造成“先滚一下再重建”的闪动
 *
 * 重要说明：
 * - 这里不直接暴露“start/stop”接口，统一对外暴露 `scheduleAttemptStartAutoScrollMT`（调度器）。
 * - “开关”不由本文件同步：开关的唯一来源在 `autoScrollEnabledMTRef`，由 `setAutoScrollEnabled` 命令写入。
 * - `rowBaseLens` 参数来自 BG 渲染期快照：用于首屏快速判断哪些行有内容（减少等待镜像同步的窗口）。
 */
export function useDanmakuV2AutoScrollSubsystem(params: {
  safeRows: number;
  debug: boolean;
  // BG 渲染期可得：用于 autoScroll 首屏判断“哪些行需要滚动”
  rowBaseLens: number[];
  refs: DanmakuV2MainThreadRefs;
  /** 性能打点数据（ref 形式，用于主线程读取） */
  perfMetricsRef?: { current: DanmakuV2PerfMetrics | undefined };
  /** 性能打点上报回调（BG 侧） */
  onPerfMetricsChange?: (result: DanmakuV2PerfResult) => void;
}) {
  const { safeRows, debug, rowBaseLens, refs, perfMetricsRef, onPerfMetricsChange } = params;

  const {
    listMTRefs,
    interactionLockedMTRef,
    autoScrollEnabledMTRef,
    autoScrollLayoutReadyRef,
    autoScrollEpochMTRef,
    listEpochByRowMTRef,
    autoScrollAttemptScheduledMTRef,
    autoScrollWaitEpochMTRef,
    autoScrollWaitStartedAtMsMTRef,
    autoScrollProbeAttemptsByRowMTRef,
    autoScrollLastProbeAtMsByRowMTRef,
    autoScrollBlockedUntilMsMTRef,
    autoScrollLayoutEverReadyByRowMTRef,
    autoScrollingMTRef,
    isDraggingRef,
    momentumRunningRef,
    repeatStableEpochByRowMTRef,
    rowBaseLensMTRef,
    repeatByRowMTRef,
  } = refs;

  const scheduleAttemptStartAutoScrollMT = useCallback(() => {
    "main thread";
    // 首屏拆分加载阶段：严格禁止任何 autoScroll/probe（ready 后再统一放开）
    if (interactionLockedMTRef.current) {
      if (debug) console.info("[DanmakuV2][AS] skip:interaction-locked");
      return;
    }
    /**
     * scheduleAttemptStartAutoScrollMT：统一的“尝试启动”调度器。
     *
     * 设计要点：
     * - 不能同步立即 start：因为 ref/layout/probe/repeatStable/epoch 都可能尚未就绪
     * - 因此用 rAF 轮询 + 门禁判断的方式，在条件满足时启动；条件不满足时要么等待，要么早退
     */
    if (autoScrollingMTRef.current) return;
    /**
     * 重要：拖拽/惯性期间也允许进入调度器。
     *
     * 原因：
     * - `autoScrollLayoutReadyRef` 的语义是“该行 list 已可安全 invoke（getVisibleCells/scrollToPosition/autoScroll）”；
     * - normalize 的 threshold/edge 事件会用它做门禁；
     * - 若拖拽期间完全早退，会阻断 probe（getVisibleCells）补齐 ready，导致首屏立刻拖拽时 normalize 无法工作而“撞墙”。
     *
     * 约束：
     * - 我们只允许“probe 补齐 ready”，不会在拖拽/惯性期间启动原生 autoScroll（启动门禁在后面单独检查）。
     */
    if (autoScrollAttemptScheduledMTRef.current) return;

    autoScrollAttemptScheduledMTRef.current = true;

    const frame = () => {
      "main thread";
      autoScrollAttemptScheduledMTRef.current = false;

      // 关键日志：每次 frame 开始时的状态
      if (debug) {
        console.info("[DanmakuV2][AS] frame-start", {
          epoch: autoScrollEpochMTRef.current,
          autoScrolling: autoScrollingMTRef.current,
        });
      }

      if (autoScrollingMTRef.current) return;
      // 注意：这里不再因为 dragging/momentum 早退；拖拽/惯性期间仍允许 probe 补齐 ready。

      // epoch：当前主线程代际。所有“是否属于当前实例”的判断都必须基于它。
      const epoch = autoScrollEpochMTRef.current;
      const lists = listMTRefs.current;

      // 直接使用 BG 渲染期计算的 rowBaseLens（JSON 序列化可捕获）
      const baseLens = rowBaseLens;

      // 所有 per-row 数组必须与 safeRows 对齐（避免越界与旧值污染）
      if (lists && lists.length !== safeRows) lists.length = safeRows;
      if (autoScrollLayoutReadyRef.current?.length !== safeRows) {
        autoScrollLayoutReadyRef.current = Array(safeRows).fill(false);
      }
      if (listEpochByRowMTRef.current?.length !== safeRows) {
        listEpochByRowMTRef.current = Array(safeRows).fill(0);
      }
      if (autoScrollProbeAttemptsByRowMTRef.current?.length !== safeRows) {
        autoScrollProbeAttemptsByRowMTRef.current = Array(safeRows).fill(0);
      }
      if (autoScrollLastProbeAtMsByRowMTRef.current?.length !== safeRows) {
        autoScrollLastProbeAtMsByRowMTRef.current = Array(safeRows).fill(0);
      }
      // repeatStableEpochByRowMTRef 可能已写入或尚未写入；这里做长度保护确保可读
      ensureRefLenFilledMT(repeatStableEpochByRowMTRef, safeRows, -1);

      /**
       * 先检查“必需前置条件”：
       * - 对于 baseLen<=0 的行：这行没有内容，无需滚动，也不参与门禁
       * - 对于 baseLen>0 的行：
       *   - 必须有 ref（否则无法 invoke）
       *   - 必须属于当前 epoch（否则是非当前代实例/迟到 ref）
       *   - 若 layoutReady=false，需要进入 probe 流程把 ready 补齐
       */
      let needProbeRow: number | null = null;
      for (let i = 0; i < safeRows; i++) {
        const baseLen = baseLens[i] ?? 0;
        if (baseLen <= 0) continue;
        const el = lists[i];
        if (!el) {
          if (debug) console.info("[DanmakuV2][AS] wait-ref", { epoch, row: i });
          return;
        }
        if ((listEpochByRowMTRef.current[i] ?? 0) !== epoch) {
          if (debug) {
            console.info("[DanmakuV2][AS] wait-epoch-ref", {
              epoch,
              row: i,
              rowEpoch: listEpochByRowMTRef.current[i] ?? 0,
            });
          }
          return;
        }
        if (!autoScrollLayoutReadyRef.current[i]) {
          // 优化：如果该行曾经 ready 过（非首次切换），list 未 remount 则大概率仍可 invoke，
          // 直接标记 ready 跳过 probe 流程，减少 ready→scroll 延迟
          if (autoScrollLayoutEverReadyByRowMTRef.current?.[i]) {
            autoScrollLayoutReadyRef.current[i] = true;
            continue;
          }
          needProbeRow = i;
          break;
        }
      }

      if (needProbeRow !== null) {
        /**
         * probe 流程：用 `getVisibleCells` 作为“就绪探测”。
         *
         * 原因：
         * - 某些环境下 list 刚挂载/刚 remount 的短时间内，invoke('autoScroll')/invoke('scrollToPosition')
         *   可能 reject/throw（底层尚未 ready）。
         * - `getVisibleCells` 是一个相对安全的探测调用：成功后通常意味着 list 已具备可操作性。
         */
        const now = nowMs();
        if (autoScrollWaitEpochMTRef.current !== epoch) {
          // epoch 变化：重置等待窗口（避免把旧 epoch 的 waitedMs 带到新 epoch）
          autoScrollWaitEpochMTRef.current = epoch;
          autoScrollWaitStartedAtMsMTRef.current = now;
        }
        const waitedMs = now - (autoScrollWaitStartedAtMsMTRef.current || now);
        // 防止无限等待：超过阈值直接停止等待（后续仍可由其它事件再次触发 schedule）
        if (waitedMs > 3000) return;

        const rowIndex = needProbeRow;
        const attempts = autoScrollProbeAttemptsByRowMTRef.current[rowIndex] ?? 0;
        const lastAt = autoScrollLastProbeAtMsByRowMTRef.current[rowIndex] ?? 0;
        // 指数退避：避免每帧都 probe，造成无意义 invoke 风暴
        const intervalMs = computeProbeIntervalMs(attempts);

        if (now - lastAt >= intervalMs) {
          autoScrollProbeAttemptsByRowMTRef.current[rowIndex] = attempts + 1;
          autoScrollLastProbeAtMsByRowMTRef.current[rowIndex] = now;
          const el = lists[rowIndex];
          if (el) {
            try {
              const ret = el.invoke("getVisibleCells") as Promise<GetVisibleCellsResult>;
              ret
                .then(() => {
                  // probe 成功：只在“仍属于当前 epoch”时落地 ready（防止迟到 promise 写入）
                  if ((listEpochByRowMTRef.current[rowIndex] ?? 0) === epoch) {
                    autoScrollLayoutReadyRef.current[rowIndex] = true;
                    // 记录该行曾经 ready 过（非首次切换时跳过 probe）
                    if (!autoScrollLayoutEverReadyByRowMTRef.current) {
                      autoScrollLayoutEverReadyByRowMTRef.current = [];
                    }
                    if (autoScrollLayoutEverReadyByRowMTRef.current.length < safeRows) {
                      for (
                        let j = autoScrollLayoutEverReadyByRowMTRef.current.length;
                        j < safeRows;
                        j++
                      ) {
                        autoScrollLayoutEverReadyByRowMTRef.current[j] = false;
                      }
                    }
                    autoScrollLayoutEverReadyByRowMTRef.current[rowIndex] = true;
                  }
                })
                .catch(() => {});
            } catch {
              console.error("DanmakuV2: autoScrollProbeAttemptsByRowMTRef failed");
            }
          }
        }

        // 继续下一帧尝试：直到 ready 补齐或等待超时
        if (!autoScrollAttemptScheduledMTRef.current) {
          autoScrollAttemptScheduledMTRef.current = true;
          requestAnimationFrame(frame);
        }
        return;
      }

      // 说明：
      // - autoScrollLayoutReadyRef 不仅用于启动 autoScroll，也用于 normalize/边界处理时的 invoke 安全性判定。
      // - 因此即使 autoScroll=false，也应允许通过 probe 把 ready 补齐，避免“关闭 autoScroll 导致 normalize 永久被早退”。
      //
      // 进一步：
      // - 即使正在拖拽/惯性，我们也需要允许 probe 把 ready 补齐（否则首屏立刻拖拽可能撞墙）。
      // - 但拖拽/惯性期间不启动原生 autoScroll（避免与手势/惯性并发抢滚动源）。
      if (isDraggingRef.current || momentumRunningRef.current) return;
      if (!autoScrollEnabledMTRef.current) return;

      /**
       * repeat 收敛门禁（stableEpoch）：
       * - repeat 提升会导致 list remount（listId 含 repeatTimes）
       * - 若在提升窗口期启动 autoScroll，可能出现视觉闪动与状态机不稳定
       * - 因此对所有"有内容"的行，必须等待 stableEpoch===epoch 才允许 start
       */
      for (let i = 0; i < safeRows; i++) {
        const baseLen = baseLens[i] ?? 0;
        if (baseLen <= 0) continue;
        const stableEpoch = repeatStableEpochByRowMTRef.current[i] ?? -1;
        if (stableEpoch !== epoch) {
          if (debug) {
            console.info("[DanmakuV2][AS] wait-repeat-stable", {
              epoch,
              row: i,
              baseLen,
              stableEpoch,
            });
          }
          return;
        }
      }

      // 关键日志：所有门禁通过，准备启动 autoScroll
      if (debug) {
        console.info("[DanmakuV2][AS] all-gates-passed", {
          epoch,
          safeRows,
          baseLens,
        });
      }

      /**
       * 用户手动滚动冷却门禁：
       * - 只影响原生 autoScroll 的启动时机；
       * - 不影响 probe（layoutReady 补齐）与其它门禁判断；
       * - 为保证“到点自动恢复”，这里在冷却未到期时继续 rAF 轮询（且复用 attemptScheduled 防风暴）。
       */
      const now = nowMs();
      const blockedUntil = autoScrollBlockedUntilMsMTRef.current || 0;
      if (blockedUntil > now) {
        // if (debug) {
        //   console.info('[DanmakuV2][AS] wait-user-cooldown', {
        //     epoch,
        //     blockedUntil,
        //     now,
        //     remainingMs: blockedUntil - now,
        //   });
        // }
        if (!autoScrollAttemptScheduledMTRef.current) {
          autoScrollAttemptScheduledMTRef.current = true;
          requestAnimationFrame(frame);
        }
        return;
      }

      // 在这一次"尝试启动 autoScroll"的循环里，是否至少有一行 `<list>` 成功发起了 `invoke('autoScroll', { start: true })`。
      // 它的作用是用来更新主线程的运行态标记 autoScrollingMTRef.current：
      let startedAny = false;
      for (let i = 0; i < safeRows; i++) {
        const baseLen = baseLens[i] ?? 0;
        if (baseLen <= 0) continue;
        const el = lists[i];
        if (!el) continue;
        try {
          if (debug) {
            console.info("[DanmakuV2][AS] start", { epoch, row: i, baseLen });
          }
          /**
           * 原生 autoScroll：
           * - rate：滚动速率（字符串）
           * - autoStop=false：由我们自己管理停止时机（手势优先/开关关闭/epoch 切换）
           */
          invokeListMethod(
            el,
            "autoScroll",
            {
              rate: AUTO_SCROLL_RATE,
              start: true,
              autoStop: false,
            },
            {
              onSuccess: () => {
                if (debug) {
                  console.info("[DanmakuV2][AS] start-success", { epoch, row: i });
                }
                // autoScroll 启动成功也意味着该行 ready，标记 everReady
                if (!autoScrollLayoutEverReadyByRowMTRef.current) {
                  autoScrollLayoutEverReadyByRowMTRef.current = [];
                }
                if (autoScrollLayoutEverReadyByRowMTRef.current.length < safeRows) {
                  for (
                    let j = autoScrollLayoutEverReadyByRowMTRef.current.length;
                    j < safeRows;
                    j++
                  ) {
                    autoScrollLayoutEverReadyByRowMTRef.current[j] = false;
                  }
                }
                autoScrollLayoutEverReadyByRowMTRef.current[i] = true;
                // 记录 autoScroll 启动成功时间戳（只记录一次）
                const currentPerf = perfMetricsRef?.current;
                if (currentPerf && !currentPerf.scrollStartTime) {
                  currentPerf.scrollStartTime = Date.now();
                  console.info(
                    `[DanmakuV2][Perf] autoScroll 启动成功 epoch=${epoch} row=${i} deltaFromClick=${
                      currentPerf.scrollStartTime - currentPerf.clickTimestamp
                    }ms`,
                  );
                  // 如果所有阶段都已完成，直接输出耗时报告
                  if (
                    currentPerf.clickTimestamp
                    && currentPerf.dataSwitchTime
                    && currentPerf.bootstrapTime
                    && currentPerf.readyTime
                  ) {
                    const totalMs = currentPerf.scrollStartTime - currentPerf.clickTimestamp;
                    const clickToData = currentPerf.dataSwitchTime - currentPerf.clickTimestamp;
                    const dataToBootstrap = currentPerf.bootstrapTime - currentPerf.dataSwitchTime;
                    const bootstrapToReady = currentPerf.readyTime - currentPerf.bootstrapTime;
                    const readyToScroll = currentPerf.scrollStartTime - currentPerf.readyTime;
                    console.info(
                      `[DanmakuV2][Perf] 完整耗时报告 total=${totalMs}ms | click→data=${clickToData}ms data→bootstrap=${dataToBootstrap}ms bootstrap→ready=${bootstrapToReady}ms ready→scroll=${readyToScroll}ms`,
                    );
                  }
                }
              },
              onError: (error) => {
                if (debug) {
                  console.warn("[DanmakuV2][AS] start-error", { epoch, row: i, error });
                }
                autoScrollingMTRef.current = false;
                autoScrollLayoutReadyRef.current[i] = false;
                if (!autoScrollAttemptScheduledMTRef.current) {
                  autoScrollAttemptScheduledMTRef.current = true;
                  requestAnimationFrame(frame);
                }
              },
            },
          );
          startedAny = true;
        } catch (e) {
          // invoke 同步抛错：同样认为该行未 ready，回到 probe 自愈流程
          if (debug) {
            console.warn("[DanmakuV2][AS] start-throw", { epoch, row: i, e });
          }
          autoScrollLayoutReadyRef.current[i] = false;
          if (!autoScrollAttemptScheduledMTRef.current) {
            autoScrollAttemptScheduledMTRef.current = true;
            requestAnimationFrame(frame);
          }
        }
      }

      autoScrollingMTRef.current = startedAny;
    };

    requestAnimationFrame(frame);
  }, [
    autoScrollAttemptScheduledMTRef,
    autoScrollEnabledMTRef,
    autoScrollEpochMTRef,
    autoScrollLastProbeAtMsByRowMTRef,
    autoScrollLayoutReadyRef,
    autoScrollProbeAttemptsByRowMTRef,
    autoScrollWaitEpochMTRef,
    autoScrollWaitStartedAtMsMTRef,
    autoScrollingMTRef,
    debug,
    interactionLockedMTRef,
    isDraggingRef,
    listEpochByRowMTRef,
    listMTRefs,
    momentumRunningRef,
    autoScrollBlockedUntilMsMTRef,
    repeatStableEpochByRowMTRef,
    rowBaseLens,
    safeRows,
  ]);

  type ListMainThreadRefHandler = (el: MainThread.Element | null) => void;

  const listMainThreadRefHandlers = useMemo(() => {
    const handlers: ListMainThreadRefHandler[] = Array.from({ length: safeRows }, () => () => {});
    for (let rowIndex = 0; rowIndex < safeRows; rowIndex++) {
      handlers[rowIndex] = (el: MainThread.Element | null) => {
        "main thread";
        /**
         * 每行 `<list>` 的 ref handler：
         * - el!=null：绑定新实例
         * - el==null：解绑当前行的实例（例如被 remount 替换）
         *
         * 注意：同一行在 repeat 提升时会 remount（新实例），因此 ref 变化是常态之一。
         */
        const prev = listMTRefs.current?.[rowIndex] ?? null;
        if (prev === el) return;
        listMTRefs.current[rowIndex] = el;

        if (debug) {
          console.info("[DanmakuV2][REF] list-ref-changed", {
            row: rowIndex,
            hasPrev: !!prev,
            hasNext: !!el,
            epoch: autoScrollEpochMTRef.current,
          });
        }

        // list 元素发生替换/解绑时：停止"已启动"标记，避免继续认为处于 autoScrolling 状态
        autoScrollingMTRef.current = false;

        if (!listEpochByRowMTRef.current || listEpochByRowMTRef.current.length !== safeRows) {
          listEpochByRowMTRef.current = Array(safeRows).fill(0);
        }
        if (
          !autoScrollLayoutReadyRef.current
          || autoScrollLayoutReadyRef.current.length !== safeRows
        ) {
          autoScrollLayoutReadyRef.current = Array(safeRows).fill(false);
        }
        if (
          !autoScrollProbeAttemptsByRowMTRef.current
          || autoScrollProbeAttemptsByRowMTRef.current.length !== safeRows
        ) {
          autoScrollProbeAttemptsByRowMTRef.current = Array(safeRows).fill(0);
        }
        if (
          !autoScrollLastProbeAtMsByRowMTRef.current
          || autoScrollLastProbeAtMsByRowMTRef.current.length !== safeRows
        ) {
          autoScrollLastProbeAtMsByRowMTRef.current = Array(safeRows).fill(0);
        }

        if (el) {
          /**
           * 绑定新实例：
           * - 把该行标记为当前 epoch（使事件 handler 通过门禁）
           * - 把 ready/probe 相关状态重置，让新实例重新走 layoutcomplete/probe 收敛
           */
          const epoch = autoScrollEpochMTRef.current;
          listEpochByRowMTRef.current[rowIndex] = epoch;
          autoScrollLayoutReadyRef.current[rowIndex] = false;
          autoScrollProbeAttemptsByRowMTRef.current[rowIndex] = 0;
          autoScrollLastProbeAtMsByRowMTRef.current[rowIndex] = 0;

          // ref 绑定可能解锁启动条件（例如最后一行 ref 刚就绪），主动触发一次尝试
          scheduleAttemptStartAutoScrollMT();
        } else {
          /**
           * 解绑实例：
           * - rowEpoch=0 表示该行不可操作
           * - ready=false 避免后续事件误判为可 invoke
           * - 对 prev 停止原生 autoScroll（此时 el=null，只能用 prev）
           *
           * 注意：这里直接在解绑分支内执行副作用，不再通过 return cleanup 的方式，
           * 避免 ref cleanup 与解绑回调被重复触发导致同一次 remount 出现多次销毁日志。
           */
          listEpochByRowMTRef.current[rowIndex] = 0;
          autoScrollLayoutReadyRef.current[rowIndex] = false;
          if (prev) {
            try {
              prev.invoke("autoScroll", { start: false });
            } catch {}
          }
        }
      };
    }
    return handlers;
  }, [
    autoScrollingMTRef,
    autoScrollEpochMTRef,
    autoScrollLastProbeAtMsByRowMTRef,
    autoScrollLayoutReadyRef,
    autoScrollProbeAttemptsByRowMTRef,
    debug,
    listEpochByRowMTRef,
    listMTRefs,
    scheduleAttemptStartAutoScrollMT,
    safeRows,
  ]);

  const createListLayoutCompleteMT = useCallback(
    (rowIndex: number, baseLen: number, repeatTimes: number) => {
      const handler = () => {
        "main thread";
        const epoch = autoScrollEpochMTRef.current;

        if (
          !autoScrollLayoutReadyRef.current
          || autoScrollLayoutReadyRef.current.length !== safeRows
        ) {
          autoScrollLayoutReadyRef.current = Array(safeRows).fill(false);
        }
        if (!listEpochByRowMTRef.current || listEpochByRowMTRef.current.length !== safeRows) {
          listEpochByRowMTRef.current = Array(safeRows).fill(0);
        }

        if ((listEpochByRowMTRef.current[rowIndex] ?? 0) !== epoch) return;

        /**
         * layoutcomplete：把这行标记为“可 invoke（ready）”，并同步主线程镜像数据。
         *
         * 为什么要同步镜像：
         * - normalize 需要 baseLen/repeatTimes 计算 blockLen/totalLen
         * - autoScroll 需要 baseLen 判断“该行是否需要滚动”
         *
         * 注意：这里的 baseLen/repeatTimes 来自渲染层绑定时的参数；
         * 即使 BG→MT 的 effects 镜像同步存在延迟，这里也能在“行就绪”时把关键值补齐。
         */
        ensureRefLenFilledMT(rowBaseLensMTRef, safeRows, 0);
        ensureRefLenFilledMT(repeatByRowMTRef, safeRows, 1);
        rowBaseLensMTRef.current[rowIndex] = Math.max(0, Math.floor(baseLen || 0));
        repeatByRowMTRef.current[rowIndex] = Math.max(1, Math.floor(repeatTimes || 1));

        if (debug) {
          console.info("[DanmakuV2][MT] layoutcomplete", {
            row: rowIndex,
            epoch,
          });
        }
        autoScrollLayoutReadyRef.current[rowIndex] = true;
        // 记录该行曾经 ready 过（非首次切换时跳过 probe）
        if (!autoScrollLayoutEverReadyByRowMTRef.current) {
          autoScrollLayoutEverReadyByRowMTRef.current = [];
        }
        if (autoScrollLayoutEverReadyByRowMTRef.current.length < safeRows) {
          for (let j = autoScrollLayoutEverReadyByRowMTRef.current.length; j < safeRows; j++) {
            autoScrollLayoutEverReadyByRowMTRef.current[j] = false;
          }
        }
        autoScrollLayoutEverReadyByRowMTRef.current[rowIndex] = true;
        // 这行变为 ready 后可能解锁启动条件，主动触发一次尝试
        scheduleAttemptStartAutoScrollMT();
      };
      return handler;
    },
    [
      autoScrollEpochMTRef,
      autoScrollLayoutReadyRef,
      debug,
      listEpochByRowMTRef,
      repeatByRowMTRef,
      rowBaseLensMTRef,
      safeRows,
      scheduleAttemptStartAutoScrollMT,
    ],
  );

  return {
    scheduleAttemptStartAutoScrollMT,
    listMainThreadRefHandlers,
    createListLayoutCompleteMT,
  };
}
