import type { MainThread } from "@lynx-js/types";
import type { DanmakuV2MomentumMode } from "../types";

/**
 * 主线程控制器的类型定义（给渲染子树与 repeat 子系统透传使用）。
 *
 * 说明：
 * - DanmakuV2 同时运行在 BG（React）与 MT（Lynx main thread worklet）两套运行时中。
 * - 这里的 controller 类型用于约束“渲染层绑定需要的 handler / ref”和“命令式控制接口”。
 *
 * 注意：
 * - BG/MT 运行时边界、epoch、safeRows 含义、refs 分组、绑定点映射表：
 *   统一见 `mainThread/index.ts` 文件头（避免多处重复解释后出现不一致）。
 */
export type DanmakuV2MainThreadController<_T = unknown> = {
  /**
   * 命令式控制 autoScroll。
   *
   * - enabled=true：尝试启动（仍受 repeatStable/ready/epoch/手势等门禁控制）
   * - enabled=false：立即停止，并清理所有可能导致误恢复的挂起态
   *
   * 设计原因：仅切换开关时，希望避免通过“更新渲染树属性”来表达状态；改为直接下发命令到主线程。
   *
   * 注意：
   * - 这个函数本身在 BG 调用（普通 JS 线程），内部会 runOnMainThread 执行主线程侧写入。
   */
  setAutoScrollEnabled: (enabled: boolean) => void;

  /**
   * 命令式控制“手势结束后的惯性滚动模式”（三态）。
   *
   * 目的：切换惯性模式时不触发渲染树大提交；主线程在手势/惯性热点路径读取 ref 即可。
   *
   * 语义：
   * - 'none'：禁用惯性；若当前正在惯性中，会尽快停止并做一次收尾（final normalize + 尝试恢复 autoScroll）
   * - 'normal'：当前默认惯性模式
   * - 'fastStop'：更快停止的惯性模式
   */
  setMomentumMode: (mode: DanmakuV2MomentumMode) => void;

  /**
   * 交互/操作总门禁（BG→MT 命令式下发）。
   *
   * 语义：
   * - locked=true：禁止任何滚动相关操作（gesture/momentum/normalize/autoScroll/probe）
   * - locked=false：恢复正常行为（是否自动滚动仍取决于 autoScrollEnabled 门禁）
   *
   * 用途：首屏拆分加载（bootstrap/padding）阶段保持完全不可交互，ready 后再统一放开。
   */
  setInteractionLocked: (locked: boolean) => void;

  /**
   * ready 前的“无感准备动作”（主线程）：
   * - 在不开放事件监听的情况下，把视口从单段位置迁移到 A/B 边界附近的安全区
   * - 目标：避免 ready 解锁瞬间触发 normalize/edge 导致闪屏
   *
   * 注意：该动作应在 locked=true 的阶段调用。
   */
  prepareForReady: (params?: { segCount?: 1 | 2 }) => void;

  /**
   * 测量某一行可见 cell 的宽度（BG→MT→BG）。
   *
   * 背景：
   * - `bindlayoutcomplete` 的 `scrollInfo.scrollWidth` 在虚拟化早期可能只反映“当前已挂载/可见的少量 item”，
   *   并不可靠地代表“整条 list 的总内容宽度”；
   * - repeat 子系统需要一个更稳定的输入（cell 宽度估算），以避免误判导致 repeat 错升（且 repeat 只升不降）。
   *
   * 设计：
   * - MT 侧用 `invoke('getVisibleCells')` 获取可见 item 的几何信息（left/right），并从中估算宽度分位数；
   * - 结果通过 `runOnBackground` 回调到 BG 侧，由 repeat 子系统用于计算 `baseSegPx/baseLen` 与 minBlockLen。
   *
   * 约束：
   * - 该测量是只读操作，不会触发滚动/交互；
   * - 结果必须带 epoch，BG 侧只接受当前 epoch 的测量结果。
   */
  measureRowCellPx: (
    rowIndex: number,
    epoch: number,
    onMeasuredBG: (payload: {
      epoch: number;
      rowIndex: number;
      ok: boolean;
      sampleCount: number;
      /** 偏保守：用于“宽度是否足够可滚动”的估算（例如 P20） */
      cellPxForWidth: number;
      /** 代表值：用于 minBlockLen 的可见性估算（例如 median） */
      cellPxForCount: number;
    }) => void,
  ) => void;

  // ==== for rendering bindings ====
  /**
   * 外层容器 `<view>` 的主线程触摸事件（用于手势拖拽/惯性）。
   * 绑定点：`main-thread:bindtouchstart`。
   */
  onTouchStartMT: (e: MainThread.TouchEvent) => void;
  /**
   * 外层容器 `<view>` 的主线程触摸事件（用于手势拖拽/惯性）。
   * 绑定点：`main-thread:bindtouchmove`。
   */
  onTouchMoveMT: (e: MainThread.TouchEvent) => void;
  /**
   * 外层容器 `<view>` 的主线程触摸结束事件。
   * 绑定点：`main-thread:bindtouchend` 与 `main-thread:bindtouchcancel`。
   *
   * 注意：这里不需要 event 参数；手势子系统会在 refs 中保存过程数据并在结束时读取。
   */
  onTouchEndMT: () => void;

  /**
   * 每行 `<list>` 的 ref 绑定 handler（主线程）。
   *
   * 绑定点：`<list main-thread:ref={listMainThreadRefHandlers[rowIndex]}>`
   *
   * 用途：
   * - 保存主线程侧的 list Element 引用
   * - 写入 listEpochByRow（把该行标记为属于当前 epoch）
   */
  listMainThreadRefHandlers: Array<(el: MainThread.Element | null) => void>;
  /**
   * 为每行 `<list>` 生成主线程 layoutcomplete handler。
   *
   * 绑定点：`main-thread:bindlayoutcomplete`
   *
   * 参数说明：
   * - baseLen/repeatTimes 来自 BG 渲染期的计算结果（用于更新主线程镜像数据）
   *
   * 用途：
   * - 标记该行 layoutReady（autoScroll/normalize invoke 的安全前置条件）
   * - 同步镜像：rowBaseLensMTRef/repeatByRowMTRef
   */
  createListLayoutCompleteMT: (
    rowIndex: number,
    baseLen: number,
    repeatTimes: number,
  ) => () => void;

  /**
   * 每行 `<list>` 的阈值/边界事件 handler（主线程）。
   * 绑定点：`main-thread:bindscrolltoupper` / `main-thread:bindscrolltolower`
   *
   * 用途：触发 normalize（把滚动位置拉回安全区）。
   */
  createScrollToUpperMT: (rowIndex: number) => () => void;
  createScrollToLowerMT: (rowIndex: number) => () => void;
  /**
   * 每行 `<list>` 的 edge 事件 handler（主线程）。
   * 绑定点：`main-thread:bindscrolltoupperedge` / `main-thread:bindscrolltoloweredge`
   */
  createScrollToUpperEdgeMT: (rowIndex: number) => () => void;
  createScrollToLowerEdgeMT: (rowIndex: number) => () => void;

  // ==== for repeat controller (repeat.ts) ====
  /**
   * 主线程当前代际（epoch）。
   *
   * - 写入：`mainThread/effects.ts` 在 epoch/safeRows 变化时同步
   * - 读取：autoScroll/normalize/ref handler/repeatStable sync 都会使用
   */
  autoScrollEpochMTRef: { current: number };
  /**
   * repeatStable 门禁（主线程）。
   *
   * 背景：repeat 是否“已收敛”只在 BG 能判定；主线程只需要一个轻量门禁来决定是否允许启动 autoScroll。
   *
   * 数据结构：每行一个 `stableEpoch`（number）。
   * - 写入（BG→MT，见 `components/Danmaku/repeat.ts`）：
   *   - stable=true  => stableEpoch = epoch
   *   - stable=false => stableEpoch = -1
   * - 读取（MT，见 `mainThread/autoScroll.ts`）：
   *   - 仅当 stableEpoch === autoScrollEpoch 时，认为该行 repeat 已收敛
   */
  repeatStableEpochByRowMTRef: { current: number[] };
  /**
   * 统一触发一次 autoScroll 启动尝试（主线程）。
   *
   * 重要：这是一个“调度器”，并不保证立刻 start；
   * 内部会检查 epoch/ref/layoutReady/repeatStable/手势状态/开关等门禁。
   */
  scheduleAttemptStartAutoScrollMT: () => void;

  finalCheckAllRowsMT: () => void;
  restoreAutoScrollAfterNormalizeMT: () => void;
};

export type DanmakuV2MainThreadRefs = {
  // ==== base ====
  /** 每行 list 在主线程的 Element 引用（main-thread:ref 写入） */
  listMTRefs: { current: Array<MainThread.Element | null> };

  // gesture
  /** 是否正在拖拽（touchstart→true，touchend/cancel→false） */
  isDraggingRef: { current: boolean };
  /** 最近一次触摸点的 x 坐标（用于计算 delta） */
  lastTouchXRef: { current: number };
  /** 最近一次 touchmove 的时间戳（ms，用于速度估算） */
  lastMoveTimeMsRef: { current: number };
  /** 当前平滑后的速度（px/s，EMA 平滑） */
  swipeVelocityRef: { current: number };
  /** touchstart 的时间戳（ms，用于 tap 判定与上报 duration） */
  touchStartTimeRef: { current: number };
  /** 单次手势总位移（累计 |delta|，用于 tap 判定与上报） */
  totalDeltaRef: { current: number };
  /** 惯性滚动是否正在运行（true 表示 gesture 子系统在 rAF 中驱动 scrollBy） */
  momentumRunningRef: { current: boolean };
  /** 惯性滚动模式（三态）。由 BG 命令式下发，MT 热点路径直接读取该 ref。 */
  momentumModeMTRef: { current: DanmakuV2MomentumMode };
  /** 是否已调度“normalize 后恢复 autoScroll”的轮询 */
  restoreScheduledRef: { current: boolean };
  /** 当前是否已经对任一行启动了原生 autoScroll（运行态的唯一来源标记） */
  autoScrollingMTRef: { current: boolean };
  /** 单次手势是否已上报过用户滚动（保证一次手势最多上报一次） */
  userScrollReportedForGestureMTRef: { current: boolean };

  // interaction gate (BG → MT)
  /** 总门禁：locked=true 时禁止任何滚动相关操作（gesture/normalize/autoScroll/probe） */
  interactionLockedMTRef: { current: boolean };

  // autoScroll
  /** 开关的主线程唯一来源（所有“尝试启动”路径都必须读它，避免闭包过期） */
  autoScrollEnabledMTRef: { current: boolean };
  /** 每行是否 ready（layoutcomplete / probe 通过后置 true，用于 invoke 安全判定） */
  autoScrollLayoutReadyRef: { current: boolean[] };
  /** 当前数据代际（epoch，用于屏蔽迟到事件/非当前代 ref） */
  autoScrollEpochMTRef: { current: number };
  /** 每行 list 当前属于哪个 epoch（ref 绑定时写入；解绑时置 0） */
  listEpochByRowMTRef: { current: number[] };
  /** 是否已调度“下一帧尝试启动 autoScroll”的 rAF（防止重复 schedule） */
  autoScrollAttemptScheduledMTRef: { current: boolean };
  /** 当前等待 layoutReady/probe 的 epoch（用于跨 epoch 重置等待窗口） */
  autoScrollWaitEpochMTRef: { current: number };
  /** 当前 epoch 下开始等待的时间戳（ms，超过阈值会停止等待避免卡死） */
  autoScrollWaitStartedAtMsMTRef: { current: number };
  /** 每行 probe 已尝试次数（用于指数退避） */
  autoScrollProbeAttemptsByRowMTRef: { current: number[] };
  /** 每行上次 probe 的时间戳（ms，用于计算下一次 probe 何时触发） */
  autoScrollLastProbeAtMsByRowMTRef: { current: number[] };
  /**
   * autoScroll 冷却门禁（用户手动滚动后延迟恢复）。
   *
   * - 仅影响原生 `invoke('autoScroll', { start: true })` 的启动时机；
   * - probe / layoutReady 仍需正常运行（normalize 依赖它做 invoke 安全判定）。
   */
  autoScrollBlockedUntilMsMTRef: { current: number };
  /** 每行是否曾经 ready 过（非首次切换时可直接尝试 invoke，跳过 probe） */
  autoScrollLayoutEverReadyByRowMTRef: { current: boolean[] };

  // normalize
  /** 每行 normalize 锁：true 表示该行正在 normalize（避免并发 scrollToPosition） */
  normalizingRef: { current: boolean[] };
  /** 每行上次 normalize 的时间戳（ms，用于 cooldown 控制） */
  lastNormalizedAtMsRef: { current: number[] };
  /**
   * queued normalize（每行最多保留一条待补做的请求）：
   * - 当某行正在 normalize（锁已占用）时，edge/threshold 事件不会并发执行；
   * - 这里记录一条“等本次 normalize 结束后需要再做一次”的请求，用于避免边界类事件被吞掉。
   *
   * 注意：
   * - 只对 edge/threshold 进行排队；final 属于收尾检查，不排队。
   */
  pendingNormalizeDirByRowMTRef: { current: Array<"upper" | "lower" | null> };
  /** queued 的原因（edge/threshold，且 edge 优先级更高） */
  pendingNormalizeReasonByRowMTRef: {
    current: Array<"threshold" | "edge" | null>;
  };

  // normalize watchdog（终极兜底，低频分片巡检）
  /** watchdog 是否正在运行（幂等：全局只跑一条循环） */
  normalizeWatchdogRunningRef: { current: boolean };
  /** 下一次允许执行检查的时间戳（ms） */
  normalizeWatchdogNextAtMsRef: { current: number };
  /** round-robin 游标：下一次从哪一行开始找可检查行 */
  normalizeWatchdogCursorRef: { current: number };
  /** watchdog 启动时的 epoch：跨代时自动停止，避免旧代际循环落到新代际 */
  normalizeWatchdogEpochRef: { current: number };

  // mirror data (BG → MT)
  /** 每行 baseLen 的镜像（BG 计算后同步到 MT） */
  rowBaseLensMTRef: { current: number[] };
  /** 每行 repeatTimes 的镜像（BG repeat 决策后同步到 MT） */
  repeatByRowMTRef: { current: number[] };

  // repeatStable gating（stableEpoch）
  /**
   * 每行 repeat 的 stableEpoch（作为 autoScroll 启动门禁之一）。
   *
   * 语义：
   * - stableEpoch === autoScrollEpoch：该行 repeat 已稳定
   * - stableEpoch !== autoScrollEpoch：该行 repeat 未收敛（或属于其它代际；统一视为未收敛）
   */
  repeatStableEpochByRowMTRef: { current: number[] };
};
