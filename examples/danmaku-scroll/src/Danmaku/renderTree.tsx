import { memo, useCallback, useEffect, useMemo, useRef, useState } from "@lynx-js/react";

import { useDanmakuV2RowBaseLens, useDanmakuV2RowsData } from "./dataEpoch";
import { buildDanmakuV2DebugMetrics } from "./debugMetrics";
import { useDanmakuV2ExposureHandlers } from "./exposure";
import { useDanmakuV2MainThreadController } from "./mainThread/index";
import { nowMsBG } from "./mainThread/mainThreadMath";
import { type DanmakuV2FirstScreenPhase, publishDanmakuV2PhaseSnapshot } from "./phaseSignal";
import { useDanmakuV2RepeatController } from "./repeat";
import type { BlockNativeEventArea, DanmakuV2PerfMetrics, DanmakuV2RenderTreeProps, RowItem } from "./types";
import { useDanmakuV2UserScrollReporter } from "./userScroll";
import {
  clampInt,
  DEFAULT_BLOCK_NATIVE_EVENT_AREAS,
  normalizeRepeatByRowForRows,
  THRESHOLD_ITEM_COUNT_DEFAULT,
} from "./utils";

/**
 * 首屏拆分加载（padding → ready）的可靠性参数：
 * - PREPARE_FOR_READY_RETRY_INTERVAL_MS：同一 epoch 内触发 prepareForReady 的节流间隔（避免多处触发导致风暴）
 * - PADDING_PREPARE_WATCHDOG_MS：进入 padding 后的“补打一发 prepareForReady”的保底延迟
 * - PADDING_FORCE_READY_WATCHDOG_MS：极端情况下直接放行 ready 的最终兜底（避免交互永远锁死）
 */
const PREPARE_FOR_READY_RETRY_INTERVAL_MS = 300;
const PADDING_PREPARE_WATCHDOG_MS = 1000;
const PADDING_FORCE_READY_WATCHDOG_MS = 2500;

type DanmakuV2RowItemsProps<T> = {
  debug: boolean;
  epoch: number;
  rowIndex: number;
  rowItems: RowItem<T>[];
  repeatTimes: number;
  segCount: number;
  gapStyle: string;
  stableGetKey: (item: T) => string;
  renderItem: (item: T, index: number) => JSX.Element;
  tapHandlersForRow?: Array<(() => void) | undefined>;
};

function DanmakuV2RowItemsImpl<T>(props: DanmakuV2RowItemsProps<T>) {
  const {
    debug,
    epoch,
    rowIndex,
    rowItems,
    repeatTimes,
    segCount,
    gapStyle,
    stableGetKey,
    renderItem,
    tapHandlersForRow,
  } = props;

  if (debug) {
    console.info("[DanmakuV2][Memo] row-items-render", {
      epoch,
      rowIndex,
      baseLen: rowItems.length,
      repeatTimes,
      segCount,
    });
  }

  return (
    <>
      {Array.from({ length: segCount }).map((_, seg) =>
        Array.from({ length: repeatTimes }).map((_, rep) =>
          rowItems.map(({ item, localIndex }, idx) => {
            const baseKey = stableGetKey(item) || String(localIndex);
            const uniq = `${baseKey}-${localIndex}-${idx}`;
            const itemKey = `${uniq}-${seg ? "b" : "a"}-${rep}`;
            return (
              <list-item key={itemKey} item-key={itemKey}>
                <view style={{ marginRight: gapStyle }} bindtap={tapHandlersForRow?.[idx]}>
                  {renderItem(item, idx)}
                </view>
              </list-item>
            );
          })
        )
      )}
    </>
  );
}

const DanmakuV2RowItems = memo(DanmakuV2RowItemsImpl) as unknown as typeof DanmakuV2RowItemsImpl;

/**
 * DanmakuV2RenderTree（渲染子树）
 *
 * ## 职责
 * 该文件承载 DanmakuV2 的“高成本渲染子树 + 线程编排”：
 * - **数据编排（BG）**：根据 items/rows 计算 epoch（dataEpoch）、rowsData、rowBaseLens。
 * - **repeat 收敛（BG→MT）**：通过 `<list bindlayoutcomplete>` 的 scrollInfo 评估是否需要提升 repeat，
 *   并把每行 `stableEpoch` 同步到主线程作为 autoScroll 启动门禁（避免“先滚一下再重建”）。
 * - **主线程控制器（MT）**：生成所有 `main-thread:*` 绑定所需的 handlers/refs（手势/惯性/normalize/autoScroll 等）。
 * - **渲染模板（UI）**：每行一个 `<list>`，内部渲染 A/B 双段，并按 repeatTimes 扩展 `<list-item>`。
 * - **可选能力（BG）**：曝光监听、debug 指标上报。
 *
 * ## 性能约束（非常重要）
 * - `<list-item>` 的数量可能很大（items * repeat * 2 段），commit 阶段会放大 `main-thread:*` 等属性/事件写入成本。
 * - 因此本文件应尽量只在“数据语义/布局语义”变化时参与更新。
 * - 渲染循环中 **禁止** per-item inline handler（尤其 `main-thread:*`），必须复用主线程控制器预生成的 handler 引用。
 *
 * ## 数据流（从 props 到 UI）
 * 1) props(items/rows/布局参数/回调) → `safeRows`（行数裁剪）→ `epoch(dataEpoch)`（语义代际，用于各子系统重置）
 * 2) items → `rowsData`（轮询分配到多行）→ `rowBaseLens`（每行 baseLen）
 * 3) `repeatByRow`（state）→ `effectiveRepeatByRow`（长度归一化）：
 *    - BG layoutcomplete 评估需要提升 repeat 时更新 state
 *    - repeatTimes 参与 listId，保证“repeat 提升”会触发行 `<list>` remount
 * 4) `useDanmakuV2MainThreadController` 输出 MT handlers/refs → 绑定到 `<view>`/`<list>`/`<list-item>`
 * 5) 输出 UI：外层 `<view>` + 每行 `<list>`（A/B 双段 + repeatTimes 扩展 `<list-item>`）并绑定 BG/MT 事件
 */

/**
 * DanmakuV2RenderTreeImpl：渲染子树的具体实现。
 *
 * 说明：该组件会创建大量 `<list-item>`，因此应尽量避免在“仅开关变化”的场景下触发它的 rerender。
 */
function DanmakuV2RenderTreeImpl<T>(props: DanmakuV2RenderTreeProps<T>) {
  const {
    dataEpoch,
    items,
    rows,
    rowGapPx = 12,
    itemGapPx = 12,
    blockNativeEventAreas,
    rowHeightPx,
    rowOffsetPx = 50,
    debug = false,
    renderItem,
    getItemKey,
    onItemClick,
    onUserScroll,
    onItemExpose,
    onDebugMetricsChange,
    initialAutoScroll,
    initialMomentumMode,
    bindAutoScrollControl,
    bindMomentumModeControl,
    screenInfo,
    firstScreenOptimize,
    isFeatured,
    normalizeWatchdogSweepMs,
    perfMetrics,
  } = props;

  const safeRows = clampInt(rows, 1, 999);
  const effectiveBlockNativeEventAreas: BlockNativeEventArea[] = blockNativeEventAreas
    ?? DEFAULT_BLOCK_NATIVE_EVENT_AREAS;

  /**
   * epoch：数据代际号（来自业务侧 `dataEpoch`）。
   *
   * 用途：
   * - 当 items/rows 的“语义”发生变化时，推进一代，驱动子系统重置（repeat/曝光去重/主线程代际等）。
   *
   * 约束（由业务侧保证）：
   * - 只要 items 的 key 序列（length/顺序/任一 key）变化或 rows 变化，就必须推进 dataEpoch；
   * - 这样 DanmakuV2 内部无需做 hash/采样 signature，就能获得严格语义且高性能的代际信号。
   */
  const epoch = Math.max(0, Math.floor(dataEpoch || 0));

  // ===== 首屏拆分加载（bootstrap → padding → ready）=====
  type Phase = DanmakuV2FirstScreenPhase;

  const firstScreenEnabled = firstScreenOptimize?.enabled ?? true;
  const estimatedCellPx = Math.max(1, Math.floor(firstScreenOptimize?.estimatedCellPx ?? 150));
  const bufferItemsPerRow = Math.max(0, Math.floor(firstScreenOptimize?.bufferItemsPerRow ?? 2));
  const minItemsPerRow = Math.max(0, Math.floor(firstScreenOptimize?.minItemsPerRow ?? 4));

  const [phase, setPhase] = useState<Phase>(() => (firstScreenEnabled ? "bootstrap" : "ready"));
  // 防止 watchdog/异步回调读取到旧闭包 epoch：用 ref 保存"最新 epoch"
  const epochRef = useRef<number>(epoch);
  const phaseRef = useRef<Phase>(phase);
  const itemsLenRef = useRef<number>(items.length);
  const lastPhaseRef = useRef<Phase>(phase);
  // prepareForReady 的"节流状态"（同一 epoch 内最多每隔一段时间触发一次）
  const lastPrepareForReadyAtMsRef = useRef<number>(0);
  const lastPrepareForReadyEpochRef = useRef<number | null>(null);
  // 记录是否已完成首次首屏流程：首次走 bootstrap→padding→ready，后续切换直接 ready
  const hasCompletedFirstScreenRef = useRef<boolean>(!firstScreenEnabled);

  // ===== 逐行淡入+位移动画（CSS animation）=====
  // 每次 epoch 变化（首屏完成后）递增，用于触发行入场动画
  const [animEpoch, setAnimEpoch] = useState(epoch);
  const [animTrigger, setAnimTrigger] = useState(0);

  // 同步检测 epoch 变化（相当于 getDerivedStateFromProps）
  if (epoch !== animEpoch) {
    setAnimEpoch(epoch);
    if (hasCompletedFirstScreenRef.current) {
      setAnimTrigger((prev) => prev + 1);
    }
  }

  // ===== 性能打点状态 =====
  const perfMetricsRef = useRef<DanmakuV2PerfMetrics | undefined>(perfMetrics);
  const perfReportedRef = useRef<boolean>(false);
  perfMetricsRef.current = perfMetrics;

  // 用 ref 保存“最新 phase”，用于过滤迟到的异步回调（避免错误回退/错误放行）。
  // 注意：这里需要在 render 同步写入，不能依赖 useEffect（可能在事件/回调之前尚未执行）。
  phaseRef.current = phase;
  epochRef.current = epoch;
  itemsLenRef.current = items.length;

  // 对外发布 phase 变化（订阅模式，不触发 React 渲染）
  useEffect(() => {
    if (debug) console.log(">>>>>>>phase change", phase);
    publishDanmakuV2PhaseSnapshot({ phase });
    // 首次进入 ready 后标记已完成首屏流程，后续 epoch 变化直接跳到 ready
    if (phase === "ready") {
      hasCompletedFirstScreenRef.current = true;
    }
  }, [debug, phase]);

  // epoch/rows 变化：重置 phase
  // 优化：首次挂载走 bootstrap→padding→ready，后续数据切换直接 ready（列表已挂载，无需再走三阶段）
  useEffect(() => {
    if (hasCompletedFirstScreenRef.current) {
      setPhase("ready");
      // 跳过三阶段时，直接记录 bootstrapTime 和 readyTime
      const currentPerf = perfMetricsRef.current;
      if (currentPerf?.clickTimestamp && !currentPerf.bootstrapTime) {
        const now = Date.now();
        currentPerf.bootstrapTime = now;
        currentPerf.readyTime = now;
        console.info(
          `[DanmakuV2][Perf] 跳过三阶段直接ready deltaFromClick=${now - currentPerf.clickTimestamp}ms`,
        );
      }
    } else {
      setPhase(firstScreenEnabled ? "bootstrap" : "ready");
    }
    // 新数据代际：重置性能打点上报状态
    perfReportedRef.current = false;
  }, [epoch, firstScreenEnabled, safeRows]);

  // 外部显式关闭首屏优化：立即回到 ready（避免门控被卡住）
  useEffect(() => {
    if (!firstScreenEnabled) setPhase("ready");
  }, [firstScreenEnabled]);

  // 首屏 commit 后立刻进入 padding（只对当前 epoch 生效一次）
  const autoPaddedEpochRef = useRef<number | null>(null);
  useEffect(() => {
    if (!firstScreenEnabled) return;
    if (phase !== "bootstrap") return;
    // 空数据阶段不推进 padding：否则会制造“padding(空) → (数据到) → bootstrap(新 epoch)”的时序窗口，
    // 在少数机型上表现为多一次渲染/重建。
    if (items.length <= 0) return;
    if (autoPaddedEpochRef.current === epoch) return;
    autoPaddedEpochRef.current = epoch;
    const scheduledEpoch = epoch;
    requestAnimationFrame(() => {
      // 绑定 epoch：避免旧 epoch 的 rAF 迟到落到新代际，导致 phase 乱序。
      if (epochRef.current !== scheduledEpoch) return;
      // 若在 rAF 前已被其它逻辑推进/重置 phase，则不再强行推进。
      if (phaseRef.current !== "bootstrap") return;
      // 兜底：rAF 执行时若数据又变回空，也不推进。
      if (itemsLenRef.current <= 0) return;
      // 只允许 bootstrap → padding，避免 rAF 迟到把 ready 覆盖回 padding（会导致卡死在 padding）。
      setPhase((prev) => {
        if (prev === "bootstrap") {
          // 记录 bootstrap → padding 时间点
          const currentPerf = perfMetricsRef.current;
          if (currentPerf && !currentPerf.bootstrapTime) {
            currentPerf.bootstrapTime = Date.now();
            console.info(
              `[DanmakuV2][Perf] bootstrap→padding epoch=${scheduledEpoch} deltaFromClick=${
                currentPerf.bootstrapTime - currentPerf.clickTimestamp
              }ms`,
            );
          }
          return "padding";
        }
        return prev;
      });
    });
  }, [epoch, firstScreenEnabled, items.length, phase, debug]);

  const screenWidthPx = useMemo(() => {
    const w = screenInfo?.screenWidth ?? SystemInfo.pixelWidth / SystemInfo.pixelRatio;
    return Math.max(0, Number(w) || 0);
  }, [screenInfo]);

  const bootstrapCap = useMemo(() => {
    if (!firstScreenEnabled) return items.length;
    if (phase !== "bootstrap") return items.length;

    const perRow = Math.max(1, Math.ceil(screenWidthPx / estimatedCellPx));
    const minTotal = minItemsPerRow * safeRows;
    const bufferedTotal = (perRow + bufferItemsPerRow) * safeRows;
    const cap = Math.max(minTotal, bufferedTotal);
    return Math.min(items.length, cap);
  }, [
    bufferItemsPerRow,
    estimatedCellPx,
    firstScreenEnabled,
    items.length,
    minItemsPerRow,
    phase,
    safeRows,
    screenWidthPx,
  ]);

  useEffect(() => {
    if (!debug) return;
    if (!firstScreenEnabled) return;
    if (lastPhaseRef.current === phase) return;
    const prev = lastPhaseRef.current;
    lastPhaseRef.current = phase;
    console.info("[DanmakuV2][FirstScreen] phase", {
      epoch,
      from: prev,
      to: phase,
      rows: safeRows,
      fullItems: items.length,
      bootstrapCap: phase === "bootstrap" ? bootstrapCap : undefined,
      estimatedCellPx,
      bufferItemsPerRow,
      minItemsPerRow,
      screenWidthPx,
    });
  }, [
    bootstrapCap,
    bufferItemsPerRow,
    debug,
    epoch,
    estimatedCellPx,
    firstScreenEnabled,
    items.length,
    minItemsPerRow,
    phase,
    safeRows,
    screenWidthPx,
  ]);

  const itemsForRender = useMemo(() => {
    if (!firstScreenEnabled) return items;
    if (phase !== "bootstrap") return items;
    return items.slice(0, bootstrapCap);
  }, [bootstrapCap, firstScreenEnabled, items, phase]);

  /**
   * rowsData：把 items 轮询分配到多行后的二维数组。
   * rowBaseLens：每行 baseLen（repeat 前的 item 数）。
   */
  const rowsData = useDanmakuV2RowsData<T>({ items: itemsForRender, safeRows, isFeatured });
  const rowBaseLens = useDanmakuV2RowBaseLens<T>(rowsData);

  /**
   * stableGetKey：用于曝光去重等逻辑的稳定 key。
   *
   * 注意：外层已保证 getItemKey 的函数引用稳定（wrapper + latest），因此这里无需做额外“冻结”。
   */
  const stableGetKey = useCallback((item: T) => (getItemKey ? getItemKey(item) : ""), [getItemKey]);

  const [repeatByRow, setRepeatByRow] = useState<number[]>(() => Array(safeRows).fill(1));

  // 关键：safeRows 变化时，repeatByRow state 会短暂出现 length 不一致。
  // 为保证渲染与 BG repeat 决策一致，这里使用归一化后的 repeatByRow（裁剪/补齐、保留已有值）。
  const effectiveRepeatByRow = useMemo(() => {
    return normalizeRepeatByRowForRows(repeatByRow, safeRows);
  }, [repeatByRow, safeRows]);

  /**
   * 重要：
   * - repeat 变化会导致某一行 list 重建，但 **epoch 不应推进**（它属于同一代内的实例替换）；
   * - 主线程会用 epoch 来屏蔽迟到事件、避免跨代污染状态。
   */

  // ===== BG：用户滚动上报 / 曝光 =====
  // 注意：这两者都属于“业务回调”，不应在主线程 worklet 中直接读取 props（避免闭包/序列化问题）。
  const reportUserScrollBG = useDanmakuV2UserScrollReporter(onUserScroll);

  /**
   * BG：点击/tap 相关（迁移自 main-thread per-item catchtouchend）
   *
   * 设计：
   * - 使用 `bindtap`（引擎已做“点击语义”判定），避免绑定 `main-thread:*` 到大量 `<list-item>`
   */
  const itemTapHandlersByRow = useMemo(() => {
    const handlers: Array<Array<(() => void) | undefined>> = Array.from(
      { length: safeRows },
      () => [],
    );
    if (!onItemClick) return handlers;

    for (let rowIndex = 0; rowIndex < safeRows; rowIndex++) {
      const baseLen = (rowsData[rowIndex] ?? []).length;
      if (baseLen <= 0) {
        handlers[rowIndex] = [];
        continue;
      }
      handlers[rowIndex] = Array.from({ length: baseLen }, (_, idx) => {
        const handler = () => {
          "background only";
          const rowItems = rowsData[rowIndex] ?? [];
          if (idx < 0 || idx >= rowItems.length) return;
          onItemClick(rowItems[idx]!.item, idx, rowIndex);
        };
        return handler;
      });
    }

    return handlers;
  }, [onItemClick, rowsData, safeRows]);

  const listScrollExposureHandlers = useDanmakuV2ExposureHandlers<T>({
    safeRows,
    epoch,
    rowsData,
    stableGetKey,
    onItemExpose,
  });

  const onReadyPreparedBG = useCallback(
    (preparedEpoch: number) => {
      "background only";
      if (debug && firstScreenEnabled) {
        console.info("[DanmakuV2][FirstScreen] onReadyPreparedBG", {
          preparedEpoch,
          epoch,
          phase: phaseRef.current,
        });
      }
      if (preparedEpoch !== epoch || phaseRef.current !== "padding") {
        if (debug && firstScreenEnabled) {
          console.warn("[DanmakuV2][FirstScreen] onReadyPreparedBG:drop", {
            preparedEpoch,
            epoch,
            phase: phaseRef.current,
          });
        }
        return;
      }
      if (debug && firstScreenEnabled) {
        console.info("[DanmakuV2][FirstScreen] ready-prepared", {
          epoch: preparedEpoch,
        });
      }
      // 记录 padding → ready 时间点
      const currentPerf = perfMetricsRef.current;
      if (currentPerf && !currentPerf.readyTime) {
        currentPerf.readyTime = Date.now();
        console.info(
          `[DanmakuV2][Perf] padding→ready epoch=${preparedEpoch} deltaFromClick=${
            currentPerf.readyTime - currentPerf.clickTimestamp
          }ms`,
        );
      }
      setPhase("ready");
    },
    [epoch, firstScreenEnabled],
  );

  /**
   * 主线程控制器：
   * - 产出所有需要绑定到模板的 main-thread handlers（ref、touch、layoutcomplete、threshold/edge、per-item click）
   * - 管理主线程 refs 与状态机（autoScroll、normalize、手势/惯性）
   */
  const mt = useDanmakuV2MainThreadController({
    safeRows,
    epoch,
    debug,
    initialAutoScroll,
    initialMomentumMode,
    rowBaseLens,
    effectiveRepeatByRow,
    normalizeWatchdogSweepMs,
    reportUserScrollBG,
    initialInteractionLocked: phase !== "ready",
    onReadyPreparedBG,
    perfMetricsRef,
  });

  /**
   * 将主线程的“开关命令函数”暴露给外层。
   *
   * 外层会把 props(autoScroll) 的变化转换成命令调用，从而避免让 `<list>` 子树参与一次昂贵的 UI 提交。
   */
  useEffect(() => {
    bindAutoScrollControl?.(mt.setAutoScrollEnabled);
  }, [bindAutoScrollControl, mt.setAutoScrollEnabled]);

  useEffect(() => {
    bindMomentumModeControl?.(mt.setMomentumMode);
  }, [bindMomentumModeControl, mt.setMomentumMode]);

  const {
    setInteractionLocked,
    prepareForReady,
    onTouchStartMT,
    onTouchMoveMT,
    onTouchEndMT,
    listMainThreadRefHandlers,
    createListLayoutCompleteMT,
    createScrollToUpperMT,
    createScrollToLowerMT,
    createScrollToUpperEdgeMT,
    createScrollToLowerEdgeMT,
  } = mt;

  // 非 ready 阶段：严格锁定主线程操作（gesture/normalize/autoScroll/probe），ready 后再解除。
  useEffect(() => {
    setInteractionLocked(phase !== "ready");
  }, [phase, setInteractionLocked]);

  /**
   * padding 阶段兜底：
   * - 目标：避免偶发时序导致 `prepareForReady` 没有真正执行/回调，从而交互永远锁死在 padding。
   * - 策略：
   *   1) padding 一段时间后补打一发 prepareForReady（带节流）
   *   2) 更长时间后仍未 ready 则直接放行 ready（最终兜底）
   */
  useEffect(() => {
    if (!firstScreenEnabled) return;
    if (phase !== "padding") return;
    const capturedEpoch = epoch;

    const prepareTimer = setTimeout(() => {
      if (epochRef.current !== capturedEpoch) return;
      if (phaseRef.current !== "padding") return;
      const now = nowMsBG();
      if (
        lastPrepareForReadyEpochRef.current !== capturedEpoch
        || now - (lastPrepareForReadyAtMsRef.current || 0) >= PREPARE_FOR_READY_RETRY_INTERVAL_MS
      ) {
        lastPrepareForReadyEpochRef.current = capturedEpoch;
        lastPrepareForReadyAtMsRef.current = now;
        if (debug) {
          console.warn("[DanmakuV2][FirstScreen] padding-watchdog:prepare", {
            epoch: capturedEpoch,
          });
        }
        prepareForReady({ segCount: 2 });
      }
    }, PADDING_PREPARE_WATCHDOG_MS);

    const forceReadyTimer = setTimeout(() => {
      if (epochRef.current !== capturedEpoch) return;
      if (phaseRef.current !== "padding") return;
      if (debug) {
        console.warn("[DanmakuV2][FirstScreen] padding-watchdog:force-ready", {
          epoch: capturedEpoch,
        });
      }
      setPhase("ready");
    }, PADDING_FORCE_READY_WATCHDOG_MS);

    return () => {
      clearTimeout(prepareTimer);
      clearTimeout(forceReadyTimer);
    };
  }, [debug, epoch, firstScreenEnabled, phase, prepareForReady]);

  const onAllRowsStable = useCallback(
    (stableEpoch: number) => {
      "background only";
      if (debug && firstScreenEnabled) {
        console.info("[DanmakuV2][FirstScreen] onAllRowsStable", {
          stableEpoch,
          epoch,
          phase,
          phaseRef: phaseRef.current,
        });
      }
      // 只在 padding 阶段触发 ready-prep；bootstrap 不进行 repeat 检测。
      if (stableEpoch !== epoch || phase !== "padding") {
        if (debug && firstScreenEnabled) {
          console.warn("[DanmakuV2][FirstScreen] onAllRowsStable:drop", {
            stableEpoch,
            epoch,
            phase,
            phaseRef: phaseRef.current,
          });
        }
        return;
      }
      if (debug && firstScreenEnabled) {
        console.info("[DanmakuV2][FirstScreen] repeat-all-stable", {
          epoch: stableEpoch,
        });
      }
      const now = nowMsBG();
      if (lastPrepareForReadyEpochRef.current !== epoch) {
        lastPrepareForReadyEpochRef.current = epoch;
        lastPrepareForReadyAtMsRef.current = 0;
      }
      if (now - (lastPrepareForReadyAtMsRef.current || 0) < PREPARE_FOR_READY_RETRY_INTERVAL_MS) {
        if (debug && firstScreenEnabled) {
          console.info("[DanmakuV2][FirstScreen] prepareForReady:throttled", {
            epoch,
          });
        }
        return;
      }
      lastPrepareForReadyAtMsRef.current = now;
      prepareForReady({ segCount: 2 });
    },
    [debug, epoch, firstScreenEnabled, phase, prepareForReady],
  );

  /**
   * repeat 子系统：
   * - BG：通过 bindlayoutcomplete 的 scrollInfo 评估内容宽度与阈值稳定性，决定是否提升 repeat
   * - MT：只读取每行 stableEpoch 作为 autoScroll 启动门禁，避免“先滚一下再重建”造成闪动
   */
  const { createLayoutCompleteHandler, resetRepeatState, forceSyncRepeatStableEpochToMT } =
    useDanmakuV2RepeatController({
      safeRows,
      rowOffsetPx,
      epoch,
      debug,
      rowsData,
      repeatByRow: effectiveRepeatByRow,
      setRepeatByRow,
      autoScrollEpochMTRef: mt.autoScrollEpochMTRef,
      repeatStableEpochByRowMTRef: mt.repeatStableEpochByRowMTRef,
      scheduleAttemptStartAutoScrollMT: mt.scheduleAttemptStartAutoScrollMT,
      measureRowCellPx: mt.measureRowCellPx,
      avgCellPxFallback: estimatedCellPx,
      // 仅在 padding 阶段才需要“全部行稳定”信号；bootstrap 阶段不要提前触发（避免被按 epoch 去重后卡住）
      onAllRowsStable: phase === "padding" ? onAllRowsStable : undefined,
    });

  // ready 后强制对齐一次 repeatStableEpoch 到主线程：避免偶现 BG→MT 同步丢失导致 autoScroll 永远 wait-repeat-stable。
  // 注意：无论 firstScreenEnabled 是否开启都需要执行，否则关闭首屏优化时缺少兜底同步路径。
  useEffect(() => {
    if (phase !== "ready") return;
    forceSyncRepeatStableEpochToMT?.();
  }, [phase, forceSyncRepeatStableEpochToMT]);

  /**
   * 当数据语义变化（epoch）或行数变化（safeRows）时，重置 repeat 子系统状态。
   *
   * 注意：repeatByRow 是逐步收敛的状态；重置可避免旧状态污染新数据。
   */
  useEffect(() => {
    resetRepeatState();
    setRepeatByRow((prev) => {
      return normalizeRepeatByRowForRows(prev, safeRows);
    });
  }, [epoch, resetRepeatState, safeRows]);

  /**
   * debug 指标上报（低频）：
   * 仅在数据/布局评估结果变化时更新，避免在滚动高频路径产生额外开销。
   */
  useEffect(() => {
    if (!onDebugMetricsChange) return;
    onDebugMetricsChange(
      buildDanmakuV2DebugMetrics({
        rows: safeRows,
        itemsLength: items.length,
        epoch,
        baseLenByRow: rowBaseLens,
        repeatByRow: effectiveRepeatByRow,
      }),
    );
  }, [epoch, items.length, onDebugMetricsChange, effectiveRepeatByRow, rowBaseLens, safeRows]);

  // ===== 渲染：外层容器负责统一触摸拦截与手势事件，下层 list 负责滚动与虚拟化 =====
  const totalHeight = safeRows * rowHeightPx + (safeRows - 1) * rowGapPx;
  const gapStyle = itemGapPx > 0 ? `${itemGapPx}px` : "0px";
  const screenWidthNum = screenInfo?.screenWidth
    ? Math.round(screenInfo.screenWidth)
    : Math.round(SystemInfo.pixelWidth / SystemInfo.pixelRatio);
  const screenWidth = `${screenWidthNum}px`;
  const segCount = phase === "bootstrap" ? 1 : 2;
  // 最小修复：repeat 检测只允许在 padding/ready 阶段进行，避免 bootstrap 阶段提前提升 repeatByRow
  // （bootstrap 阶段渲染强制 repeatTimes=1，若提前提升会在 padding 时“突然生效”导致错位）
  const repeatEnabled = phase !== "bootstrap";

  if (debug) {
    console.log(">>>>>>screenWidth", screenWidth);
    console.log(">>>>>>screenInfo", screenInfo);
    console.log(">>>>>SystemInfo", SystemInfo);
    console.log(">>>>>>>rowsData", rowsData);
    console.log(">>>>>>effectiveRepeatByRow", effectiveRepeatByRow);
  }
  // TODO: 考虑是否只在 Dev 环境设置
  const timingFlag = useMemo(() => {
    return `DanmakuV2-${phase}`;
  }, [phase]);

  return (
    <view
      __lynx_timing_flag={timingFlag}
      className="DanmakuV2"
      style={{ height: `${totalHeight}px`, position: "relative" }}
      block-native-event-areas={effectiveBlockNativeEventAreas}
      main-thread:bindtouchstart={onTouchStartMT}
      main-thread:bindtouchmove={onTouchMoveMT}
      // MT：使用 capture 兜底，保证即使子节点 catch* 拦截冒泡也能收到 touchend/cancel 做收尾
      main-thread:capture-bindtouchend={onTouchEndMT}
      main-thread:capture-bindtouchcancel={onTouchEndMT}
      main-thread:bindtouchend={onTouchEndMT}
      main-thread:bindtouchcancel={onTouchEndMT}
    >
      {
        /*
        渲染模板要点：
        - **listId**：`epoch + rowIndex + repeatTimes`。
          - epoch：数据语义变化时推进，避免旧状态污染
          - repeatTimes：repeat 提升时触发行 `<list>` remount，让内部长度/虚拟化状态与新的 repeat 对齐
        - **initialIndex**：`blockLen`（B 段的起点）。这样首帧就处于 A/B 交界处，便于形成“无缝循环”的视觉效果。
        - **handler 绑定约束**：`main-thread:*`（尤其 per-item `catchtouchend`）必须直接引用预生成 handler，
          不要写成 `(e) => ...` 这种 inline closure，否则会在大列表下显著放大开销。
      */
      }

      {rowsData.map((rowItems, rowIndex) => {
        const marginTop = rowIndex === 0 ? "0px" : `${rowGapPx}px`;
        const repeatTimes = phase === "bootstrap" ? 1 : (effectiveRepeatByRow[rowIndex] ?? 1);
        const baseLen = rowItems.length;
        const listId = `z-main-danmaku-row-${rowIndex}-rep-${repeatTimes}`;

        // 空行：不渲染 list，避免无意义的 invoke/事件
        if (baseLen <= 0) {
          return <view key={listId} style={{ width: "100vw", height: `${rowHeightPx}px`, marginTop }} />;
        }

        // 逐行淡入+位移动画：CSS animation 从挂载时自动播放，无需 rAF 等待
        // animTrigger > 0 时应用入场动画，每行延迟 rowIndex * 100ms
        // 为了让 translateX 位移过程中左侧不露出空白，让 wrapper 向左延伸 80px、
        // list 相应加宽 80px；外层 .DanmakuV2 通过 overflow: hidden 裁掉超出部分。
        const rowEnterOffsetPx = 40;
        const animEnabled = animTrigger > 0;
        const rowAnimStyle = animEnabled
          ? {
            animation: `danmakuRowEnter 0.4s ease-out ${rowIndex * 100}ms both`,
            marginLeft: `-${rowEnterOffsetPx}px`,
          }
          : {};
        const listWidth = animEnabled ? `${screenWidthNum + rowEnterOffsetPx}px` : screenWidth;

        return (
          <view key={`${listId}-a${animTrigger}`} style={rowAnimStyle}>
            <list
              id={listId}
              data-row={rowIndex}
              data-base-len={baseLen}
              data-repeat-times={repeatTimes}
              main-thread:ref={listMainThreadRefHandlers[rowIndex]}
              custom-list-name="list-container"
              scroll-orientation="horizontal"
              list-type="single"
              span-count={1}
              enable-scroll={false}
              bounces={false}
              scroll-bar-enable={false}
              need-layout-complete-info={true}
              need-visible-item-info={true}
              scroll-event-throttle={16}
              upper-threshold-item-count={THRESHOLD_ITEM_COUNT_DEFAULT}
              lower-threshold-item-count={THRESHOLD_ITEM_COUNT_DEFAULT}
              style={{
                width: listWidth,
                height: `${rowHeightPx}px`,
                marginTop,
              }}
              bindlayoutcomplete={repeatEnabled ? createLayoutCompleteHandler(rowIndex) : undefined}
              bindscroll={listScrollExposureHandlers[rowIndex]}
              main-thread:bindlayoutcomplete={createListLayoutCompleteMT(
                rowIndex,
                baseLen,
                repeatTimes,
              )}
              main-thread:bindscrolltoupper={createScrollToUpperMT(rowIndex)}
              main-thread:bindscrolltolower={createScrollToLowerMT(rowIndex)}
              main-thread:bindscrolltoupperedge={createScrollToUpperEdgeMT(rowIndex)}
              main-thread:bindscrolltoloweredge={createScrollToLowerEdgeMT(rowIndex)}
            >
              {
                /*
                A/B 双段 + repeat：
                - 外层 `[0,1]` 表示 A 段与 B 段
                - 中层 repeatTimes 用于把"单段内容"重复扩展到足够长，保证可滚动空间与 threshold/edge 的稳定性
                - 内层 rowItems 渲染具体 item（`idx` 是该行的"逻辑 index"，用于主线程点击/曝光/触摸处理的索引对齐）
              */
              }
              <DanmakuV2RowItems
                debug={debug}
                epoch={epoch}
                rowIndex={rowIndex}
                rowItems={rowItems}
                repeatTimes={repeatTimes}
                segCount={segCount}
                gapStyle={gapStyle}
                stableGetKey={stableGetKey}
                renderItem={renderItem}
                tapHandlersForRow={itemTapHandlersByRow[rowIndex]}
              />
            </list>
          </view>
        );
      })}
    </view>
  );
}

export const DanmakuV2RenderTree = memo(
  DanmakuV2RenderTreeImpl,
) as unknown as typeof DanmakuV2RenderTreeImpl;
