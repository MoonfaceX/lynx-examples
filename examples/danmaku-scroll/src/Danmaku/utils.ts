import type { BlockNativeEventArea, RowItem } from "./types";

/**
 * DanmakuV2 工具函数集合（utils）
 *
 * 本文件提供 DanmakuV2 的通用纯函数与小工具，给 BG（React/JS）与 MT（Lynx main thread worklet）两侧复用。
 * 这里的注释以“不了解 DanmakuV2/不了解 Lynx `<list>` 事件语义”的读者为目标，尽量把名词解释清楚。
 *
 * ## 术语表（本目录最常见名词）
 * - **row / 行**：弹幕的一行；DanmakuV2 会把输入 items 分摊到多行 `<list>`。
 * - **items**：业务传入的一维数组数据源。
 * - **rowsData**：把 items 分配到多行后的二维数组；每行元素类型为 `RowItem<T>`。
 * - **localIndex**：`RowItem` 上的索引字段，表示该 item 在原始 `items` 数组中的下标（全局下标）。
 *
 * - **baseLen**：某一行“基础长度”，即 `rowsData[row].length`（repeat 前的 item 数量）。
 * - **repeat / repeatTimes**：某一行的重复次数（整数且 >=1）。repeat 用于把同一段内容复制多次以“撑长”。
 *
 * - **segment / 段（A 段 / B 段）**：
 *   - 每行 list 内部渲染两段内容：A 段与 B 段；两段结构相同、连续拼接，用于形成“循环滚动”的视觉效果。
 *   - 因此整条 list 的内容可以理解为：A 段 + B 段。
 *
 * - **blockLen / segLen**：单段的 item 数量（当前实现中两者语义等价）：
 *   blockLen = segLen = baseLen * repeatTimes
 * - **totalLen**：整条 list 的总 item 数量（A+B 合计）：
 *   totalLen = 2 * blockLen
 *
 * - **listWidth**：list 容器宽度（px）。
 * - **scrollWidth**：list 内容总宽度（px），通常覆盖 A+B 两段，因此单段内容宽度约为 `scrollWidth/2`。
 *
 * - **threshold/edge 事件**：Lynx `<list>` 的边界/阈值事件（例如 scrolltoupper/scrolltolower/scrolltoupperedge/scrolltoloweredge）。
 *   DanmakuV2 会用这些事件触发 **normalize（索引归一化）**，把滚动位置拉回安全区，避免越界或数值漂移。
 */

// ===== 常量 =====
export const AUTO_SCROLL_RATE = "20px";
// 用户手动滚动后，延迟恢复原生 autoScroll 的冷却时间（仅影响 autoScroll，不影响 normalize）。
export const AUTO_SCROLL_USER_COOLDOWN_MS = 3000;
export const REPEAT_UPPER_LIMIT = 100;
export const TAP_MAX_DELTA_PX = 10;
export const TAP_MAX_DURATION_MS = 300;

// 默认只拦截边缘，避免“全区域阻止”影响宿主其它平台级手势体验
// - 左侧：固定 24px（iOS/Android 常见侧滑返回触发边缘）
// - 右侧：用百分比避免依赖 calc（文档说明仅支持 px/%）
export const DEFAULT_BLOCK_NATIVE_EVENT_AREAS = [
  ["0px", "0px", "24px", "100%"],
  ["95%", "0px", "5%", "100%"],
] satisfies BlockNativeEventArea[];

// 惯性滚动相关
export const MOMENTUM_START_VELOCITY = 220;
export const MOMENTUM_MAX_VELOCITY = 4000;
export const MOMENTUM_STOP_VELOCITY = 25;
export const MOMENTUM_MAX_DX = 90;
export const MOMENTUM_DECAY_K = 0.0032;

// normalize（边界/阈值触发的索引归一化）配置
export const THRESHOLD_ITEM_COUNT_DEFAULT = 2;
export const NORMALIZE_COOLDOWN_MS = 200;

// normalize 事件风暴熔断（终极兜底）
// - 在短时间内重复触发 threshold/edge 事件时，直接禁用当前 epoch 的所有 normalize（含 final/watchdog），避免主线程卡死。
export const NORMALIZE_EVENT_STORM_WINDOW_MS = 5000;
export const NORMALIZE_EVENT_STORM_TRIGGER_COUNT = 50;

// ===== repeat 计算（用于撑满可滚动范围）=====
// 目标：让单段（A 或 B 任一段）的内容宽度 >= requiredSeg，从而避免“无滚动空间 / 撞墙”。
/**
 * 计算单段（A 或 B 任一段）的“目标最小宽度”（px）。
 *
 * 为什么存在：
 * - DanmakuV2 的 list 禁用原生滚动（`enable-scroll=false`），滚动依赖主线程 `scrollBy/autoScroll`。
 * - 如果内容不足以产生可滚动范围（scroll range=0），任何滚动都不会生效。
 * - 因此需要通过 repeat 把内容撑到至少 \(1.5\) 屏，并覆盖奇数行的 phase 偏移，保证存在稳定滚动空间。
 *
 * 线程/调用方：
 * - BG（repeat.ts）用于计算 repeat 的目标；MT 不直接调用。
 */
export function computeRequiredSegPx(params: {
  listWidth: number;
  rowIndex: number;
  rowOffsetPx: number;
}) {
  const listWidth = Math.max(0, params.listWidth);
  const phase = params.rowIndex % 2 === 1 ? Math.max(0, params.rowOffsetPx) : 0;
  // 经验约束：
  // - 至少 1.5 屏，确保存在稳定滚动空间
  // - 同时覆盖奇数行的 phase（rowOffset）偏移，避免某些行在偏移后“刚好没有可滚动范围”
  return Math.max(listWidth * 1.5, listWidth + phase + 1);
}

/**
 * 根据“repeat=1 时单段宽度估算值”推导所需 repeat。
 *
 * - `baseSegPx` 来自 scrollWidth 推导或 visibleCells 测量。
 * - 若 baseSegPx 不可信（<=0/NaN），返回 1（保持最小值，避免计算爆炸）。
 */
export function computeNeededRepeatFromBaseSegPx(params: {
  baseSegPx: number; // repeat=1 时单段估算宽度
  requiredSegPx: number;
}) {
  const base = params.baseSegPx;
  if (!Number.isFinite(base) || base <= 0) return 1;
  const req = Math.max(0, params.requiredSegPx);
  return Math.max(1, Math.ceil(req / base));
}

/**
 * 合并当前 repeat 与所需 repeat，只允许“升不降”，并限制上限。
 *
 * 为什么只升不降：
 * - 降 repeat 会触发 list 反复重建，引起滚动闪动/抖动，并放大时序问题；
 * - Danmaku 场景下，宁可多一点内容冗余，也不要滚动体验不稳定。
 */
export function computeNextRepeat(params: {
  currentRepeat: number;
  neededRepeat: number;
  upperLimit: number;
}) {
  const current = Math.max(1, Math.floor(params.currentRepeat || 1));
  const needed = Math.max(1, Math.floor(params.neededRepeat || 1));
  const upper = Math.max(1, Math.floor(params.upperLimit || 1));
  return Math.min(upper, Math.max(current, needed));
}

// 基于“可见 item 数量”估算一个最小 blockLen（单段长度），避免 totalLen 太小导致 threshold/edge 长期处于命中态，
// 从而造成边界事件/normalize 高频触发，带来不必要的性能开销与状态机抖动。
/**
 * 基于“可见 item 数量”估算一个最小 blockLen（单段长度）目标。
 *
 * 术语回顾：
 * - blockLen = baseLen * repeatTimes（单段 item 数量）
 * - totalLen = 2 * blockLen（A+B 两段合计）
 *
 * 目的：
 * - 当 blockLen 太小，list 会长期处于 scrolltoupper/lower(threshold)/edge 命中状态；
 * - 这会触发 normalize 高频执行，造成性能抖动与状态机难以稳定。
 *
 * 注意：
 * - 若无法得到可靠的 avgCellPx，返回 0，表示本约束不生效（由宽度约束兜住）。
 */
export function computeMinBlockLenByVisibility(params: {
  listWidth: number;
  avgCellPx: number;
  thresholdItemCount: number;
}) {
  const listWidth = Math.max(0, params.listWidth);
  const cell = params.avgCellPx;
  if (!Number.isFinite(cell) || cell <= 0) return 0;

  // 估算一屏最多可见的 item 数（+1 做 buffer）
  const visibleCount = Math.max(1, Math.ceil(listWidth / cell) + 1);
  const guard = Math.max(0, Math.floor(params.thresholdItemCount || 0)) + 1;

  // 经验：让 blockLen 至少覆盖“可见范围 + 两端 guard + 一点 buffer”，保证存在稳定的中间区间
  return visibleCount + 2 * guard + 2;
}

/**
 * 根据最小 blockLen 目标，计算所需 repeat。
 *
 * - baseLen<=0 直接返回 1（空行/异常输入）。
 * - minBlockLen<=0 说明“可见性约束”不生效，返回 1。
 */
export function computeNeededRepeatFromMinBlockLen(params: {
  baseLen: number;
  minBlockLen: number;
}) {
  const baseLen = Math.max(0, Math.floor(params.baseLen || 0));
  if (baseLen <= 0) return 1;
  const minBlockLen = Math.max(0, Math.floor(params.minBlockLen || 0));
  if (minBlockLen <= 0) return 1;
  return Math.max(1, Math.ceil(minBlockLen / baseLen));
}

// ===== ensure helpers（用于减少大量长度保护样板代码）=====
/**
 * 保证数组长度为 len；若不匹配则返回一个用 fill 填充的新数组。
 *
 * 用途：
 * - DanmakuV2 大量使用 per-row/per-epoch 数组；rows 切换时必须裁剪/补齐；
 * - 通过这个 helper 避免到处写样板代码。
 */
export function ensureLenFilled<T>(arr: T[] | undefined | null, len: number, fill: T) {
  if (!Array.isArray(arr) || arr.length !== len) return Array(len).fill(fill);
  return arr;
}

/**
 * ensureLenFilled 的 ref 版本：必要时会原地更新 ref.current。
 *
 * 注意：
 * - 仅适用于普通 JS 线程（BG/React），不要在 Lynx main thread worklet 中调用（见 ensureRefLenFilledMT）。
 */
export function ensureRefLenFilled<T>(
  ref: { current: T[] | undefined | null },
  len: number,
  fill: T,
) {
  const next = ensureLenFilled(ref.current, len, fill);
  if (ref.current !== next) ref.current = next;
  return next;
}

// MT 专用版本：用于在 `'main thread'` worklet 中调用。
// 注意：Lynx MTS 下，worklet 中调用普通模块函数可能出现 `not a function`（主线程 runtime 无法解析依赖）。
// 因此需要显式标记为 main thread，让其进入主线程可用的函数集合。
/**
 * main-thread 版本的 ensureLenFilled。
 *
 * - 必须包含 `'main thread'` 指令，保证函数体可在 Lynx 主线程 runtime 执行。
 * - 只做最基础的数组长度保护，不依赖其它模块函数，避免 worklet 环境解析失败。
 */
export function ensureLenFilledMT<T>(arr: T[] | undefined | null, len: number, fill: T) {
  "main thread";
  if (!Array.isArray(arr) || arr.length !== len) return Array(len).fill(fill);
  return arr;
}

/**
 * main-thread 版本的 ensureRefLenFilled：必要时会原地更新 ref.current。
 *
 * - 仅在 `'main thread'` worklet 中调用。
 */
export function ensureRefLenFilledMT<T>(
  ref: { current: T[] | undefined | null },
  len: number,
  fill: T,
) {
  "main thread";
  const next = ensureLenFilledMT(ref.current, len, fill);
  if (ref.current !== next) ref.current = next;
  return next;
}

/**
 * repeatByRow 归一化（BG/React 常规线程使用，勿在 'main thread' worklet 中调用）
 *
 * ## 它在解决什么问题？
 *
 * DanmakuV2 的 repeat 值是“逐步收敛”的：BG 会根据 layoutcomplete/测量结果把某一行 repeat 从 1 提升到 2/3/4…
 * 这些 repeat 会直接参与 list 的 `key/id`（影响是否 remount），也会影响主线程 autoScroll 的启动门禁（需要等待每行 repeat 收敛）。
 *
 * 但当 rows（safeRows）发生变化时，React state 的 `repeatByRow` 会出现一个“窗口期不一致”：
 * - 例如 rows 从 5 → 3：下一次 render 里 `safeRows=3`，但 state 里的 `repeatByRow` 可能还是 length=5
 * - 例如 rows 从 3 → 5：state 里的 `repeatByRow` 可能还是 length=3（新增行没有 repeat 值）
 *
 * 如果在这个窗口期里：
 * - **直接用原数组**：会读到越界/undefined，导致渲染 repeatTimes 不可控（key/id 抖动）
 * - **粗暴降级为 `Array(rows).fill(1)`**：会把已经收敛好的 repeat 结果全部丢掉，触发 list 不必要重建，
 *   也会让主线程在 autoScroll 启动前重新等待 repeat 再次收敛，造成不必要的启动延迟
 *
 * 因此需要一个统一的归一化函数，强制维持下面的不变式：
 * - 返回数组长度 **始终等于** `rowsCount`
 * - 每个 repeat 值 **始终为整数且 >= 1**
 * - 在“值等价”的情况下尽量 **复用原数组引用**，降低不必要的 rerender/副作用触发
 *
 * ## 行为示例
 * - rows 5 → 3：`[3,3,3,4,4]` → `[3,3,3]`（裁剪，保留已收敛的前三行）
 * - rows 3 → 5：`[3,3,3]` → `[3,3,3,1,1]`（补齐，新行从 1 开始让 BG 再收敛）
 */
export function normalizeRepeatByRowForRows(prev: number[] | undefined | null, rowsCount: number) {
  const rows = Math.max(0, Math.floor(rowsCount || 0));
  if (rows <= 0) return [];

  if (Array.isArray(prev) && prev.length === rows) {
    let ok = true;
    for (let i = 0; i < rows; i++) {
      const v = prev[i];
      if (!Number.isFinite(v) || v <= 0) {
        ok = false;
        break;
      }
    }
    if (ok) return prev;
  }

  const next = Array.from({ length: rows }, (_, i) => {
    const v = prev?.[i];
    return Math.max(1, Math.floor(typeof v === "number" ? v : 1));
  });

  if (Array.isArray(prev) && prev.length === rows) {
    let same = true;
    for (let i = 0; i < rows; i++) {
      if ((prev[i] ?? 1) !== next[i]) {
        same = false;
        break;
      }
    }
    if (same) return prev;
  }

  return next;
}

/**
 * 将 v 夹在 [min, max]，并向下取整（保证返回整数）。
 *
 * 注意：
 * - DanmakuV2 的许多参数最终会传给原生组件，要求为整数（例如 repeat、index 等）。
 */
export function clampInt(v: number, min: number, max: number) {
  const n = Math.floor(v);
  // 处理 NaN 和非有限值，返回 min 作为安全默认值
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * 将 items 按行数 rows "轮询分配"为二维数组。
 *
 * 语义：
 * - 第 i 个 item 分到 `i % rows` 行；
 * - 产出 `RowItem`，包含原 item 与其在原数组中的 global index（localIndex）。
 *
 * 用途：
 * - DanmakuV2 的多行弹幕渲染，把输入 items 均匀分摊到各行。
 */
export function distributeRoundRobin<T>(items: T[], rows: number): RowItem<T>[][] {
  // 防御：rows 必须为正整数
  const safeRows = Math.max(1, Math.floor(rows) || 1);
  const result: RowItem<T>[][] = Array.from({ length: safeRows }, () => []);
  for (let i = 0; i < items.length; i++) {
    const rowIndex = i % safeRows;
    result[rowIndex].push({ item: items[i], localIndex: i });
  }
  return result;
}

/**
 * 精选优先行分配策略：
 * - isFeatured 为 true 的 item 全部放入第 0 行
 * - 其余 item 在剩余行（1 ~ rows-1）轮询分配
 *
 * 用途：
 * - DanmakuV2 需要将"精选/推荐"内容固定在第一行展示时使用。
 */
export function distributeFeaturedFirst<T>(
  items: T[],
  rows: number,
  isFeatured: (item: T) => boolean,
): RowItem<T>[][] {
  // 防御：rows 必须为正整数
  const safeRows = Math.max(1, Math.floor(rows) || 1);
  const result: RowItem<T>[][] = Array.from({ length: safeRows }, () => []);

  let localIndex = 0;
  for (let i = 0; i < items.length; i++) {
    if (isFeatured(items[i])) {
      result[0].push({ item: items[i], localIndex });
    } else if (safeRows <= 1) {
      result[0].push({ item: items[i], localIndex });
    } else {
      // Default → rows 1~safeRows-1 轮询
      const rowIndex = (localIndex % (safeRows - 1)) + 1;
      result[rowIndex].push({ item: items[i], localIndex });
    }
    localIndex++;
  }

  return result;
}

// 一个方法：当 list 长度不足时重复填充，直到达到目标长度；当 list 长度已足够时直接返回（绝不截断）。
// 例如：
// - [1,2,3] target=9 => [1,2,3,1,2,3,1,2,3]
// - [1,2,3,4] target=3 => [1,2,3,4]
export function repeatList<T>(list: T[], targetLength: number): T[] {
  if (!Array.isArray(list) || list.length <= 0) return [];
  const safeTarget = Math.max(0, Math.floor(targetLength || 0));
  if (safeTarget <= 0) return [];
  if (list.length >= safeTarget) return list;
  const result: T[] = [];
  for (let i = 0; i < safeTarget; i++) {
    result.push(list[i % list.length]);
  }
  return result;
}

/**
 * 根据可用高度计算最大弹幕行数
 *
 * @param availableHeightPx 可用高度（px）
 * @param rowHeightPx 每行高度（px）
 * @param rowGapPx 行间距（px）
 * @param minRows 最小行数（默认 2）
 * @param maxRows 最大行数（默认 6）
 * @returns 计算后的行数（限制在 [minRows, maxRows] 范围内）
 *
 * 计算公式：
 * - 每行占用空间 = rowHeightPx + rowGapPx（最后一行无需间距）
 * - 可容纳行数 = floor((可用高度 + 行间距) / (行高 + 行间距))
 * - 结果限制在 [minRows, maxRows] 范围内
 */
export function computeMaxRows(params: {
  availableHeightPx: number;
  rowHeightPx: number;
  rowGapPx?: number;
  minRows?: number;
  maxRows?: number;
}): number {
  const { availableHeightPx, rowHeightPx, rowGapPx = 12, minRows = 2, maxRows = 6 } = params;

  // 参数校验
  const available = Math.max(0, availableHeightPx);
  const rowH = Math.max(1, rowHeightPx);
  const gap = Math.max(0, rowGapPx);
  const min = Math.max(1, minRows);
  const max = Math.max(min, maxRows);

  if (available <= 0) return min;

  // 计算可容纳的最大行数
  // 公式：假设有 n 行，总高度 = n * rowHeight + (n-1) * rowGap
  // 反推：n = (availableHeight + rowGap) / (rowHeight + rowGap)
  const rowWithGap = rowH + gap;
  const computedRows = Math.floor((available + gap) / rowWithGap);

  // 限制在 [minRows, maxRows] 范围内
  return Math.max(min, Math.min(max, computedRows));
}
