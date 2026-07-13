import { useMainThreadRef, useRef } from "@lynx-js/react";
import type { MainThread } from "@lynx-js/types";

import type { DanmakuV2MomentumMode } from "../types";
import type { DanmakuV2MainThreadRefs } from "./types";

/**
 * 主线程 refs 创建（共享状态容器）
 *
 * 这个文件只做一件事：创建 DanmakuV2 主线程侧需要的所有 `useMainThreadRef`。
 *
 * 统一说明：
 * - BG/MT 运行时边界、epoch、safeRows 含义、refs 分组、绑定点映射表：
 *   统一见 `mainThread/index.ts` 文件头（避免在多个文件重复解释后出现不一致）。
 *
 * 入参说明：
 * - `autoScroll` 仅用于设置主线程开关（唯一来源）的“首帧初值”；
 *   后续开关变更由外层通过 `setAutoScrollEnabled` 命令通道下发。
 */
export function useDanmakuV2MainThreadRefs(params: {
  autoScroll: boolean;
  momentumMode: DanmakuV2MomentumMode;
  interactionLocked: boolean;
}) {
  const { autoScroll, momentumMode, interactionLocked } = params;

  /**
   * epoch 同步到主线程的“去重 / 避免重复同步”（BG 侧）。
   *
   * `effects.ts` 会在 epoch 变化时 runOnMainThread 做一系列初始化/对齐；
   * 这里记录上次已同步的 epoch，避免重复下发同样的同步任务。
   *
   * 注意：这个 ref 只在 BG 线程读写，不属于主线程 worklet 状态。
   */
  const lastEpochSyncedToMTRef = useRef<number | null>(null);

  /**
   * 每行 `<list>` 的主线程 Element 引用。
   * 写入点：`autoScroll.ts` 的 listMainThreadRefHandlers（绑定到 `<list main-thread:ref>`）。
   */
  const listMTRefs = useMainThreadRef<(MainThread.Element | null)[]>([]);

  // ===== 手势/惯性滚动运行态（全部在主线程读写）=====
  const isDraggingRef = useMainThreadRef(false);
  const lastTouchXRef = useMainThreadRef(0);
  const lastMoveTimeMsRef = useMainThreadRef(0);
  const swipeVelocityRef = useMainThreadRef(0);
  const touchStartTimeRef = useMainThreadRef(0);
  const totalDeltaRef = useMainThreadRef(0);
  const momentumRunningRef = useMainThreadRef(false);
  const momentumModeMTRef = useMainThreadRef<DanmakuV2MomentumMode>(momentumMode);
  // normalize 结束后恢复 autoScroll 的轮询调度标记（避免重复 schedule）
  const restoreScheduledRef = useMainThreadRef(false);
  // 主线程是否认为已经启动过原生 autoScroll（运行态的唯一来源标记，用于门禁与重复启动保护）
  const autoScrollingMTRef = useMainThreadRef(false);
  // 单次手势是否已上报过用户滚动（保证一次手势最多上报一次）
  const userScrollReportedForGestureMTRef = useMainThreadRef(false);

  /**
   * 交互/操作总门禁（主线程）。
   *
   * 用途：
   * - 首屏拆分加载阶段（bootstrap/padding）保持 locked=true，禁止任何滚动相关操作
   * - ready 后再置为 false，恢复正常行为
   */
  const interactionLockedMTRef = useMainThreadRef<boolean>(interactionLocked);

  /**
   * autoScroll 开关（主线程唯一来源）。
   *
   * - 初始化值来自 props 的“首帧初值”（initialAutoScroll）
   * - 后续必须通过 `setAutoScrollEnabled` 命令通道更新
   */
  const autoScrollEnabledMTRef = useMainThreadRef<boolean>(autoScroll);

  // ===== autoScroll 启动状态机（全部在主线程读写）=====
  const autoScrollLayoutReadyRef = useMainThreadRef<boolean[]>([]);
  // 当前主线程代际（由 effects.ts 写入；用于屏蔽迟到事件/旧 ref）
  const autoScrollEpochMTRef = useMainThreadRef<number>(0);
  // 每行 list 当前所属 epoch（ref 绑定时写 epoch；解绑时写 0）
  const listEpochByRowMTRef = useMainThreadRef<number[]>([]);
  // 是否已调度下一帧 attempt（避免 schedule 风暴）
  const autoScrollAttemptScheduledMTRef = useMainThreadRef<boolean>(false);
  const autoScrollWaitEpochMTRef = useMainThreadRef<number>(0);
  const autoScrollWaitStartedAtMsMTRef = useMainThreadRef<number>(0);
  const autoScrollProbeAttemptsByRowMTRef = useMainThreadRef<number[]>([]);
  const autoScrollLastProbeAtMsByRowMTRef = useMainThreadRef<number[]>([]);
  // 用户手动滚动后，延迟恢复 autoScroll 的冷却门禁（仅影响 autoScroll，不影响 normalize）。
  const autoScrollBlockedUntilMsMTRef = useMainThreadRef<number>(0);
  // 每行是否曾经 ready 过（非首次切换时可直接尝试 invoke，跳过 probe）
  const autoScrollLayoutEverReadyByRowMTRef = useMainThreadRef<boolean[]>([]);

  // ===== normalize（索引归一化）运行态（全部在主线程读写）=====
  const normalizingRef = useMainThreadRef<boolean[]>([]);
  const lastNormalizedAtMsRef = useMainThreadRef<number[]>([]);
  /**
   * normalize 的“待补做请求”（按行）：
   * - 当某行正在 normalize（同一行不允许并发 scrollToPosition）时，edge/threshold 事件会被记录到这里；
   * - 当前 normalize 结束释放锁后，会自动补做一次记录的请求。
   *
   * 命名说明：
   * - 这里使用 `pending*` 表示“等待执行的一次请求”（每行最多保留一条）。
   */
  const pendingNormalizeDirByRowMTRef = useMainThreadRef<Array<"upper" | "lower" | null>>([]);
  const pendingNormalizeReasonByRowMTRef = useMainThreadRef<Array<"threshold" | "edge" | null>>([]);

  /**
   * normalize watchdog（终极兜底，主线程）：
   *
   * 目标：在极端情况下（edge/threshold 事件丢失/未触发）仍能保证每行最终会被 normalize 回安全区。
   *
   * 设计约束：
   * - 低频、分片：每次 tick 只检查一行（safeRows<=5 → <=5s 完成一轮）
   * - 强门禁：仅在 ready（interactionLocked=false）且 autoScrollEnabled=true 且非拖拽/惯性时运行
   * - 幂等：允许多处 kick，但全局只跑一条循环
   */
  const normalizeWatchdogRunningRef = useMainThreadRef<boolean>(false);
  // 下一次允许执行检查的时间戳（ms）
  const normalizeWatchdogNextAtMsRef = useMainThreadRef<number>(0);
  // round-robin 游标：下一次从哪一行开始找可检查行
  const normalizeWatchdogCursorRef = useMainThreadRef<number>(0);
  // 记录 watchdog 启动时的 epoch：跨代时自动停止，避免旧代际循环泄漏到新代际
  const normalizeWatchdogEpochRef = useMainThreadRef<number>(0);

  /**
   * BG → MT 镜像数据：
   * - 由 effects.ts（以及 list layoutcomplete handler）同步到主线程
   * - 用于 autoScroll 的门禁与 normalize 的计算
   */
  const rowBaseLensMTRef = useMainThreadRef<number[]>([]);
  const repeatByRowMTRef = useMainThreadRef<number[]>([]);

  /**
   * repeatStable 门禁（stableEpoch）：
   *
   * 这是主线程侧给 autoScroll 使用的“逐行门禁数组”（每行一个 number）。
   * - stableEpoch === autoScrollEpoch：该行 repeat 已收敛，可参与 autoScroll
   * - stableEpoch === -1 或其它值：该行 repeat 未收敛（或不属于当前代际）
   *
   * 写入方：BG 的 repeat 子系统（`components/Danmaku/repeat.ts`）通过 runOnMainThread 下发。
   */
  const repeatStableEpochByRowMTRef = useMainThreadRef<number[]>([]);

  const refs: DanmakuV2MainThreadRefs = {
    listMTRefs,

    isDraggingRef,
    lastTouchXRef,
    lastMoveTimeMsRef,
    swipeVelocityRef,
    touchStartTimeRef,
    totalDeltaRef,
    momentumRunningRef,
    momentumModeMTRef,
    restoreScheduledRef,
    autoScrollingMTRef,
    userScrollReportedForGestureMTRef,
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

    normalizingRef,
    lastNormalizedAtMsRef,
    pendingNormalizeDirByRowMTRef,
    pendingNormalizeReasonByRowMTRef,

    normalizeWatchdogRunningRef,
    normalizeWatchdogNextAtMsRef,
    normalizeWatchdogCursorRef,
    normalizeWatchdogEpochRef,

    rowBaseLensMTRef,
    repeatByRowMTRef,

    repeatStableEpochByRowMTRef,
  };

  return { refs, lastEpochSyncedToMTRef };
}
