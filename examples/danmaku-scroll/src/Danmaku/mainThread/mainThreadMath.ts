/**
 * DanmakuV2 - 主线程纯计算工具（worklet-safe）
 *
 * 目标：
 * - 从主线程各子系统（gesture/normalize/autoScroll）中抽离“高价值、无状态”的数学计算，
 *   降低业务逻辑文件的体积与噪音。
 * - 这些函数会在 `'main thread'` worklet 内被调用，因此：
 *   - 每个函数必须包含 `'main thread'` 指令；
 *   - 仅依赖 JS 内建（Math/Number），不要依赖其它模块函数。
 *
 * 阅读提示：
 * - 本文件不关心 UI/数据结构，只关心“输入数字 → 输出数字/简单结构”。
 * - 这些函数的返回值会被上层用于：
 *   - 惯性滚动（速度/位移/衰减）
 *   - tap 判定（位移阈值 + 时长阈值）
 *   - autoScroll probe（指数退避）
 *   - normalize（安全区 guard、anchor 选择、跳转目标计算）
 *
 * 单位约定（避免读代码时混淆）：
 * - **时间**：`dtMs` / `durationMs` 都是毫秒（ms）
 * - **位移**：`deltaPx` / `dx` / `left` 都是像素（px）
 * - **速度**：`velocityPxPerSec` 是 px/s
 * - **索引**：`index/minIndex/maxIndex/anchorIndex/targetIndex` 都是 `<list>` 的 item 索引（整数）
 */

/**
 * clampAbs：把 v 的绝对值夹在 maxAbs 内，保留符号。
 *
 * 用途（gesture → momentum）：
 * - 惯性滚动每帧计算出的 dx 需要做上限保护，避免 dt 异常或 velocity 异常导致“一帧滚太远”。
 *
 * 行为：
 * - 若 v 不是有限数，或 maxAbs<=0：返回 0（表示“这帧不滚动”）
 * - 否则返回范围在 [-maxAbs, +maxAbs] 的数值。
 */
export function clampAbs(v: number, maxAbs: number) {
  "main thread";
  const max = Math.max(0, maxAbs);
  if (!Number.isFinite(v) || max <= 0) return 0;
  if (v > max) return max;
  if (v < -max) return -max;
  return v;
}

/**
 * clampDtMs：把时间间隔 dt（ms）夹到合理范围（默认最大 40ms）。
 *
 * 用途（gesture → momentum）：
 * - rAF 惯性循环如果发生卡顿，dt 会变得很大，导致 dx = v * dt 一次跳太远。
 * - 夹紧 dt 可以让滚动更平滑，也让“速度衰减”更稳定。
 *
 * 行为：
 * - 若 dtMs 非法或 <=0：返回 0（表示“这帧不滚动/不更新速度”）
 * - 若 dtMs > maxDtMs：返回 maxDtMs
 * - 否则返回 dtMs 原值。
 */
export function clampDtMs(dtMs: number, maxDtMs = 40) {
  "main thread";
  const max = Math.max(0, Math.floor(maxDtMs));
  if (!Number.isFinite(dtMs) || dtMs <= 0) return 0;
  if (max > 0 && dtMs > max) return max;
  return dtMs;
}

/**
 * computeMomentumDx：根据速度与 dt 计算这帧的滚动位移 dx（px）。
 *
 * 用途（gesture → momentum）：
 * - 惯性滚动每帧会根据当前速度 `velocityPxPerSec` 计算 dx，并 `scrollBy({ offset: dx })`。
 *
 * 公式：
 * - dx = velocity(px/s) * dt(ms) / 1000
 * - 再通过 `clampAbs` 做每帧最大位移限制。
 */
export function computeMomentumDx(velocityPxPerSec: number, dtMs: number, maxDxAbs: number) {
  "main thread";
  if (!Number.isFinite(velocityPxPerSec) || !Number.isFinite(dtMs) || dtMs <= 0) {
    return 0;
  }
  const dx = (velocityPxPerSec * dtMs) / 1000;
  return clampAbs(dx, maxDxAbs);
}

/**
 * decayVelocityExp：对速度做指数衰减（exponential decay）。
 *
 * 用途（gesture → momentum）：
 * - 惯性滚动需要逐帧衰减速度，直到低于阈值停止。
 *
 * 公式：
 * - v(t+dt) = v(t) * exp(-k * dt)
 *
 * 参数说明：
 * - decayK：衰减强度（可理解为 1/ms）。k 越大，速度衰减越快。
 * - dtMs：这一帧的时间间隔（ms）。
 */
export function decayVelocityExp(velocityPxPerSec: number, decayK: number, dtMs: number) {
  "main thread";
  if (!Number.isFinite(velocityPxPerSec) || !Number.isFinite(dtMs) || dtMs <= 0) {
    return 0;
  }
  const k = Number.isFinite(decayK) ? Math.max(0, decayK) : 0;
  return velocityPxPerSec * Math.exp(-k * dtMs);
}

/**
 * shouldStopMomentum：判断惯性是否应停止。
 *
 * 用途（gesture → momentum）：
 * - 当速度绝对值低于某个阈值，就结束 rAF 循环，并做收尾（final normalize 等）。
 */
export function shouldStopMomentum(velocityPxPerSec: number, stopVelocityAbs: number) {
  "main thread";
  const stop = Math.max(0, stopVelocityAbs);
  if (!Number.isFinite(velocityPxPerSec)) return true;
  return Math.abs(velocityPxPerSec) < stop;
}

/**
 * shouldUpdateVelocity：判断某一次 touchmove 的 dt 是否适合用于速度估算。
 *
 * 用途（gesture → touchmove）：
 * - 速度估算基于 `delta/dt`。如果 dt 非常大（事件延迟/卡顿），速度会被严重低估或高估。
 * - 因此只在 dt 落在合理区间时更新速度。
 */
export function shouldUpdateVelocity(dtMs: number, maxDtMs = 80) {
  "main thread";
  if (!Number.isFinite(dtMs)) return false;
  const max = Math.max(0, Math.floor(maxDtMs));
  return dtMs > 0 && (max <= 0 || dtMs < max);
}

/**
 * computeInstantVelocityPxPerSec：用本帧位移 delta 与 dt 计算瞬时速度（px/s）。
 *
 * 用途（gesture → touchmove）：
 * - 估算用户“甩动”结束时的速度，用于决定是否进入惯性滚动。
 */
export function computeInstantVelocityPxPerSec(deltaPx: number, dtMs: number) {
  "main thread";
  if (!Number.isFinite(deltaPx) || !Number.isFinite(dtMs) || dtMs <= 0) return 0;
  return (deltaPx / dtMs) * 1000;
}

/**
 * ema：指数滑动平均（Exponential Moving Average）。
 *
 * 用途（gesture）：
 * - touchmove 的瞬时速度噪声很大，直接用会导致惯性启停抖动；
 * - 用 EMA 平滑后，速度更稳定。
 *
 * 参数说明：
 * - alpha ∈ [0,1]：越接近 1 越“跟手”（更相信 next），越接近 0 越“平滑”（更相信 prev）
 */
export function ema(prev: number, next: number, alpha: number) {
  "main thread";
  const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 0;
  const p = Number.isFinite(prev) ? prev : 0;
  const n = Number.isFinite(next) ? next : 0;
  return p * (1 - a) + n * a;
}

/**
 * nowMs：主线程可用的“当前时间戳”（ms）。
 *
 * 说明：
 * - DanmakuV2 的手势/惯性/normalize 等逻辑只需要“时间间隔”来计算速度/超时；
 * - 为通过工程规则（禁止直接使用 Date），统一把 Date.now 封装在一个 worklet-safe 函数内。
 * Main Thread version
 */
export function nowMs() {
  "main thread";
  // eslint-disable-next-line polling-config/no-date-usage
  return Date.now();
}

// BG version
export function nowMsBG() {
  // eslint-disable-next-line polling-config/no-date-usage
  return Date.now();
}

/**
 * isTapGesture：判定一次手势是否属于“tap（点击）”。
 *
 * 用途（gesture）：
 * - `<list-item>` 的 `catchtouchend` 不一定携带足够的位置信息，
 *   因此通过“总位移 + 时长”来判断是否是点击。
 *
 * 行为：
 * - 同时满足 `totalDeltaAbsPx < maxDeltaPx` 且 `durationMs < maxDurationMs` 才认为是 tap。
 * - 任一输入非法会被当作“不是 tap”，避免误判导致把滚动当点击。
 */
export function isTapGesture(
  totalDeltaAbsPx: number,
  durationMs: number,
  maxDeltaPx: number,
  maxDurationMs: number,
) {
  "main thread";
  // tap 的定义：位移足够小且时长足够短
  const d = Number.isFinite(totalDeltaAbsPx) ? totalDeltaAbsPx : Number.POSITIVE_INFINITY;
  const t = Number.isFinite(durationMs) ? durationMs : Number.POSITIVE_INFINITY;
  return d < Math.max(0, maxDeltaPx) && t < Math.max(0, maxDurationMs);
}

/**
 * computeProbeIntervalMs：autoScroll probe 的退避间隔（ms）。
 *
 * 用途（autoScroll.ts）：
 * - list 刚挂载/remount 的窗口期，`invoke('autoScroll')` / `invoke('scrollToPosition')` 可能失败；
 * - 用 `invoke('getVisibleCells')` 做“就绪探测”，成功则认为 layout ready；
 * - 退避可以避免每帧 probe 造成 invoke 风暴。
 */
export function computeProbeIntervalMs(attempts: number) {
  "main thread";
  /**
   * probe 退避策略（用于 autoScroll 的 getVisibleCells 探测）：
   * - 第 1 次：0ms（尽快探测）
   * - 后续逐步增加间隔，并在上限处封顶，避免 probe 变成高频 invoke 风暴
   */
  const a = Math.max(0, Math.floor(attempts || 0));
  if (a <= 0) return 0;
  const shift = Math.min(a, 3);
  return Math.min(400, 50 * (1 << shift));
}

/**
 * computeNormalizeGuards：根据 thresholdItemCount 计算 normalize 所需的 guard（缓冲区）。
 *
 * 用途（normalize.ts）：
 * - Lynx `<list>` 会在靠近边界时触发 threshold/edge 事件；
 * - 我们用 guard 定义“两端不安全区”的宽度，从而定义中间可用的“安全区”（safe band）。
 *
 * 返回值：
 * - upperGuard / lowerGuard：两端 guard 的 item 数量
 * - minTotalLenForSafeBand：存在安全区所需的最小 totalLen（经验值）
 */
export function computeNormalizeGuards(thresholdItemCountDefault: number) {
  "main thread";
  /**
   * guard 的含义：
   * - 当 list 接近上/下边界时，`scrolltoupper/lower(threshold)` 会提前触发；
   * - guard 表示我们希望在边界附近保留多少 item 作为“缓冲区”，从而定义可跳转的“安全区”。
   */
  const t = Math.max(0, Math.floor(thresholdItemCountDefault || 0));
  const upperGuard = t + 1;
  const lowerGuard = t + 1;
  // “安全区”存在需要满足：totalLen >= upperGuard + lowerGuard + 5
  const minTotalLenForSafeBand = upperGuard + lowerGuard + 5;
  return { upperGuard, lowerGuard, minTotalLenForSafeBand };
}

/**
 * hasSafeBand：判断 totalLen 是否足够大到可以存在“安全区”（safe band）。
 *
 * 用途（normalize.ts）：
 * - totalLen 太小的时候，list 可能几乎一直处于“靠近边界”的状态；
 * - 此时强行 normalize 不一定有意义，甚至可能造成来回跳动。
 */
export function hasSafeBand(totalLen: number, upperGuard: number, lowerGuard: number) {
  "main thread";
  const total = Math.max(0, Math.floor(totalLen || 0));
  const up = Math.max(0, Math.floor(upperGuard || 0));
  const low = Math.max(0, Math.floor(lowerGuard || 0));
  return total >= up + low + 5;
}

/**
 * computeUnsafeBand：判断当前可见区间是否进入两端不安全区（unsafe band）。
 *
 * 输入说明：
 * - minIndex/maxIndex：当前可见 cells 的最小/最大 index（来自 getVisibleCells）
 * - totalLen：A+B 双段总长度（totalLen = 2 * blockLen）
 *
 * 输出说明：
 * - unsafeUpper：可见区间已经进入上边界 guard 区（靠近 index=0）
 * - unsafeLower：可见区间已经进入下边界 guard 区（靠近 index=totalLen-1）
 */
export function computeUnsafeBand(
  minIndex: number,
  maxIndex: number,
  totalLen: number,
  upperGuard: number,
  lowerGuard: number,
) {
  "main thread";
  const minI = Math.floor(minIndex || 0);
  const maxI = Math.floor(maxIndex || 0);
  const total = Math.max(0, Math.floor(totalLen || 0));
  const up = Math.max(0, Math.floor(upperGuard || 0));
  const low = Math.max(0, Math.floor(lowerGuard || 0));
  /**
   * unsafe band 的含义：
   * - unsafeUpper：当前可见 items 的最小 index 已经进入上边界 guard 区
   * - unsafeLower：当前可见 items 的最大 index 已经进入下边界 guard 区
   *
   * 这用于判断：
   * - 是否需要 normalize（例如 final 场景下，如果没有进入 unsafe band 就可以跳过）
   * - 需要跳往哪个方向（upper/lower）
   */
  const unsafeUpper = minI <= up;
  const unsafeLower = maxI >= total - 1 - low;
  return { unsafeUpper, unsafeLower };
}

/**
 * chooseJumpDir：选择 normalize 的跳转方向（upper/lower）。
 *
 * 输入说明：
 * - dir：事件方向（例如 scrolltoupper/scrolltolower/edge 的方向）
 * - unsafeUpper/unsafeLower：当前是否触碰到上/下不安全区
 *
 * 规则：
 * - 默认沿用事件方向 dir
 * - 若只有上不安全：强制 upper
 * - 若只有下不安全：强制 lower
 */
export function chooseJumpDir(dir: "upper" | "lower", unsafeUpper: boolean, unsafeLower: boolean) {
  "main thread";
  // jumpDir 的选择逻辑：
  // - 默认跳转方向 = 事件方向 dir
  // - 若只有上不安全：强制 upper
  // - 若只有下不安全：强制 lower
  let jumpDir: "upper" | "lower" = dir;
  if (unsafeUpper && !unsafeLower) jumpDir = "upper";
  if (unsafeLower && !unsafeUpper) jumpDir = "lower";
  return jumpDir;
}

/**
 * computeNormalizeTargetIndex：根据 anchorIndex 与 blockLen 计算 normalize 目标 index。
 *
 * 背景（DanmakuV2 的 list 内容结构）：
 * - 每行 list 是 A+B 双段结构；
 * - 单段长度 blockLen = baseLen * repeatTimes；
 * - totalLen = 2 * blockLen。
 *
 * 核心想法：
 * - 选择一个当前可见的 anchor（锚点）cell；
 * - 当接近上边界时，跳到“另一段的同一位置”（通常是 +blockLen）；
 * - 当接近下边界时，跳到“另一段的同一位置”（通常是 -blockLen）；
 * - 这样视觉上保持连续，但索引回到安全区。
 */
export function computeNormalizeTargetIndex(
  anchorIndex: number,
  blockLen: number,
  totalLen: number,
  jumpDir: "upper" | "lower",
) {
  "main thread";
  const anchor = Math.floor(anchorIndex || 0);
  const block = Math.max(0, Math.floor(blockLen || 0));
  const total = Math.max(0, Math.floor(totalLen || 0));
  if (total <= 0) return 0;

  let targetIndex = jumpDir === "upper" ? anchor + block : anchor - block;
  /**
   * 目标 index 计算：
   * - 基础策略：anchorIndex ± blockLen（跨过一个“单段”）
   * - 若越界：尝试 flip 一次方向（只要能落在 [0, totalLen-1]）
   * - 最后再 clamp 到合法区间
   */
  if (targetIndex < 0 || targetIndex > total - 1) {
    const flipped = jumpDir === "upper" ? anchor - block : anchor + block;
    if (flipped >= 0 && flipped <= total - 1) targetIndex = flipped;
  }
  // clamp
  return Math.max(0, Math.min(total - 1, targetIndex));
}

/**
 * selectAnchorFromAttachedCells：从 getVisibleCells 的返回结果中选择一个“锚点”（anchor）。
 *
 * 用途（normalize.ts）：
 * - normalize 需要一个稳定锚点来计算目标 index，并在 scrollToPosition 时尽量保持视觉位置不突变。
 *
 * 选择规则：
 * - 选取 `left` 最小的 cell 作为 anchor（横向 list 中，left 越小越靠近视口起点）
 * - 同时计算 minIndex/maxIndex 作为“当前可见区间”，用于 unsafe band 判断
 *
 * 返回值：
 * - ok=false：没有可用的 cell（输入为空或全部数据非法）
 * - ok=true：包含 anchorIndex/anchorLeft/minIndex/maxIndex
 */
export function selectAnchorFromAttachedCells(
  attachedCells: Array<{ index: number; left: number }> | null | undefined,
) {
  "main thread";
  /**
   * anchor 的选择：
   * - attachedCells 来自 list.invoke('getVisibleCells')
   * - 我们选取 left 最小（最靠近视口起点）的 cell 作为 anchor，这样在 scrollToPosition 时更稳定
   * - 同时统计 minIndex/maxIndex，用于判断是否进入 unsafe band
   */
  if (!attachedCells || attachedCells.length <= 0) {
    return {
      ok: false,
      anchorIndex: 0,
      anchorLeft: 0,
      minIndex: 0,
      maxIndex: 0,
    };
  }

  let anchorIndex = 0;
  let anchorLeft = 0;
  let minIndex = 0;
  let maxIndex = 0;
  let hasAny = false;
  let bestLeft = Number.POSITIVE_INFINITY;

  for (let i = 0; i < attachedCells.length; i++) {
    const c = attachedCells[i];
    if (!c) continue;
    const idx = c.index;
    const left = c.left;
    if (!Number.isFinite(idx) || !Number.isFinite(left)) continue;

    if (!hasAny) {
      hasAny = true;
      anchorIndex = idx;
      anchorLeft = left;
      minIndex = idx;
      maxIndex = idx;
      bestLeft = left;
      continue;
    }

    if (idx < minIndex) minIndex = idx;
    if (idx > maxIndex) maxIndex = idx;
    if (left < bestLeft) {
      bestLeft = left;
      anchorIndex = idx;
      anchorLeft = left;
    }
  }

  if (!hasAny) {
    return {
      ok: false,
      anchorIndex: 0,
      anchorLeft: 0,
      minIndex: 0,
      maxIndex: 0,
    };
  }

  // 保证 anchorIndex/anchorLeft 都是合法的
  if (anchorIndex < 0) {
    return {
      ok: false,
      anchorIndex: 0,
      anchorLeft: 0,
      minIndex: 0,
      maxIndex: 0,
    };
  }
  return { ok: true, anchorIndex, anchorLeft, minIndex, maxIndex };
}
