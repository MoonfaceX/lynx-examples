import { runOnBackground, runOnMainThread, useCallback } from "@lynx-js/react";

import type { MainThread } from "@lynx-js/types";
import type { DanmakuV2MomentumMode, DanmakuV2PerfMetrics } from "../types";
import type { GetVisibleCellsResult } from "../types";
import { useDanmakuV2AutoScrollSubsystem } from "./autoScroll";
import { useDanmakuV2MainThreadEffects } from "./effects";
import { useDanmakuV2GestureSubsystem } from "./gesture";
import { invokeListMethod } from "./invoke";
import { nowMs } from "./mainThreadMath";
import { useDanmakuV2NormalizeSubsystem } from "./normalize";
import { useDanmakuV2MainThreadRefs } from "./refs";
import type { DanmakuV2MainThreadController } from "./types";

export type { DanmakuV2MainThreadController } from "./types";

/**
 * 主线程控制器入口（组装层）
 *
 * ## 这个文件负责什么
 * - 聚合/组装主线程相关的子系统：
 *   - autoScroll：启动/停止原生 autoScroll、处理 ref 绑定、就绪探测
 *   - normalize：threshold/edge 触发时的索引锚点归一化（scrollToPosition）
 *   - gesture：手势拖拽 + 惯性滚动（scrollBy）
 *   - effects：BG→MT 的代际同步与镜像数据同步（rowBaseLens/repeatByRow）
 * - 对外暴露：
 *   - 渲染绑定所需的一组 main-thread handlers（ref/bindtouch/bindlayoutcomplete/bindscroll* 等）
 *   - 一个命令式开关 `setAutoScrollEnabled`（用于在不改动渲染树的情况下控制滚动）
 *
 * ## 数据流（高层）
 * - BG（React）调用 `setAutoScrollEnabled` → runOnMainThread → MT 写入开关并触发 start/stop
 * - BG 传入 rowsData/repeatByRow/rowBaseLens → `effects.ts` 同步到 MT 镜像 refs → 影响 autoScroll/normalize 门禁
 * - MT 触摸事件 → gesture 子系统驱动 scrollBy + 惯性 → normalize 子系统收敛边界 →（若开关允许）恢复 autoScroll
 *
 * - **BG/MT 运行时边界**
 *   - **BG（background）**：普通 JS/React 线程。可以安全访问 props、执行 setState、调用业务回调。
 *   - **MT（main thread worklet）**：Lynx 主线程运行时。只能执行带 `'main thread'` 标记的函数体。
 *   - **从 BG 到 MT**：必须通过 `runOnMainThread(fn)(...args)` 下发（fn 内部再标记 `'main thread'`）。
 *   - **从 MT 回到 BG**：必须通过 `runOnBackground(fn)(...args)`（用于调用业务回调/访问 props 语义数据）。
 *   - 命名约定：`*MT` 表示运行在主线程；`*BG` 表示运行在后台线程（或被 `runOnBackground` 调用）。
 *
 * - **epoch 与 autoScrollEpochMTRef 的对应关系**
 *   - `epoch`：BG 侧的“数据代际编号”（由业务侧 `dataEpoch` 提供；只在数据语义/行数变化时推进）。
 *   - `autoScrollEpochMTRef.current`：MT 侧保存的“当前代际编号”。
 *   - 同步路径：`effects.ts` 会把 `epoch` 下发到 MT，并写入 `autoScrollEpochMTRef.current`。
 *   - 目的：MT 上所有事件/异步 promise（getVisibleCells/scrollToPosition/autoScroll）都可能迟到；
 *     通过“rowEpoch === epoch”门禁把非当前代际的迟到结果屏蔽掉，避免污染当前实例。
 *
 * - **safeRows 的意义**
 *   safeRows 是 “经过安全裁剪后的行数（rowsCount）”，用于确保 DanmakuV2 内部所有按行分配/按行存储的数组与渲染 <list> 的行数一致，避免出现 0 行、负数或过大的异常输入导致越界、空数组、或状态污染。
 *   - `safeRows` 是当前代际的“行数基准”：所有 per-row 数组（refs 内的 boolean[]/number[]）都必须对齐到它，
 *     所有 for 循环也必须按它迭代，避免越界与历史行残留状态污染。
 *
 * - **关键 refs 分组**
 *   - gesture：拖拽/速度/惯性运行态（例如 isDragging/momentum/velocity/totalDelta）
 *   - autoScroll：autoScroll 启动状态机（enabled/layoutReady/probe/attempt/wait/epoch）
 *   - normalize：normalize 锁、冷却、pending（避免并发与补做一次）
 *   - mirror：BG→MT 镜像数据（rowBaseLens/repeatByRow，用于门禁与计算）
 *   - repeatStable（stableEpoch）：repeat 是否已收敛（autoScroll 启动门禁之一）
 *
 * - **映射表**
 *   - `<view main-thread:bindtouchstart/move/end/cancel>` → `gesture.ts`
 *     - `onTouchStartMT` / `onTouchMoveMT` / `onTouchEndMT`
 *   - `<list main-thread:ref>` → `autoScroll.ts`
 *     - `listMainThreadRefHandlers[rowIndex]`（写 listMTRefs、对齐 rowEpoch）
 *   - `<list main-thread:bindlayoutcomplete>` → `autoScroll.ts`
 *     - `createListLayoutCompleteMT(rowIndex, baseLen, repeatTimes)`（写 layoutReady、同步镜像）
 *   - `<list main-thread:bindscrolltoupper/lower/(edge)>` → `normalize.ts`
 *     - `createScrollToUpperMT` / `createScrollToLowerMT` / `createScrollToUpperEdgeMT` / `createScrollToLowerEdgeMT`
 *   - item 点击：应在 BG 侧用 `bindtap` 处理（避免大量 `<list-item>` 绑定 `main-thread:*` 造成渲染压力）
 */
export function useDanmakuV2MainThreadController(params: {
  safeRows: number;
  /** 数据代际号（epoch）：用于主线程门禁与跨代重置 */
  epoch: number;
  debug: boolean;
  /**
   * 仅用于主线程开关“唯一来源”的首帧初值。
   * 后续开关变更通过 setAutoScrollEnabled 命令通道驱动。
   */
  initialAutoScroll: boolean;
  /**
   * 仅用于主线程“惯性模式”的首帧初值。
   * 后续模式变更通过 setMomentumMode 命令通道驱动。
   */
  initialMomentumMode: DanmakuV2MomentumMode;

  // BG 渲染期可得：用于 autoScroll 首屏判断“哪些行需要滚动”
  rowBaseLens: number[];

  // BG → MT 镜像同步
  effectiveRepeatByRow: number[];

  /** normalize watchdog 一轮扫完目标时长（ms），默认 5000 */
  normalizeWatchdogSweepMs?: number;

  // BG handlers
  reportUserScrollBG: (payload: {
    velocityX: number;
    totalDeltaAbsPx: number;
    durationMs: number;
  }) => void;
  /** 首屏拆分加载：主线程初始锁定状态（bootstrap/padding 阶段应为 true） */
  initialInteractionLocked?: boolean;
  /** ready 准备完成后回调 BG（用于解除渲染层门控并开放交互） */
  onReadyPreparedBG?: (epoch: number) => void;
  /** 性能打点数据（ref 形式，用于主线程读取当前代际的打点信息） */
  perfMetricsRef?: { current: DanmakuV2PerfMetrics | undefined };
}) {
  const {
    safeRows,
    epoch,
    debug,
    initialAutoScroll,
    initialMomentumMode,
    rowBaseLens,
    effectiveRepeatByRow,
    normalizeWatchdogSweepMs,
    reportUserScrollBG,
    initialInteractionLocked,
    onReadyPreparedBG,
    perfMetricsRef,
  } = params;

  /**
   * refs：主线程共享状态（由多个子系统共同读写）。
   *
   * 重要：
   * - 这里用 `initialAutoScroll` 初始化 `autoScrollEnabledMTRef`，仅决定“首帧主线程开关初值”
   * - 后续开关变更必须通过 `setAutoScrollEnabled` 命令通道下发，避免触发渲染树大提交
   */
  const { refs, lastEpochSyncedToMTRef } = useDanmakuV2MainThreadRefs({
    autoScroll: initialAutoScroll,
    momentumMode: initialMomentumMode,
    interactionLocked: initialInteractionLocked ?? false,
  });

  const {
    listMTRefs,
    autoScrollingMTRef,
    autoScrollEnabledMTRef,
    autoScrollAttemptScheduledMTRef,
    autoScrollWaitStartedAtMsMTRef,
    restoreScheduledRef,
    momentumRunningRef,
    momentumModeMTRef,
    interactionLockedMTRef,
  } = refs;

  // ===== 主线程：滚动所有 List =====
  /**
   * 将 dx（px）应用到所有行的 list（scrollBy）。
   * 该函数仅运行在主线程，用于手势拖拽与惯性滚动。
   * - `invoke('scrollBy')` 可能因 ref 未就绪/元素已解绑而抛错，因此这里吞掉异常，保证主线程稳定
   */
  const scrollAllListsMT = useCallback(
    (dx: number) => {
      "main thread";
      const lists = listMTRefs.current;
      for (let i = 0; i < safeRows; i++) {
        const el = lists[i];
        if (!el) continue;
        try {
          el.invoke("scrollBy", { offset: dx });
        } catch {
          // no-op
        }
      }
    },
    [listMTRefs, safeRows],
  );

  // ===== 主线程：停止原生 autoScroll =====
  /**
   * 停止所有行的原生 autoScroll。
   *
   * 注意：invoke 可能返回 promise 并 reject；这里统一吞掉避免影响主线程稳定性。
   *
   * 额外说明：
   * - `autoScrollingMTRef` 表示“主线程是否认为已对任一行启动过 autoScroll”（运行态的唯一来源标记）
   * - stop 成功与否不影响我们把 `autoScrollingMTRef` 置回 false：它是上层状态机的“意图一致性”
   */
  const stopNativeAutoScrollMT = useCallback(() => {
    "main thread";
    const lists = listMTRefs.current;
    for (let i = 0; i < safeRows; i++) {
      const el = lists[i];
      if (!el) continue;
      try {
        const ret = el.invoke("autoScroll", { start: false });
        const maybePromise = ret as unknown as {
          catch?: (fn: (e: unknown) => void) => void;
        };
        if (maybePromise && typeof maybePromise.catch === "function") {
          maybePromise.catch(() => {});
        }
      } catch {
        // no-op
      }
    }
    autoScrollingMTRef.current = false;
  }, [autoScrollingMTRef, listMTRefs, safeRows]);

  /**
   * autoScroll 子系统（主线程）：
   * - `scheduleAttemptStartAutoScrollMT`：统一的“尝试启动”调度器（所有路径最终都会调用它）
   * - `listMainThreadRefHandlers`：每行 `<list main-thread:ref>` 的 ref 绑定/解绑处理（写 listMTRefs/listEpoch，并重置该行的 ready/probe 状态）
   * - `createListLayoutCompleteMT`：每行 `<list main-thread:bindlayoutcomplete>`，用于标记 layout ready 与同步镜像数据
   */
  const {
    scheduleAttemptStartAutoScrollMT,
    listMainThreadRefHandlers,
    createListLayoutCompleteMT,
  } = useDanmakuV2AutoScrollSubsystem({
    safeRows,
    debug,
    // 首屏优化：把 BG 渲染期的 baseLen 作为可序列化快照捕获到主线程 worklet
    // 这样在首帧/首屏阶段不必等待 `effects.ts` 把 rowBaseLensMTRef 镜像同步完成。
    rowBaseLens,
    refs,
    perfMetricsRef,
  });

  const {
    createScrollToUpperMT,
    createScrollToLowerMT,
    createScrollToUpperEdgeMT,
    createScrollToLowerEdgeMT,
    finalCheckAllRowsMT,
    restoreAutoScrollAfterNormalizeMT,
    kickNormalizeWatchdogMT,
    stopNormalizeWatchdogMT,
  } = useDanmakuV2NormalizeSubsystem({
    safeRows,
    debug,
    refs,
    scheduleAttemptStartAutoScrollMT,
    watchdogSweepMs: normalizeWatchdogSweepMs,
  });

  /**
   * 交互/操作总门禁：用于首屏拆分加载阶段保持完全不可交互，ready 后再解除。
   */
  const setInteractionLocked = useCallback(
    (locked: boolean) => {
      "background only";
      runOnMainThread((nextLocked: boolean) => {
        "main thread";
        if (debug) {
          console.info("[DanmakuV2][MT] interactionLocked", {
            epoch: refs.autoScrollEpochMTRef.current,
            locked: nextLocked,
          });
        }
        interactionLockedMTRef.current = nextLocked;

        if (nextLocked) {
          // 严格锁定：确保没有任何滚动相关状态机在运行
          stopNormalizeWatchdogMT();
          stopNativeAutoScrollMT();
          restoreScheduledRef.current = false;
          momentumRunningRef.current = false;
          autoScrollAttemptScheduledMTRef.current = false;
          autoScrollWaitStartedAtMsMTRef.current = 0;
          return;
        }

        // 解锁：唤醒一次 autoScroll 状态机（是否启动仍受 enabled/repeatStable 等门禁）
        scheduleAttemptStartAutoScrollMT();
        // 兜底：开启 normalize watchdog（幂等），避免极端时序下某些行永远不触发 edge/threshold 导致卡边
        kickNormalizeWatchdogMT();
      })(locked).catch(() => {});
    },
    [
      autoScrollAttemptScheduledMTRef,
      autoScrollWaitStartedAtMsMTRef,
      debug,
      interactionLockedMTRef,
      kickNormalizeWatchdogMT,
      momentumRunningRef,
      refs,
      restoreScheduledRef,
      scheduleAttemptStartAutoScrollMT,
      stopNormalizeWatchdogMT,
      stopNativeAutoScrollMT,
    ],
  );

  /**
   * ready 前准备：把视口“无感地”迁移到 A/B 边界附近的安全区，避免解锁瞬间触发 normalize/edge 导致闪屏。
   *
   * 说明：
   * - 该函数应在 locked=true 阶段调用；
   * - 由于 locked=true 阶段不会发生任何滚动（无手势/无 autoScroll），每行都停在“段起点”的稳定状态；
   *   且 A/B 两段内容完全一致，因此可以直接把每行 scrollToPosition 到 B 段起点（blockLen），无需 getVisibleCells。
   * - 完成后通过 runOnBackground 通知 BG 进入 ready（由渲染层统一解除门控并开放交互）。
   */
  const prepareForReady = useCallback(
    (params?: { segCount?: 1 | 2 }) => {
      "background only";

      const segCount = (params?.segCount ?? 2) as 1 | 2;

      // 使用 BG 渲染期快照作为兜底：避免等待 `effects.ts` 镜像同步窗口导致 prepareForReady 误判为 noop。
      // 这对 bootstrap→padding 的切换尤其关键：如果我们过早放行 ready，解锁瞬间可能命中 threshold/edge 触发 normalize 跳变。
      const rowBaseLensSnapshot = rowBaseLens;
      const repeatByRowSnapshot = effectiveRepeatByRow;
      const blockLenByRowSnapshot = Array.from({ length: safeRows }, (_, row) => {
        const baseLen = Math.max(0, Math.floor(rowBaseLensSnapshot?.[row] ?? 0));
        if (baseLen <= 0) return 0;
        const repeatTimes = Math.max(1, Math.floor(repeatByRowSnapshot?.[row] ?? 1));
        return baseLen * repeatTimes;
      });

      runOnMainThread((blockLenByRowSnapshot: number[], segCount: 1 | 2) => {
        "main thread";
        const notify = onReadyPreparedBG ? runOnBackground(onReadyPreparedBG) : null;

        const currentEpoch = refs.autoScrollEpochMTRef.current;
        const lists = refs.listMTRefs.current;
        const rowEpochArr = refs.listEpochByRowMTRef.current;

        if (debug) {
          console.info("[DanmakuV2][MT] prepareForReady:start", {
            epoch: currentEpoch,
            rows: safeRows,
            segCount,
          });
        }

        // 仅在 A/B 双段结构下有意义；若调用时仍是单段（segCount=1），直接放行避免越界 scrollToPosition。
        if (segCount !== 2) {
          if (debug) {
            console.info("[DanmakuV2][MT] prepareForReady:skip", {
              epoch: currentEpoch,
              segCount,
            });
          }
          notify?.(currentEpoch);
          return;
        }

        // 兜底超时：避免极端情况下 invoke promise 不 resolve / 永远不可 invoke 导致 BG 永远等不到 ready
        const timeoutStart = nowMs();
        let finished = false;

        const pendingByRow = Array(safeRows).fill(false) as boolean[];
        const inFlightByRow = Array(safeRows).fill(false) as boolean[];
        let pendingCount = 0;
        for (let row = 0; row < safeRows; row++) {
          const blockLen = Math.max(0, Math.floor(blockLenByRowSnapshot[row] ?? 0));
          if (blockLen <= 0) continue;
          if ((rowEpochArr?.[row] ?? 0) !== currentEpoch) continue;
          if (!lists?.[row]) continue;
          pendingByRow[row] = true;
          pendingCount += 1;
        }

        if (pendingCount === 0) {
          if (debug) {
            console.info("[DanmakuV2][MT] prepareForReady:noop", {
              epoch: currentEpoch,
              segCount,
            });
          }
          notify?.(currentEpoch);
          return;
        }

        const tryFinish = (reason: "done" | "timeout") => {
          if (finished) return;
          finished = true;
          if (debug) {
            console.info("[DanmakuV2][MT] prepareForReady:done", {
              epoch: currentEpoch,
              reason,
              segCount,
              pendingCount,
            });
          }
          notify?.(currentEpoch);
        };

        const frame = () => {
          "main thread";
          if (finished) return;
          const elapsed = nowMs() - timeoutStart;
          if (elapsed >= 800) {
            tryFinish("timeout");
            return;
          }

          for (let row = 0; row < safeRows; row++) {
            if (!pendingByRow[row]) continue;
            if (inFlightByRow[row]) continue;

            // 行被 remount/解绑/换代：不再强行处理，交给后续门禁兜底
            if ((rowEpochArr?.[row] ?? 0) !== currentEpoch) {
              pendingByRow[row] = false;
              pendingCount -= 1;
              continue;
            }

            const el = lists?.[row];
            if (!el) continue;
            const blockLen = Math.max(0, Math.floor(blockLenByRowSnapshot[row] ?? 0));
            if (blockLen <= 0) {
              pendingByRow[row] = false;
              pendingCount -= 1;
              continue;
            }

            inFlightByRow[row] = true;
            try {
              invokeListMethod(
                el,
                "scrollToPosition",
                {
                  position: blockLen,
                  alignTo: "top",
                  offset: 0,
                  smooth: false,
                },
                {
                  onSuccess: () => {
                    if (finished) return;
                    if (pendingByRow[row]) {
                      pendingByRow[row] = false;
                      pendingCount -= 1;
                    }
                    if (pendingCount <= 0) {
                      tryFinish("done");
                    }
                    inFlightByRow[row] = false;
                  },
                  onError: () => {
                    // 失败：下一帧重试
                    inFlightByRow[row] = false;
                  },
                },
              );
            } catch {
              inFlightByRow[row] = false;
            }
          }

          requestAnimationFrame(frame);
        };

        requestAnimationFrame(frame);
      })(blockLenByRowSnapshot, segCount).catch(() => {});
    },
    [debug, effectiveRepeatByRow, onReadyPreparedBG, refs, rowBaseLens, safeRows],
  );

  /**
   * 估算某一行的 cell 宽度（通过 getVisibleCells）。
   *
   * 用途：repeat 子系统在 BG 侧决策时，避免依赖 layoutcomplete.scrollWidth（虚拟化早期可能是 partial）。
   */
  const measureRowCellPx = useCallback(
    (
      rowIndex: number,
      requestEpoch: number,
      onMeasuredBG: (payload: {
        epoch: number;
        rowIndex: number;
        ok: boolean;
        sampleCount: number;
        cellPxForWidth: number;
        cellPxForCount: number;
      }) => void,
    ) => {
      "background only";

      runOnMainThread((rowIndex: number, requestEpoch: number) => {
        "main thread";
        const notify = runOnBackground(onMeasuredBG);

        const currentEpoch = refs.autoScrollEpochMTRef.current;
        if (rowIndex < 0 || rowIndex >= safeRows) {
          notify({
            epoch: requestEpoch,
            rowIndex,
            ok: false,
            sampleCount: 0,
            cellPxForWidth: 0,
            cellPxForCount: 0,
          });
          return;
        }
        if (currentEpoch !== requestEpoch) {
          notify({
            epoch: requestEpoch,
            rowIndex,
            ok: false,
            sampleCount: 0,
            cellPxForWidth: 0,
            cellPxForCount: 0,
          });
          return;
        }

        const el = refs.listMTRefs.current?.[rowIndex] ?? null;
        if (!el) {
          notify({
            epoch: requestEpoch,
            rowIndex,
            ok: false,
            sampleCount: 0,
            cellPxForWidth: 0,
            cellPxForCount: 0,
          });
          return;
        }

        const rowEpoch = refs.listEpochByRowMTRef.current?.[rowIndex] ?? 0;
        if (rowEpoch !== currentEpoch) {
          notify({
            epoch: requestEpoch,
            rowIndex,
            ok: false,
            sampleCount: 0,
            cellPxForWidth: 0,
            cellPxForCount: 0,
          });
          return;
        }

        const finish = (ok: boolean, widths: number[]) => {
          // 宽度数据来自可见 cell：只需少量样本即可稳定，不追求“全量精确”。
          const cleaned: number[] = [];
          for (let i = 0; i < widths.length; i++) {
            const w = widths[i] ?? 0;
            if (!Number.isFinite(w) || w <= 0) continue;
            // 防御：极端异常值直接丢弃
            if (w > 10000) continue;
            cleaned.push(w);
          }
          if (!ok || cleaned.length === 0) {
            notify({
              epoch: requestEpoch,
              rowIndex,
              ok: false,
              sampleCount: 0,
              cellPxForWidth: 0,
              cellPxForCount: 0,
            });
            return;
          }

          cleaned.sort((a, b) => a - b);
          const lastIdx = cleaned.length - 1;
          const p20 = cleaned[Math.max(0, Math.floor(lastIdx * 0.2))] ?? 0;
          const median = cleaned[Math.max(0, Math.floor(lastIdx * 0.5))] ?? 0;

          if (debug) {
            console.info("[DanmakuV2][MT] measureRowCellPx", {
              epoch: requestEpoch,
              row: rowIndex,
              sampleCount: cleaned.length,
              cellPxForWidth: p20,
              cellPxForCount: median,
            });
          }

          notify({
            epoch: requestEpoch,
            rowIndex,
            ok: true,
            sampleCount: cleaned.length,
            cellPxForWidth: p20,
            cellPxForCount: median,
          });
        };

        try {
          const ret = el.invoke("getVisibleCells") as Promise<GetVisibleCellsResult>;
          ret
            .then((cells) => {
              // 1) 优先使用 right-left（更准确）
              const widths: number[] = [];
              const list = (cells as unknown as Array<{
                left?: number;
                right?: number;
              }>) ?? [];

              for (let i = 0; i < list.length; i++) {
                const left = list[i]?.left;
                const right = list[i]?.right;
                if (Number.isFinite(left) && Number.isFinite(right)) {
                  widths.push((right as number) - (left as number));
                }
              }

              // 2) 兜底：若缺少 right，可用相邻 left 差值估算（可能包含 gap，但对 repeat 决策足够）
              if (widths.length === 0 && list.length >= 2) {
                for (let i = 0; i < list.length - 1; i++) {
                  const left = list[i]?.left;
                  const nextLeft = list[i + 1]?.left;
                  if (Number.isFinite(left) && Number.isFinite(nextLeft)) {
                    widths.push((nextLeft as number) - (left as number));
                  }
                }
              }

              finish(true, widths);
            })
            .catch(() => {
              finish(false, []);
            });
        } catch {
          finish(false, []);
        }
      })(rowIndex, requestEpoch).catch(() => {});
    },
    [debug, refs, safeRows],
  );

  /**
   * 命令式开关：由 BG 调用，下发到 MT。
   *
   * 约束：
   * - enabled=true：仅“尝试启动”，实际是否能 start 仍受 ref/epoch/repeatStable/就绪探测等门禁约束。
   * - enabled=false：必须立即 stop，并清理所有会导致后续误恢复的挂起状态。
   */
  const setAutoScrollEnabled = useCallback(
    (enabled: boolean) => {
      "background only";
      // 注意：BG 侧只能下发“意图”，开关的唯一来源在主线程 autoScrollEnabledMTRef 中。
      // 这里用 runOnMainThread 把 enabled 写入主线程，并触发对应的启动/停止分支。
      runOnMainThread((nextEnabled: boolean) => {
        "main thread";
        autoScrollEnabledMTRef.current = nextEnabled;
        if (nextEnabled) {
          // 开启：只触发一次“尝试启动”调度。是否能真正启动由 autoScroll 子系统的门禁决定。
          scheduleAttemptStartAutoScrollMT();
          // 兜底：开启 normalize watchdog（幂等），避免极端时序下某些行永远不触发 edge/threshold 导致卡边
          kickNormalizeWatchdogMT();
          return;
        }
        /**
         * 关闭：必须做到“立刻停止 + 清理挂起态”。
         *
         * 为什么要清理挂起态：
         * - DanmakuV2 的 autoScroll 启动不是一次性动作，而是一个会 rAF 重试/探测的状态机。
         * - 如果只 stop 不清理，可能出现：
         *   - 关闭后仍被已调度的 rAF 轮询再次尝试 start（误恢复）
         *   - wait/probe 计时器保持历史值，导致后续开启时门禁判断异常（卡住或跳过探测）
         */
        stopNormalizeWatchdogMT();
        stopNativeAutoScrollMT();
        // normalize 恢复流程的调度标记（避免关闭后仍在 rAF 中等待锁释放并恢复）
        restoreScheduledRef.current = false;
        // 运行态的唯一来源标记：明确置 false，避免“逻辑上已关但状态机认为仍在滚动”
        autoScrollingMTRef.current = false;
        // 启动调度标记：清掉后续 rAF 重试
        autoScrollAttemptScheduledMTRef.current = false;
        // wait 计时：清零，避免下一轮开启时沿用历史 waitedMs
        autoScrollWaitStartedAtMsMTRef.current = 0;
      })(enabled).catch(() => {});
    },
    [
      autoScrollAttemptScheduledMTRef,
      autoScrollEnabledMTRef,
      autoScrollWaitStartedAtMsMTRef,
      autoScrollingMTRef,
      kickNormalizeWatchdogMT,
      restoreScheduledRef,
      scheduleAttemptStartAutoScrollMT,
      stopNormalizeWatchdogMT,
      stopNativeAutoScrollMT,
    ],
  );

  /**
   * 手势系统会在 touchstart 时 stop autoScroll，并在拖拽/惯性结束时：
   * - 先做一次 final normalize（收敛边界）
   * - 再按开关状态尝试恢复 autoScroll（restoreAutoScrollAfterNormalizeMT 内部会读开关）
   */
  const { onTouchStartMT, onTouchMoveMT, onTouchEndMT } = useDanmakuV2GestureSubsystem({
    refs,
    reportUserScrollBG,
    scrollAllListsMT,
    stopNativeAutoScrollMT,
    finalCheckAllRowsMT,
    restoreAutoScrollAfterNormalizeMT,
  });

  /**
   * 命令式惯性模式：由 BG 调用，下发到 MT。
   *
   * 说明：
   * - 模式保存在 `momentumModeMTRef`，主线程手势/惯性热点路径直接读取该 ref（避免闭包过期）。
   * - 若切到 'none' 且当前正在惯性中：立即停止惯性，并做一次收尾（final normalize + 尝试恢复 autoScroll）。
   */
  const setMomentumMode = useCallback(
    (mode: DanmakuV2MomentumMode) => {
      "background only";
      runOnMainThread((nextMode: DanmakuV2MomentumMode) => {
        "main thread";
        momentumModeMTRef.current = nextMode;

        if (nextMode !== "none") return;

        // 若正在惯性中：立刻停下，并做一次收尾，避免 autoScroll 因“惯性停止但未恢复”而停滞。
        if (momentumRunningRef.current) {
          momentumRunningRef.current = false;
          finalCheckAllRowsMT();
          restoreAutoScrollAfterNormalizeMT();
        }
      })(mode).catch(() => {});
    },
    [finalCheckAllRowsMT, momentumModeMTRef, momentumRunningRef, restoreAutoScrollAfterNormalizeMT],
  );

  /**
   * effects：同步代际与镜像数据（rowBaseLens/repeatByRow）到主线程。
   * 这些镜像数据会影响：
   * - autoScroll 是否允许启动（例如 baseLen=0 的行无需滚动）
   * - normalize 的 target/guard 计算
   */
  useDanmakuV2MainThreadEffects({
    safeRows,
    epoch,
    debug,
    rowBaseLens,
    effectiveRepeatByRow,
    refs,
    lastEpochSyncedToMTRef,
    scheduleAttemptStartAutoScrollMT,
  });

  /**
   * 对外返回的 controller：
   * - 上半部分：渲染层要绑定到 `<view>`/`<list>`/`<list-item>` 的主线程 handlers
   * - 下半部分：repeat 子系统需要透传的一组主线程 refs（用于 repeatStable gating）
   */
  return {
    setAutoScrollEnabled,
    setMomentumMode,
    setInteractionLocked,
    prepareForReady,
    measureRowCellPx,
    onTouchStartMT,
    onTouchMoveMT,
    onTouchEndMT,

    listMainThreadRefHandlers,
    createListLayoutCompleteMT,

    createScrollToUpperMT,
    createScrollToLowerMT,
    createScrollToUpperEdgeMT,
    createScrollToLowerEdgeMT,

    autoScrollEpochMTRef: refs.autoScrollEpochMTRef,
    repeatStableEpochByRowMTRef: refs.repeatStableEpochByRowMTRef,
    scheduleAttemptStartAutoScrollMT,
    finalCheckAllRowsMT,
    restoreAutoScrollAfterNormalizeMT,
  } satisfies DanmakuV2MainThreadController;
}
