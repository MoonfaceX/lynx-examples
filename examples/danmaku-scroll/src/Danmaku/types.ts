export interface ScreenInfo {
  screenHeight: number | null;
  screenOrientation: string | null;
  screenWidth: number | null;
}

export type DanmakuV2SegmentInfo = {
  start: number;
  end: number;
  length: number;
};

/**
 * 惯性滚动模式（三态）：
 * - 'none'：不启动惯性滚动（手势结束后直接收尾 normalize，并按开关恢复 autoScroll）
 * - 'normal'：当前默认惯性滚动（与现有实现一致）
 * - 'fastStop'：更快停止的惯性滚动（更强衰减，停止更早）
 */
export type DanmakuV2MomentumMode = "none" | "normal" | "fastStop";

export type DanmakuV2DebugMetrics = {
  rows: number;
  itemsLength: number;
  /**
   * 数据代际号（epoch）。
   *
   * 说明：
   * - 这里沿用历史字段名 `dataVersion`（对外兼容），其语义等同于组件的 `dataEpoch`；
   * - 它不是“数组引用版本”，而是“数据语义代际编号”，用于驱动主线程门禁与子系统重置。
   */
  dataVersion: number;
  baseLenByRow: number[];
  repeatByRow: number[];
  /** 单段长度（A 或 B 任意一段）：baseLen * repeat */
  segLenByRow: number[];
  segAByRow: DanmakuV2SegmentInfo[];
  segBByRow: DanmakuV2SegmentInfo[];
  /** 每行总 list-item 数：2 * segLen */
  totalListItemsByRow: number[];
  totalListItemsAllRows: number;
};

/**
 * 性能打点指标：从金刚位点击到弹幕切换完成并开始滚动的各阶段耗时。
 *
 * 阶段说明：
 * - clickTimestamp: 金刚位点击时间戳（由业务层传入）
 * - dataSwitchTime: 数据传递到 Danmaku 组件的时间戳
 * - bootstrapTime: renderTree 从 bootstrap 进入 padding 的时间戳
 * - readyTime: renderTree 从 padding 进入 ready 的时间戳
 * - scrollStartTime: 原生 autoScroll 启动成功的时间戳（主线程）
 */
export type DanmakuV2PerfMetrics = {
  /** 金刚位点击时间戳（ms） */
  clickTimestamp: number;
  /** 数据传递到 Danmaku 组件的时间戳（ms） */
  dataSwitchTime: number;
  /** bootstrap → padding 的时间戳（ms） */
  bootstrapTime?: number;
  /** padding → ready 的时间戳（ms） */
  readyTime?: number;
  /** 原生 autoScroll 启动成功的时间戳（ms） */
  scrollStartTime?: number;
};

/**
 * 性能打点结果：包含各阶段绝对时间戳与相对耗时。
 */
export type DanmakuV2PerfResult = {
  /** 各阶段时间戳 */
  metrics: DanmakuV2PerfMetrics;
  /** 总耗时：从点击到滚动启动（ms） */
  totalMs: number;
  /** 各阶段分段耗时（ms） */
  phases: {
    /** 点击 → 数据传递 */
    clickToDataMs: number;
    /** 数据传递 → bootstrap 完成（padding） */
    dataToBootstrapMs: number;
    /** bootstrap → ready */
    bootstrapToReadyMs: number;
    /** ready → 滚动启动 */
    readyToScrollMs: number;
  };
};

type PxOrPercent = `${number}px` | `${number}%`;
export type BlockNativeEventArea = [PxOrPercent, PxOrPercent, PxOrPercent, PxOrPercent];

export type DanmakuV2Props<T> = {
  /**
   * 数据代际号（epoch，**强烈建议业务侧维护**）。
   *
   * 语义：
   * - 只要 items 的“语义”发生变化（例如 length/顺序/任一 key 变化）或 rows 变化，就必须推进一代；
   * - DanmakuV2 会用该代际号：
   *   - 屏蔽主线程迟到/乱序事件与 Promise 落地（epoch 门禁）
   *   - 重置 repeat/曝光去重等依赖数据语义的子系统状态
   *   - 驱动 `<list>` key/id 更新，确保虚拟化与内部状态与新数据对齐
   *
   * 背景（为何必须存在）见 `dataEpoch.ts` 文件头说明。
   */
  dataEpoch: number;
  items: T[];
  rows: number;
  /**
   * 可选：精选判断谓词。传入后，isFeatured(item) === true 的 item 会全部放入第 0 行，
   * 其余 item 在剩余行轮询分配；不传则使用默认的均匀轮询策略。
   */
  isFeatured?: (item: T) => boolean;
  rowGapPx?: number;
  itemGapPx?: number;
  autoScroll?: boolean;
  /**
   * normalize watchdog（兜底巡检）一轮扫完的目标时长（ms）。
   *
   * 用途：
   * - 极端情况下 edge/threshold 事件不触发时，仍能保证每行最终会被 normalize 拉回安全区
   * - 默认 5000ms（safeRows<=5 → 最多 5 秒完成一轮，每次只检查一行）
   */
  normalizeWatchdogSweepMs?: number;
  /**
   * 惯性滚动（三态控制）：
   * - 'none'：禁用惯性
   * - 'normal'：当前惯性模式（默认）
   * - 'fastStop'：更快停止下来的惯性模式
   *
   * 注意：这是“手势结束后的惯性（momentum）”，不影响手势拖拽本身，也不影响原生 autoScroll。
   */
  momentumMode?: DanmakuV2MomentumMode;
  /**
   * 阻止 Lynx 外部（平台层）手势的触摸区域（用于防止“边缘侧滑返回/页面滑出”）
   *
   * - 对应 `<view>` 属性 `block-native-event-areas`
   * - 仅在触点落在这些区域且该节点处于 event response chain 时生效
   * - 默认会拦截左右边缘区域（左：24px，右：5%）
   */
  blockNativeEventAreas?: BlockNativeEventArea[];
  rowHeightPx: number;
  rowOffsetPx?: number;
  debug?: boolean;
  renderItem: (item: T, index: number) => JSX.Element;
  getItemKey?: (item: T) => string;
  onItemClick?: (item: T, index: number, rowIndex: number) => void;
  /**
   * 用户主动滚动上报（仅手势触发，不包含 autoScroll / normalize 等程序滚动）
   * - 性能优先：一次手势结束（touchend/cancel）最多触发一次
   * - 会过滤点击（tap）
   */
  onUserScroll?: (info: { velocityX: number; totalDeltaAbsPx: number; durationMs: number }) => void;
  /**
   * 当前 cell 曝光（进入可见列表即曝光）
   * - 仅在传入回调时启用监听
   * - 同一个 item 在同一次挂载期间只会上报一次（去重）
   */
  onItemExpose?: (item: T, indexInRow: number, rowIndex: number) => void;
  /**
   * Debug 指标上报（用于 Demo/联调展示）
   * - 低频触发：仅随 items/rows/repeatByRow 等状态变化更新
   */
  onDebugMetricsChange?: (metrics: DanmakuV2DebugMetrics) => void;
  /**
   * 性能打点初始数据（由业务层传入点击时间戳等）
   * - 每次金刚位点击时应传入新的 perfMetrics 对象
   */
  perfMetrics?: DanmakuV2PerfMetrics;
  screenInfo?: ScreenInfo;
  /**
   * 首屏拆分加载（默认启用，用于降低首屏 commit 的 `<list-item>` 数量）。
   *
   * 设计目标：
   * - bootstrap：先渲染“一屏多一点”的小数据量（且仅渲染单段），让首帧更快出现
   * - padding：首屏 commit 后立刻补齐全量数据与 A/B 双段，并启动 repeat 检测
   * - ready：等待 repeat 检测完成后再开放交互/事件/autoScroll
   *
   * 注意：该策略只影响首屏阶段的渲染量与事件门控；ready 后行为与现状保持一致。
   */
  firstScreenOptimize?: {
    /** 是否启用（默认 true） */
    enabled?: boolean;
    /**
     * 估算单个 cell 的平均宽度（px），用于计算首屏需要渲染多少 item。
     * 默认 150（可按线上体验微调）。
     */
    estimatedCellPx?: number;
    /**
     * 每行额外预渲染的 buffer item 数（默认 2），用于“略多一屏”，避免首屏太短。
     */
    bufferItemsPerRow?: number;
    /**
     * 每行最少预渲染的 item 数（默认 4），用于避免 rows 较多/屏幕较宽时首屏过空。
     */
    minItemsPerRow?: number;
  };
};

export type DanmakuV2RenderTreeProps<T> = Omit<DanmakuV2Props<T>, "autoScroll" | "momentumMode"> & {
  /**
   * 仅用于主线程开关（唯一来源）的“首帧初值”。
   * 后续开关变更通过外层“命令通道”驱动（见 bindAutoScrollControl）。
   */
  initialAutoScroll: boolean;
  /**
   * 仅用于主线程“惯性模式”的首帧初值。
   * 后续模式变更通过外层“命令通道”驱动（避免触发渲染子树的大提交）。
   */
  initialMomentumMode: DanmakuV2MomentumMode;
  /**
   * 将“开关控制函数”暴露给外层。
   *
   * 注意：这是一个命令式接口，用于让外层在不触发渲染树更新的情况下控制主线程 autoScroll。
   */
  bindAutoScrollControl?: (setEnabled: (enabled: boolean) => void) => void;
  /**
   * 将“惯性模式控制函数”暴露给外层（命令式）。
   *
   * 目的：切换惯性模式时，不触发 `<list>` 子树大规模 props/事件重写。
   */
  bindMomentumModeControl?: (setMode: (mode: DanmakuV2MomentumMode) => void) => void;
  screenInfo?: ScreenInfo;
};

export type RowItem<T> = { item: T; localIndex: number };

export type NormalizeReason = "threshold" | "edge" | "final";
export type NormalizeDispatchResult =
  | "started"
  | "skip:no-el"
  | "skip:bad-base-len"
  | "skip:bad-repeat"
  | "skip:lock"
  | "skip:no-safe-band"
  | "skip:cooldown";

// Lynx List.getVisibleCells 官方返回结构（以官网为准）
export type VisibleListCell = {
  id: number;
  itemKey: string;
  /** 2.17+ 推荐使用 index */
  index: number;
  /** 历史字段（保留以便回落） */
  position: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
};
export type GetVisibleCellsResult = VisibleListCell[];
