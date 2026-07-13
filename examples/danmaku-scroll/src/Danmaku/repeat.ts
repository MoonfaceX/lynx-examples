/**
 * DanmakuV2 - repeat 子系统（关键数据流/线程模型说明）
 *
 * ## 背景
 * DanmakuV2 的 List 是 `enable-scroll={false}`：
 * - 手动滚动：外层 touch 事件在主线程 `scrollBy` 推动 list
 * - 自动滚动：主线程 invoke('autoScroll')
 *
 * 如果每行内容宽度不足以产生可滚动空间（scroll range = 0），无论 autoScroll 还是手动 scrollBy 都会“滚不动”。
 * 因此需要对每行 items 做 repeat（把 A 段 + B 段重复扩展），保证：
 * - **宽度足够**：单段宽度 >= requiredSeg（至少 1.5 屏 ）
 * - **数量足够**：blockLen 足够大，让 threshold/edge 不会长期命中，从源头降低 normalize 的高频触发
 *
 * ## 数据流（BG/MT）
 * 1. BG（background）收到每行 `<list bindlayoutcomplete>`，从 `scrollInfo` 读取 `listWidth/scrollWidth`。
 * 2. 用 `scrollWidth` 推导 repeat：
 *    - 这里的 `scrollWidth` 是 **整条 list 内容宽度**（包含 A 段 + B 段，因此单段宽度约为 `scrollWidth/2`）
 *    - 由于当前 list 可能已经处于 repeat>1 的状态，还需要再除以 `currentRepeat`，还原出 “repeat=1 的单段宽度”
 * 3. BG 决策后：
 *    - 需要提升 repeat：setRepeatByRow → 触发该行 list 重建（key/id 含 repeat）
 *      - epoch 不会因为 repeat 变化而推进（epoch 仅在数据语义/行数变化时推进）
 *      - BG 会在同一 epoch 内等待新实例的 layoutcomplete，再确认该行是否“已repeat ready”
 *    - 无需提升：该行视为已repeat ready
 * 4. BG 把“ready状态”同步到主线程，作为 autoScroll 启动门禁（每行一个 stableEpoch）：
 *    - stableEpoch === epoch：该行 repeat 已ready
 *    - stableEpoch === -1：该行 repeat 尚未ready（例如刚提升、或仍需继续提升）
 *
 * ## 重要约束（Lynx MTS）
 * - `'main thread'` worklet 运行在独立的主线程 runtime 中，不能可靠调用普通模块函数。
 * - 因此 worklet 内的逻辑应尽量“自包含”（少依赖外部函数），避免出现 `not a function` 类问题。
 * - BG 侧可以使用普通 helper（例如 `ensureLenFilled`）来减少样板代码。
 */

import { runOnMainThread, useCallback, useEffect, useRef } from "@lynx-js/react";

import type { ListScrollInfo } from "@lynx-js/types";
import { useLatestRef } from "./hooks";
import { nowMsBG } from "./mainThread/mainThreadMath";
import {
  computeMinBlockLenByVisibility,
  computeNeededRepeatFromBaseSegPx,
  computeNeededRepeatFromMinBlockLen,
  computeNextRepeat,
  computeRequiredSegPx,
  ensureLenFilled,
  normalizeRepeatByRowForRows,
  REPEAT_UPPER_LIMIT,
  THRESHOLD_ITEM_COUNT_DEFAULT,
} from "./utils";

type RepeatDecisionSource = "scrollWidth" | "visibleCells" | "fallback";

// 宽屏兜底：避免 iPad 横屏等场景下 blockLen/totalLen 过短导致 threshold/normalize 风暴
const WIDE_SCREEN_WIDTH_PX = 900;
const WIDE_MIN_BLOCK_LEN = 24;

// ===== repeat 决策辅助：cell 宽度测量（getVisibleCells）=====
// 若 scrollWidth 仅为“可见窗口的 partial 宽度”，其与 listWidth 的比值通常在 2~5 左右；
// 而“全量内容宽度”通常远大于 listWidth（很多屏）。这里用一个经验阈值来判断 scrollWidth 是否可能可信。
const SCROLL_WIDTH_RELIABLE_RATIO = 8;
// 测量短重试：尽量在不显著延长 ready 时间的前提下拿到稳定的 cellPx
const MEASURE_MAX_ATTEMPTS = 6;
const MEASURE_MAX_ELAPSED_MS = 200;

/**
 * allRowsStable 的“有限重试”参数：
 * - 背景：allRowsStable 早期是按 epoch 去重的“一次性信号”，一旦首次 notify 在时序上被上层丢弃，
 *   会导致首屏流程永远卡在 padding。
 * - 这里允许同一 epoch 下做有限次数重试，并对重试做节流。
 */
const ALL_ROWS_STABLE_RETRY_INTERVAL_MS = 300;
const ALL_ROWS_STABLE_MAX_NOTIFY_PER_EPOCH = 3;

type EpochMeasuredCellPx = {
  epoch: number;
  ok: boolean;
  sampleCount: number;
  cellPxForWidth: number;
  cellPxForCount: number;
  measuredAtMs: number;
  probeRow: number;
  listWidth: number;
};

/**
 * 统一的 repeat 计算逻辑（合并“宽度约束”与“最小 blockLen 约束”）
 *
 * - neededRepeatByWidth：让单段宽度 >= requiredSeg
 * - neededRepeatByCount：让 blockLen 足够大，避免 threshold/edge 长期命中引发事件/normalize 风暴
 */
function computeNextRepeatForRow(params: {
  listWidth: number;
  rowIndex: number;
  rowOffsetPx: number;
  baseLen: number;
  currentRepeat: number;
  /** 单段宽度（repeat=1 时），来自 scrollWidth 或 avgCellPx*baseLen */
  baseSegPx: number;
  /** 用于“最小 blockLen”约束的平均 cell 宽度估算 */
  avgCellPx: number;
}) {
  /**
   * requiredSegPx：对“单段内容宽度”的最低要求（px）。
   *
   * 单段 = A 段 或 B 段（两段结构相同，拼接为 A+B）。
   * repeat 的目标之一就是把单段撑到 >= requiredSegPx，确保存在可滚动范围。
   */
  const requiredSegPx = computeRequiredSegPx({
    listWidth: params.listWidth,
    rowIndex: params.rowIndex,
    rowOffsetPx: params.rowOffsetPx,
  });

  /**
   * 宽度约束：根据 baseSegPx（repeat=1 时单段宽度估算）推导“至少需要多少 repeat”。
   *
   * - baseSegPx 通常来自 layoutcomplete 的 scrollWidth 推导：
   *   baseSegPx = (scrollWidth / 2) / currentRepeat
   * - 若 baseSegPx 不可靠（<=0/NaN），实现会回退为 1（避免误判导致爆炸性 repeat）
   */
  const neededRepeatByWidth = computeNeededRepeatFromBaseSegPx({
    baseSegPx: params.baseSegPx,
    requiredSegPx,
  });

  /**
   * 数量约束：用“可见 item 数量”估算一个最小 blockLen（单段 item 数量）目标，避免阈值/边界事件长期命中。
   *
   * 术语：
   * - baseLen：这一行的数据长度（repeat 前的 item 数）
   * - blockLen：单段的 item 数量 = baseLen * repeat
   *
   * 当 blockLen 太小，list 会更容易处在阈值/边界附近，导致 normalize 高频触发，影响性能与稳定性。
   */
  const minBlockLenByVisibility = computeMinBlockLenByVisibility({
    listWidth: params.listWidth,
    avgCellPx: params.avgCellPx,
    thresholdItemCount: THRESHOLD_ITEM_COUNT_DEFAULT,
  });
  // 宽屏绝对下限：与 avgCellPx 是否可靠无关，直接保证单段最少长度
  const minBlockLen = params.listWidth >= WIDE_SCREEN_WIDTH_PX
    ? Math.max(minBlockLenByVisibility, WIDE_MIN_BLOCK_LEN)
    : minBlockLenByVisibility;
  const neededRepeatByCount = computeNeededRepeatFromMinBlockLen({
    baseLen: params.baseLen,
    minBlockLen,
  });

  // 合并两个约束：repeat 需要同时满足“宽度足够”和“数量足够”，因此取 max。
  const neededRepeat = Math.max(neededRepeatByWidth, neededRepeatByCount);
  return computeNextRepeat({
    currentRepeat: params.currentRepeat,
    neededRepeat,
    upperLimit: REPEAT_UPPER_LIMIT,
  });
}

/**
 * useDanmakuV2RepeatController：repeat 子系统对外接口
 *
 * - 返回 BG 的 `createLayoutCompleteHandler`：挂到 `<list bindlayoutcomplete>` 上
 * - 返回 `resetRepeatState`：用于数据代际（epoch）/rows 等变化时重置 repeat 子系统状态
 *
 * 说明：
 * - repeat 的“Ready状态”（是否还会继续提升）只在 BG 侧判定；
 * - 主线程只需要一个简单门禁：`repeatStableEpochByRowMTRef`（每行一个 stableEpoch）。
 *   - 当某行 stableEpoch === 当前 epoch 时，表示该行 repeat 已Ready，可安全参与 autoScroll。
 */
export function useDanmakuV2RepeatController(params: {
  safeRows: number;
  rowOffsetPx: number;
  /** 数据代际号（epoch）：变化时需要重置 repeat 子系统，并作为主线程 stableEpoch 的写入值 */
  epoch: number;
  debug: boolean;
  rowsData: Array<Array<unknown>>;
  repeatByRow: number[];
  setRepeatByRow: (next: number[] | ((prev: number[]) => number[])) => void;

  // main thread refs
  autoScrollEpochMTRef: { current: number };
  repeatStableEpochByRowMTRef: { current: number[] };

  // called on main thread
  scheduleAttemptStartAutoScrollMT: () => void;

  /**
   * 行可见 cell 宽度测量（BG→MT→BG）。
   *
   * 用途：优先使用 getVisibleCells 推导 cellPx 来做 repeat 决策，避免依赖 layoutcomplete.scrollWidth（虚拟化早期可能为 partial）。
   *
   * 说明：
   * - 该测量仅为只读，不会触发滚动或交互；
   * - 结果带 epoch，repeat 子系统只接受当前 epoch 的结果；
   * - 若测量失败，会按“短重试 + 超时兜底”回退到保守估算，避免卡死。
   */
  measureRowCellPx?: (
    rowIndex: number,
    epoch: number,
    onMeasuredBG: (payload: {
      epoch: number;
      rowIndex: number;
      ok: boolean;
      sampleCount: number;
      cellPxForWidth: number;
      cellPxForCount: number;
    }) => void,
  ) => void;

  /**
   * 当无法获得可靠的 cellPx（测量失败/超时）时的兜底平均宽度（px）。
   *
   * 设计目标：
   * - 只在极端情况下兜底，避免 repeat 子系统被测量失败卡住；
   * - 兜底值倾向于“保守不误升”：即宁可略少触发 minBlockLen，也不要把 repeat 错升到更高造成 remount/性能回退。
   */
  avgCellPxFallback?: number;

  /**
   * 当“所有行 repeat 已收敛（stable）”时回调（BG）。
   *
   * 用途：首屏拆分加载场景下，ready 阶段必须等待 repeat 检测完成后再开放交互。
   *
   * 注意：该回调按 epoch 去重：同一 epoch 只会触发一次。
   */
  onAllRowsStable?: (epoch: number) => void;
}) {
  const {
    safeRows,
    rowOffsetPx,
    epoch,
    debug,
    rowsData,
    repeatByRow,
    setRepeatByRow,
    autoScrollEpochMTRef,
    repeatStableEpochByRowMTRef,
    scheduleAttemptStartAutoScrollMT,
    measureRowCellPx,
    avgCellPxFallback,
    onAllRowsStable,
  } = params;

  // ===== BG：repeat 子系统状态 =====
  // mountedRef：防止卸载后仍然异步 setState（BG/MT 事件都可能迟到）
  const mountedRef = useRef(false);
  // repeatStableByRowRef：该行 repeat 是否已Ready（BG 内部判断）
  const repeatStableByRowRef = useRef<boolean[]>([]);

  // ===== BG：layoutcomplete 宽度缓存（用于决策与 debug）=====
  const lastListWidthByRowRef = useRef<number[]>([]);

  // ===== BG：cellPx 测量（Route 1：每个 epoch 只测量一行）=====
  // probeRow：每个 epoch 选“第一个非空行”作为代表行进行 getVisibleCells 测量，结果全行复用。
  const probeRowIndexRef = useRef<number>(-1);
  const epochMeasuredCellPxRef = useRef<EpochMeasuredCellPx | null>(null);
  const epochMeasureInFlightRef = useRef<boolean>(false);
  const epochMeasureAttemptsRef = useRef<number>(0);
  const epochMeasureFirstRequestedAtMsRef = useRef<number>(0);
  const epochListWidthHintRef = useRef<number>(0);

  const allRowsStableNotifiedEpochRef = useRef<number | null>(null);
  /**
   * allRowsStable 的“重试节流”状态：
   * - lastNotifiedAt：上一次触发 onAllRowsStable 的时间戳（用于节流）
   * - notifyCount：当前 epoch 已触发次数（用于上限控制）
   */
  const allRowsStableLastNotifiedAtMsRef = useRef<number>(0);
  const allRowsStableNotifyCountRef = useRef<number>(0);
  // 仅在 stableEpoch 变化时才下发到主线程，减少 BG→MT 的冗余调用
  const stableEpochPushedByRowRef = useRef<number[]>([]);

  const computeProbeRowIndexBG = useCallback(() => {
    "background only";
    for (let i = 0; i < safeRows; i++) {
      const baseLen = (rowsData[i] ?? []).length;
      if (baseLen > 0) return i;
    }
    return -1;
  }, [rowsData, safeRows]);

  const maybeNotifyAllRowsStableBG = useCallback(() => {
    "background only";
    if (!onAllRowsStable) return;
    const stableArr = repeatStableByRowRef.current;
    if (!Array.isArray(stableArr) || stableArr.length !== safeRows) return;
    for (let i = 0; i < safeRows; i++) {
      // 空行不参与“稳定”门禁（该行没有 list/layoutcomplete，自然也不会产生 repeat 问题）
      const baseLen = (rowsData[i] ?? []).length;
      if (baseLen <= 0) continue;
      if (!stableArr[i]) return;
    }

    // 同一 epoch 下允许“有限重试”：避免首次 notify 被上层 guard/时序丢弃后永远卡在 padding。
    const now = nowMsBG();
    if (allRowsStableNotifiedEpochRef.current !== epoch) {
      allRowsStableNotifiedEpochRef.current = epoch;
      allRowsStableLastNotifiedAtMsRef.current = 0;
      allRowsStableNotifyCountRef.current = 0;
    }

    if (allRowsStableNotifyCountRef.current >= ALL_ROWS_STABLE_MAX_NOTIFY_PER_EPOCH) {
      return;
    }

    const elapsedMs = now - (allRowsStableLastNotifiedAtMsRef.current || 0);
    if (elapsedMs < ALL_ROWS_STABLE_RETRY_INTERVAL_MS) {
      return;
    }

    allRowsStableLastNotifiedAtMsRef.current = now;
    allRowsStableNotifyCountRef.current += 1;
    if (debug) {
      console.info("[DanmakuV2][BG][Repeat] allRowsStable:notify", {
        epoch,
        count: allRowsStableNotifyCountRef.current,
      });
    }
    onAllRowsStable(epoch);
  }, [debug, epoch, onAllRowsStable, rowsData, safeRows]);

  const resetRepeatState = useCallback(() => {
    "background only";
    /**
     * 这里的重置是“按行维度”的：
     * - repeatStable=false：表示该行“未Ready”（需要重新经历一次 layoutcomplete 评估）
     *
     * 触发时机：
     * - epoch 或 safeRows 变化（由 renderTree 外层负责调用 resetRepeatState）
     */
    repeatStableByRowRef.current = Array(safeRows).fill(false);
    lastListWidthByRowRef.current = Array(safeRows).fill(0);
    stableEpochPushedByRowRef.current = Array(safeRows).fill(Number.NaN);
    probeRowIndexRef.current = -1;
    epochMeasuredCellPxRef.current = null;
    epochMeasureInFlightRef.current = false;
    epochMeasureAttemptsRef.current = 0;
    epochMeasureFirstRequestedAtMsRef.current = 0;
    epochListWidthHintRef.current = 0;
    allRowsStableNotifiedEpochRef.current = null;
    allRowsStableLastNotifiedAtMsRef.current = 0;
    allRowsStableNotifyCountRef.current = 0;
  }, [safeRows]);

  useEffect(() => {
    // 挂载标记：用于拒绝卸载后的迟到回调
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * BG：当前 epoch 的“最新值”
   *
   * 语义：
   * - epoch **只在** 数据语义/行数变化时推进
   * - BG 侧用它屏蔽非当前代际的迟到事件，避免污染当前状态
   * - **repeat 变化不会推进 epoch**：repeat 引起的 list 重建属于同一 epoch 内的“实例替换”，
   *   因此需要在 layoutcomplete 中通过 repeat-mismatch 校验丢弃“已被替换的实例”事件（见 createLayoutCompleteHandler）
   */
  const latestEpochBGRef = useLatestRef<number>(epoch);

  /**
   * BG：最新的 repeatByRow
   *
   * 用途：
   * - repeat 改变会触发该行 list remount，但 epoch 不变
   * - remount 窗口期，被替换掉的实例 layoutcomplete 可能迟到触发
   * - 因此需要用 “capturedRepeat vs latestRepeat” 做实例校验，丢弃旧实例事件
   */
  const latestRepeatByRowBGRef = useLatestRef<number[]>(repeatByRow);

  /**
   * BG：数组长度保护
   * - rows 变化（变多/变少）时，这些 per-row 数组必须裁剪/补齐
   * - BG 可以直接使用 ensureLenFilled
   */
  const ensureRepeatArraysBG = useCallback((rowsCount: number) => {
    "background only";
    // 这些数组都是“每行一个值”的状态容器。rows 变化时必须对齐长度，避免越界与旧值残留。
    repeatStableByRowRef.current = ensureLenFilled(repeatStableByRowRef.current, rowsCount, false);
    lastListWidthByRowRef.current = ensureLenFilled(lastListWidthByRowRef.current, rowsCount, 0);
    stableEpochPushedByRowRef.current = ensureLenFilled(
      stableEpochPushedByRowRef.current,
      rowsCount,
      Number.NaN,
    );
  }, []);

  /**
   * MT：写入 autoScroll 的 repeat 门禁（stableEpoch）
   *
   * 规则：
   * - `stable=true`：该行已Ready → `stableEpochByRow[row] = epoch`
   * - `stable=false`：该行未Ready → `stableEpochByRow[row] = -1`
   *
   * 主线程读取规则（见 `mainThread/autoScroll.ts`）：
   * - 对“有内容的行”，仅当 `stableEpoch === autoScrollEpoch` 才允许启动 autoScroll。
   *
   * 实现要点：
   * - 对齐数组长度时必须保留已有值（扩容补齐 / 裁剪 length），不要整体替换数组，
   *   否则可能丢失来自 BG 的异步写入。
   */
  const setRepeatStableEpochMT = useCallback(
    (rowIndex: number, stable: boolean, epoch: number) => {
      "main thread";
      // rows 变少时，丢弃越界行的迟到写入（防御：避免写爆数组或污染不存在的行）
      if (rowIndex < 0 || rowIndex >= safeRows) {
        if (debug) {
          console.info("[DanmakuV2][MT] repeatStable-sync", {
            result: "dropped:oob",
            row: rowIndex,
            stable,
            epoch,
            safeRows,
          });
        }
        return;
      }

      // 若写入来自更旧的 epoch，说明是迟到信号：丢弃即可。
      const currentEpoch = autoScrollEpochMTRef.current ?? 0;
      if (epoch < currentEpoch) {
        if (debug) {
          console.info("[DanmakuV2][MT] repeatStable-sync", {
            result: "dropped:stale-epoch",
            row: rowIndex,
            stable,
            epoch,
            currentEpoch,
          });
        }
        return;
      }

      // 对齐长度：仅补齐/裁剪，保留已有值，避免丢失异步写入
      if (!repeatStableEpochByRowMTRef.current) repeatStableEpochByRowMTRef.current = [];
      const arr = repeatStableEpochByRowMTRef.current;
      if (arr.length < safeRows) {
        for (let i = arr.length; i < safeRows; i++) {
          arr[i] = -1;
        }
      }
      arr.length = safeRows;

      const nextStableEpoch = stable ? epoch : -1;
      if ((arr[rowIndex] ?? -1) === nextStableEpoch) {
        if (debug && stable) {
          console.info("[DanmakuV2][MT] repeatStable-sync", {
            result: "noop:same",
            row: rowIndex,
            epoch,
            currentEpoch,
            stableEpoch: nextStableEpoch,
          });
        }
        return;
      }

      arr[rowIndex] = nextStableEpoch;
      // stable 变化可能解锁 autoScroll 的启动条件，因此主动触发一次尝试。
      scheduleAttemptStartAutoScrollMT();
      if (debug && stable) {
        console.info("[DanmakuV2][MT] repeatStable-sync", {
          result: "applied",
          row: rowIndex,
          epoch,
          currentEpoch,
          stableEpoch: nextStableEpoch,
        });
      }
    },
    [
      autoScrollEpochMTRef,
      debug,
      repeatStableEpochByRowMTRef,
      safeRows,
      scheduleAttemptStartAutoScrollMT,
    ],
  );

  const pushRepeatStableEpochBG = useCallback(
    (rowIndex: number, stable: boolean) => {
      "background only";
      if (rowIndex < 0 || rowIndex >= safeRows) return;
      ensureRepeatArraysBG(safeRows);
      const nextStableEpoch = stable ? epoch : -1;
      const pushed = stableEpochPushedByRowRef.current[rowIndex];
      if (pushed === nextStableEpoch) return;
      /**
       * BG → MT 同步（repeatStableEpoch）：
       * - stableEpoch 是主线程 autoScroll 的门禁之一：stableEpoch===epoch 才允许 start。
       * - 历史实现是“先写去重缓存 stableEpochPushedByRowRef，再 runOnMainThread 下发”，
       *   若这次下发偶发失败/丢失，BG 会误以为已同步成功，导致 MT 侧 stableEpoch 永久卡在 -1 → autoScroll 永远 wait。
       * - 因此这里做“失败回滚”：一旦下发失败，把去重缓存回滚到 pushed，保证后续仍能继续重试。
       */
      stableEpochPushedByRowRef.current[rowIndex] = nextStableEpoch;
      runOnMainThread(setRepeatStableEpochMT)(rowIndex, stable, epoch).catch(() => {
        if (stableEpochPushedByRowRef.current[rowIndex] === nextStableEpoch) {
          stableEpochPushedByRowRef.current[rowIndex] = pushed;
        }
      });
    },
    [ensureRepeatArraysBG, epoch, safeRows, setRepeatStableEpochMT],
  );

  /**
   * 强制同步（一次性对齐）：
   * - 用途：在进入 ready 后，主动把 BG 当前的 repeatStable 状态全量下发到 MT，
   *   避免由于偶现丢包导致 MT stableEpoch 停留在 -1，从而卡住 autoScroll。
   * - 该函数绕过 stableEpochPushedByRowRef 的去重缓存，属于“兜底自愈”路径。
   */
  const forceSyncRepeatStableEpochToMT = useCallback(() => {
    "background only";
    if (!mountedRef.current) return;
    if (latestEpochBGRef.current !== epoch) return;
    ensureRepeatArraysBG(safeRows);
    const stableArr = repeatStableByRowRef.current;
    for (let rowIndex = 0; rowIndex < safeRows; rowIndex++) {
      const baseLen = (rowsData[rowIndex] ?? []).length;
      if (baseLen <= 0) continue;
      const stable = !!stableArr?.[rowIndex];
      runOnMainThread(setRepeatStableEpochMT)(rowIndex, stable, epoch).catch(() => {});
    }
  }, [
    ensureRepeatArraysBG,
    epoch,
    latestEpochBGRef,
    mountedRef,
    rowsData,
    safeRows,
    setRepeatStableEpochMT,
  ]);

  /**
   * BG：应用 repeat 决策
   *
   * 两种结果：
   * - **需要提升**：setRepeatByRow → list key/id 包含 repeat，会触发该行 list 重建（不推进 epoch）
   * - **无需提升**：标记 stable，并同步到主线程
   *
   * 注意：
   * - 只“升不降”，避免滚动过程中 repeat 来回跳导致闪动/抖动
   * - 发生提升时，标记 stable=false：新 list 需要再次 layoutcomplete 确认稳定
   */
  const applyRepeatDecisionBG = useCallback(
    (payload: { rowIndex: number; nextRepeat: number; source: RepeatDecisionSource }) => {
      "background only";
      if (!mountedRef.current) return;
      // 丢弃非当前代际（迟到事件）导致的状态污染
      if (latestEpochBGRef.current !== epoch) return;

      ensureRepeatArraysBG(safeRows);

      const rowIndex = payload.rowIndex;
      if (rowIndex < 0 || rowIndex >= safeRows) return;

      const nextRepeat = Math.max(1, Math.floor(payload.nextRepeat || 1));

      setRepeatByRow((prev) => {
        /**
         * 注意：这里使用函数式 setState，是为了保证读到的 prev 与更新是同一原子步骤。
         * repeatByRow 会被多次 layoutcomplete 驱动更新，函数式写法能减少竞态。
         *
         * 另外：这里在 setState 回调里调用 runOnMainThread 写主线程 stableEpoch。
         * 该写入是幂等的（重复写同一个 stableEpoch 也安全），目的是缩短 BG 与主线程对“是否已Ready”的时间差。
         */
        const base = normalizeRepeatByRowForRows(prev, safeRows);
        const current = Math.max(1, Math.floor(base[rowIndex] ?? 1));
        const target = nextRepeat;

        // 仅当确实需要提升时才更新 state（触发该行 list 重建；epoch 不变）
        if (target > current) {
          const next = base.slice();
          next[rowIndex] = target;
          repeatStableByRowRef.current[rowIndex] = false;
          /**
           * 更新 repeat 时，先把主线程 stableEpoch 置为 -1（表示未Ready）：
           * - 这一行 list 会 remount（因为 key/id 含 repeat）
           * - remount 到新 list 首次 layoutcomplete 之间存在窗口期
           * - 若窗口期内启动 autoScroll，可能出现“先滚一下再重建”的闪动
           */
          pushRepeatStableEpochBG(rowIndex, false);
          if (debug) {
            console.info("[DanmakuV2][BG] repeat-apply: update", {
              row: rowIndex,
              current,
              nextRepeat: target,
              source: payload.source,
            });
          }
          return next;
        }

        // 无需提升：该行已Ready。把 stableEpoch 写到主线程，允许 autoScroll 尽快启动。
        // 注意：即使多次 layoutcomplete 重复写入也没问题（幂等），可确保主线程门禁最终一致。
        repeatStableByRowRef.current[rowIndex] = true;
        pushRepeatStableEpochBG(rowIndex, true);
        maybeNotifyAllRowsStableBG();
        if (debug) {
          console.info("[DanmakuV2][BG] repeat-apply: stable", {
            row: rowIndex,
            repeat: current,
            source: payload.source,
          });
        }
        return base;
      });
    },
    [
      debug,
      ensureRepeatArraysBG,
      latestEpochBGRef,
      maybeNotifyAllRowsStableBG,
      pushRepeatStableEpochBG,
      safeRows,
      setRepeatByRow,
      epoch,
    ],
  );

  const fallbackCellPx = Math.max(1, Number(avgCellPxFallback ?? 150) || 150);

  const computeNextRepeatFromCellPxBG = useCallback(
    (payload: {
      rowIndex: number;
      listWidth: number;
      baseLen: number;
      currentRepeat: number;
      cellPxForWidth: number;
      cellPxForCount: number;
    }) => {
      "background only";
      const cellPxForWidth = Math.max(1, Number(payload.cellPxForWidth) || 0);
      const cellPxForCount = Math.max(1, Number(payload.cellPxForCount) || 0);

      // repeat=1 时单段宽度估算：baseLen * cellPx
      const baseSegPx = payload.baseLen * cellPxForWidth;
      const avgCellPx = cellPxForCount;

      return computeNextRepeatForRow({
        listWidth: payload.listWidth,
        rowIndex: payload.rowIndex,
        rowOffsetPx,
        baseLen: payload.baseLen,
        currentRepeat: payload.currentRepeat,
        baseSegPx,
        avgCellPx,
      });
    },
    [rowOffsetPx],
  );

  const decideRepeatForRowFromSharedCellPxBG = useCallback(
    (rowIndex: number, source: RepeatDecisionSource) => {
      "background only";
      if (rowIndex < 0 || rowIndex >= safeRows) return;
      ensureRepeatArraysBG(safeRows);

      const measured = epochMeasuredCellPxRef.current;
      if (!measured || measured.epoch !== epoch) return;

      const listWidth = (lastListWidthByRowRef.current[rowIndex] ?? 0) > 0
        ? (lastListWidthByRowRef.current[rowIndex] ?? 0)
        : measured.listWidth;
      const baseLen = (rowsData[rowIndex] ?? []).length;
      if (!Number.isFinite(listWidth) || listWidth <= 0) return;
      if (baseLen <= 0) return;

      const currentRepeat = Math.max(
        1,
        Math.floor(latestRepeatByRowBGRef.current?.[rowIndex] ?? 1),
      );

      const cellPxForWidth = measured.ok && measured.cellPxForWidth > 0 ? measured.cellPxForWidth : fallbackCellPx;
      const cellPxForCount = measured.ok && measured.cellPxForCount > 0 ? measured.cellPxForCount : fallbackCellPx;

      const nextRepeat = computeNextRepeatFromCellPxBG({
        rowIndex,
        listWidth,
        baseLen,
        currentRepeat,
        cellPxForWidth,
        cellPxForCount,
      });

      applyRepeatDecisionBG({
        rowIndex,
        nextRepeat,
        source,
      });
    },
    [
      applyRepeatDecisionBG,
      computeNextRepeatFromCellPxBG,
      ensureRepeatArraysBG,
      epoch,
      epochMeasuredCellPxRef,
      fallbackCellPx,
      latestRepeatByRowBGRef,
      rowsData,
      safeRows,
    ],
  );

  const applySharedCellPxToAllRowsBG = useCallback(
    (source: RepeatDecisionSource) => {
      "background only";
      if (!mountedRef.current) return;
      if (latestEpochBGRef.current !== epoch) return;

      const measured = epochMeasuredCellPxRef.current;
      if (!measured || measured.epoch !== epoch) return;

      ensureRepeatArraysBG(safeRows);

      const sharedListWidth = measured.listWidth > 0 ? measured.listWidth : (epochListWidthHintRef.current ?? 0);
      const cellPxForWidth = measured.ok && measured.cellPxForWidth > 0 ? measured.cellPxForWidth : fallbackCellPx;
      const cellPxForCount = measured.ok && measured.cellPxForCount > 0 ? measured.cellPxForCount : fallbackCellPx;

      setRepeatByRow((prev) => {
        const base = normalizeRepeatByRowForRows(prev, safeRows);
        let next = base;
        let changed = false;

        for (let rowIndex = 0; rowIndex < safeRows; rowIndex++) {
          const baseLen = (rowsData[rowIndex] ?? []).length;
          if (baseLen <= 0) continue;

          const listWidth = (lastListWidthByRowRef.current[rowIndex] ?? 0) > 0
            ? (lastListWidthByRowRef.current[rowIndex] ?? 0)
            : sharedListWidth;
          if (!Number.isFinite(listWidth) || listWidth <= 0) continue;

          const currentRepeat = Math.max(1, Math.floor(base[rowIndex] ?? 1));
          const nextRepeat = computeNextRepeatFromCellPxBG({
            rowIndex,
            listWidth,
            baseLen,
            currentRepeat,
            cellPxForWidth,
            cellPxForCount,
          });

          if (nextRepeat > currentRepeat) {
            if (!changed) next = base.slice();
            changed = true;
            next[rowIndex] = nextRepeat;
            repeatStableByRowRef.current[rowIndex] = false;
            pushRepeatStableEpochBG(rowIndex, false);
          } else {
            repeatStableByRowRef.current[rowIndex] = true;
            pushRepeatStableEpochBG(rowIndex, true);
          }
        }

        maybeNotifyAllRowsStableBG();
        return changed ? next : base;
      });

      if (debug) {
        console.info("[DanmakuV2][BG][Repeat] measure:apply-all", {
          epoch,
          probeRow: measured.probeRow,
          source,
        });
      }
    },
    [
      computeNextRepeatFromCellPxBG,
      debug,
      ensureRepeatArraysBG,
      epoch,
      fallbackCellPx,
      latestEpochBGRef,
      maybeNotifyAllRowsStableBG,
      pushRepeatStableEpochBG,
      rowsData,
      safeRows,
      setRepeatByRow,
    ],
  );

  const requestEpochMeasureCellPxBG = useCallback(
    (hint: { listWidth?: number; triggerRow?: number } = {}) => {
      "background only";
      if (!mountedRef.current) return;
      if (latestEpochBGRef.current !== epoch) return;

      ensureRepeatArraysBG(safeRows);

      if (Number.isFinite(hint.listWidth) && (hint.listWidth ?? 0) > 0) {
        epochListWidthHintRef.current = Math.max(
          epochListWidthHintRef.current ?? 0,
          Math.floor(hint.listWidth ?? 0),
        );
      }

      // 每个 epoch 只测量一次：优先选择“第一个非空行”作为 probeRow
      if (probeRowIndexRef.current < 0) {
        probeRowIndexRef.current = computeProbeRowIndexBG();
      }
      const probeRow = probeRowIndexRef.current;
      if (probeRow < 0 || probeRow >= safeRows) return;

      // 已有本代测量结果：无需重复测量
      const measured = epochMeasuredCellPxRef.current;
      if (measured && measured.epoch === epoch) return;

      // 若未提供测量函数，直接使用 fallback（确保 repeat 不会被卡死在 unstable）
      if (!measureRowCellPx) {
        const listWidth = epochListWidthHintRef.current ?? 0;
        epochMeasuredCellPxRef.current = {
          epoch,
          ok: false,
          sampleCount: 0,
          cellPxForWidth: fallbackCellPx,
          cellPxForCount: fallbackCellPx,
          measuredAtMs: nowMsBG(),
          probeRow,
          listWidth,
        };
        if (debug) {
          console.info("[DanmakuV2][BG][Repeat] measure:skip(no-measure-fn)", {
            epoch,
            probeRow,
            triggerRow: hint.triggerRow,
            fallbackCellPx,
          });
        }
        applySharedCellPxToAllRowsBG("fallback");
        return;
      }

      // 去重：每个 epoch 同一时间只允许一个 in-flight
      if (epochMeasureInFlightRef.current) return;

      const requestOnce = () => {
        "background only";
        if (!mountedRef.current) return;
        if (latestEpochBGRef.current !== epoch) return;

        const now = nowMsBG();
        const firstAt = epochMeasureFirstRequestedAtMsRef.current || 0;
        if (!firstAt) epochMeasureFirstRequestedAtMsRef.current = now;

        const attempts = (epochMeasureAttemptsRef.current ?? 0) + 1;
        epochMeasureAttemptsRef.current = attempts;

        const elapsed = now - (epochMeasureFirstRequestedAtMsRef.current || now);
        if (attempts > MEASURE_MAX_ATTEMPTS || elapsed > MEASURE_MAX_ELAPSED_MS) {
          // 兜底：避免测量失败导致 repeat 永远不 stable（从而卡住首屏 ready）
          const listWidth = (lastListWidthByRowRef.current[probeRow] ?? 0) > 0
            ? (lastListWidthByRowRef.current[probeRow] ?? 0)
            : (epochListWidthHintRef.current ?? 0);
          epochMeasuredCellPxRef.current = {
            epoch,
            ok: false,
            sampleCount: 0,
            cellPxForWidth: fallbackCellPx,
            cellPxForCount: fallbackCellPx,
            measuredAtMs: nowMsBG(),
            probeRow,
            listWidth,
          };
          epochMeasureInFlightRef.current = false;
          if (debug) {
            console.info("[DanmakuV2][BG][Repeat] measure:fallback", {
              epoch,
              probeRow,
              triggerRow: hint.triggerRow,
              attempts,
              elapsed,
              fallbackCellPx,
            });
          }
          applySharedCellPxToAllRowsBG("fallback");
          return;
        }

        epochMeasureInFlightRef.current = true;

        measureRowCellPx(
          probeRow,
          epoch,
          (payload: {
            epoch: number;
            rowIndex: number;
            ok: boolean;
            sampleCount: number;
            cellPxForWidth: number;
            cellPxForCount: number;
          }) => {
            "background only";
            if (!mountedRef.current) return;
            if (latestEpochBGRef.current !== epoch) return;
            if (payload.epoch !== epoch) return;
            if (payload.rowIndex !== probeRow) return;

            epochMeasureInFlightRef.current = false;

            const ok = payload.ok
              && payload.sampleCount > 0
              && Number.isFinite(payload.cellPxForWidth)
              && payload.cellPxForWidth > 0
              && Number.isFinite(payload.cellPxForCount)
              && payload.cellPxForCount > 0;

            if (ok) {
              const listWidth = (lastListWidthByRowRef.current[probeRow] ?? 0) > 0
                ? (lastListWidthByRowRef.current[probeRow] ?? 0)
                : (epochListWidthHintRef.current ?? 0);
              epochMeasuredCellPxRef.current = {
                epoch,
                ok: true,
                sampleCount: payload.sampleCount,
                cellPxForWidth: payload.cellPxForWidth,
                cellPxForCount: payload.cellPxForCount,
                measuredAtMs: nowMsBG(),
                probeRow,
                listWidth,
              };
              if (debug) {
                console.info("[DanmakuV2][BG][Repeat] measure:ok", {
                  epoch,
                  probeRow,
                  triggerRow: hint.triggerRow,
                  sampleCount: payload.sampleCount,
                  cellPxForWidth: payload.cellPxForWidth,
                  cellPxForCount: payload.cellPxForCount,
                });
              }
              applySharedCellPxToAllRowsBG("visibleCells");
              return;
            }

            // 短重试：下一帧再测一次
            requestAnimationFrame(requestOnce);
          },
        );
      };

      requestOnce();
    },
    [
      debug,
      applySharedCellPxToAllRowsBG,
      computeProbeRowIndexBG,
      ensureRepeatArraysBG,
      epoch,
      fallbackCellPx,
      latestEpochBGRef,
      measureRowCellPx,
      safeRows,
      lastListWidthByRowRef,
    ],
  );

  /**
   * BG：layoutcomplete 处理器（repeat 评估入口）
   *
   * repeat 决策优先使用 “可见 cell 宽度测量（getVisibleCells）”，原因：
   * - 在虚拟化早期，layoutcomplete.scrollInfo.scrollWidth 可能只反映“当前已挂载/可见窗口”的 partial 宽度；
   * - 若用 partial scrollWidth 去推导 avgCellPx，会导致 minBlockLen 约束误判，从而把 repeat 错升（且只升不降）。
   *
   * 当 scrollWidth 明显“足够大”（可信）时，仍允许使用它作为快速路径：
   * - scrollWidth 覆盖 A+B 两段，因此单段约为 `scrollWidth/2`
   * - 再除以 currentRepeat，还原出 repeat=1 时单段宽度
   *
   * 该 handler 的调用频率可能较高（layoutcomplete / 内容更新 / list 重建等），
   * 因此做了：
   * - stable + repeat 未变化时直接 return
   */
  const createLayoutCompleteHandler = useCallback(
    (rowIndex: number) =>
    (e: {
      detail: {
        scrollInfo: ListScrollInfo;
      };
    }) => {
      "background only";
      // 丢弃非当前代际（迟到 list 事件）避免污染当前Ready状态
      if (latestEpochBGRef.current !== epoch) return;

      /**
       * layoutcomplete listWidth/scrollWidth
       */
      const detail = e.detail;
      const info = detail.scrollInfo;
      // @ts-expect-error old api
      const listWidth = info.listWidth || info.listWith;
      // @ts-expect-error old api
      const scrollWidth = info.scrollWidth || info.scrollWith;

      ensureRepeatArraysBG(safeRows);

      const baseLen = (rowsData[rowIndex] ?? []).length;

      /**
       * 丢弃旧实例事件
       * - repeat 提升会导致该行 `<list>` remount，但 epoch 不变
       * - remount 窗口期，被替换掉的 list 实例 layoutcomplete 可能迟到触发
       * - 因此必须校验：本 handler 捕获到的 repeat（capturedRepeat）是否等于“最新 repeat”（latestRepeat）
       * `capturedRepeat`：来自 这个 handler 闭包捕获的 repeatByRow（也就是“当时 render 出这个 handler 的那一帧”的 state）。
       * `latestRepeat`：来自 useLatestRef(repeatByRow) 的 .current（也就是“当前最新一次 render 已经提交后的 state”）。
       */
      const capturedRepeat = Math.max(1, Math.floor(repeatByRow[rowIndex] ?? 1));
      const latestRepeat = Math.max(
        1,
        Math.floor(latestRepeatByRowBGRef.current?.[rowIndex] ?? 1),
      );
      if (capturedRepeat !== latestRepeat) {
        return;
      }

      // 防御性检查
      if (!mountedRef.current || listWidth <= 0) return;

      // 记录最近一次 layoutcomplete 的宽度信息（用于 repeat 决策与测量兜底）
      lastListWidthByRowRef.current[rowIndex] = listWidth;
      epochListWidthHintRef.current = Math.max(
        epochListWidthHintRef.current ?? 0,
        Math.floor(listWidth || 0),
      );

      const currentRepeat = capturedRepeat;
      if (baseLen <= 0) {
        return;
      }

      /**
       * 已稳定且 repeat 未变化：无需重复评估。
       */
      if (repeatStableByRowRef.current[rowIndex]) {
        pushRepeatStableEpochBG(rowIndex, true);
        maybeNotifyAllRowsStableBG();
        return;
      }

      // ===== repeat 决策优先级 =====
      // 1) 如果 scrollWidth 明显“足够大”，通常意味着其已代表全量内容宽度，可直接用于决策（避免等待测量）
      // 2) 否则使用 “共享 cellPx 测量”（每个 epoch 只测量第一个非空行），避免 scrollWidth=partial 的误判
      const scrollWidthReliable = Number.isFinite(scrollWidth)
        && scrollWidth > 0
        && listWidth > 0
        && scrollWidth / listWidth >= SCROLL_WIDTH_RELIABLE_RATIO;

      if (scrollWidthReliable) {
        /**
         * 可信 scrollWidth：
         * - scrollWidth 覆盖 A+B 两段，因此单段宽度约为 scrollWidth/2
         * - 再除以 currentRepeat，还原出 repeat=1 时单段宽度
         */
        const seg = scrollWidth / 2;
        const baseSegPxFromScrollWidth = seg / Math.max(1, currentRepeat);
        if (!Number.isFinite(baseSegPxFromScrollWidth) || baseSegPxFromScrollWidth <= 0) return;

        const avgCellPxRaw = baseLen > 0 ? baseSegPxFromScrollWidth / baseLen : 0;
        const avgCellPx = listWidth >= WIDE_SCREEN_WIDTH_PX
          ? Math.min(avgCellPxRaw, Math.max(1, listWidth / 5))
          : avgCellPxRaw;

        const nextRepeat = computeNextRepeatForRow({
          listWidth,
          rowIndex,
          rowOffsetPx,
          baseLen,
          currentRepeat,
          baseSegPx: baseSegPxFromScrollWidth,
          // 额外防御：避免 avgCellPx 异常偏小导致 minBlockLen 误判
          avgCellPx: Math.max(avgCellPx, fallbackCellPx),
        });

        // 只允许用 scrollWidth 结论“放行不升级”；升级必须通过更准确的共享测量确认，避免误升导致 remount/闪动。
        if (nextRepeat <= currentRepeat) {
          applyRepeatDecisionBG({
            rowIndex,
            nextRepeat,
            source: "scrollWidth",
          });
          return;
        }
        if (debug) {
          console.info("[DanmakuV2][BG][Repeat] scrollWidth:upgrade-deferred", {
            epoch,
            row: rowIndex,
            currentRepeat,
            nextRepeat,
            listWidth,
            scrollWidth,
          });
        }
      }

      // scrollWidth 可能为 partial：优先走共享测量；若本代尚无测量结果则触发一次 probeRow 测量并等待批量决策
      const shared = epochMeasuredCellPxRef.current;
      if (shared && shared.epoch === epoch) {
        decideRepeatForRowFromSharedCellPxBG(rowIndex, shared.ok ? "visibleCells" : "fallback");
        return;
      }

      requestEpochMeasureCellPxBG({ listWidth, triggerRow: rowIndex });
    },
    [
      applyRepeatDecisionBG,
      decideRepeatForRowFromSharedCellPxBG,
      ensureRepeatArraysBG,
      debug,
      latestRepeatByRowBGRef,
      latestEpochBGRef,
      maybeNotifyAllRowsStableBG,
      pushRepeatStableEpochBG,
      epoch,
      fallbackCellPx,
      repeatByRow,
      rowOffsetPx,
      rowsData,
      safeRows,
      epochMeasuredCellPxRef,
      epochListWidthHintRef,
      requestEpochMeasureCellPxBG,
    ],
  );

  return {
    createLayoutCompleteHandler,
    resetRepeatState,
    forceSyncRepeatStableEpochToMT,
  };
}
