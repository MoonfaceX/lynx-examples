import { useMemo } from "@lynx-js/react";

import type { RowItem } from "./types";
import { distributeFeaturedFirst, distributeRoundRobin } from "./utils";

/**
 * DanmakuV2 的 `dataEpoch（epoch）` 机制说明（务必阅读）
 *
 * ## 这不是“多此一举”，而是 Lynx 双线程 + `<list>` 复用模型下的必要门禁
 * DanmakuV2 的核心运行时事实（来自 Lynx 官方文档）：
 * - **双线程**：BG（React/JS）与 MT（Main Thread Script/worklet）同时参与渲染与交互。
 * - **跨线程调用是异步 Promise**：`runOnMainThread` / `runOnBackground` 都返回 Promise；
 * - **主线程节点操作是异步 Promise**：`MainThread.Element.invoke()` 返回 Promise，可能 reject；
 * - **`<list>` 的 UI 节点是按需创建 + 复用（node reuse）**：JS 实例存在 ≠ UI 节点存在；
 * - **主线程函数捕获值不是实时同步**：捕获变量只会在组件 rerender 后从 BG 同步到 MT。
 *
 * 上述约束共同导致：在 commit 前后、实例替换（例如某行 `<list>` remount）、以及主线程
 * `invoke()`/rAF 状态机运行期间，**事件/Promise 结果可能迟到或乱序**。
 *
 * 因此我们必须引入“代际门禁（epoch）”：
 * - 让主线程在落地任何副作用（ready 标记、normalize、autoScroll start/stop 等）前先校验：
 *   “这条事件/Promise 结果是否仍属于当前代际/当前实例？”不属于则 **无害早退**。
 *
 * ## 为什么不能“直接重置整个组件（remount）”来替代？
 * remount 只能替换 BG 的渲染树与 JS 对象，但它 **不等价于取消**：
 * - 已经发起的 `MainThread.Element.invoke()`（Promise 仍可能 resolve/reject）
 * - 已经调度的主线程 rAF 轮询状态机
 * - `<list>` 复用窗口期里迟到的阈值/边界/布局等事件
 *
 * 如果没有 epoch 门禁，迟到结果就可能写坏“新代际”的主线程状态机，表现为：
 * - 新数据下莫名 normalize 跳动 / autoScroll 误启动或误恢复 / 卡死在等待门禁
 * - 或出现大量 invoke reject（因为错误地把“旧实例 ready”当成“新实例 ready”）
 *
 * ## 我们的选择：epoch 由业务侧显式传入（严格语义、避免内部 hash）
 * - DanmakuV2 对外暴露 `dataEpoch`（见 `types.ts`），业务侧负责在“数据语义变化”时推进它：
 *   - items 的 key 序列（length/顺序/任一 key）变化
 *   - rows（safeRows）变化
 * - DanmakuV2 内部只做两件事：
 *   - 用 epoch 驱动主线程门禁与子系统重置
 *   - 渲染层派生 rowsData/rowBaseLens 等纯函数数据
 *
 * 重要：epoch 不应因“局部可收敛的变化”（例如 repeat 提升导致单行 `<list>` remount）而推进，
 * 否则会把本应局部重建的成本扩大成全量重置。
 */

/**
 * rowsData：将 items 按 rows 分配为二维数组（多行弹幕）。
 *
 * 当传入 isFeatured 时使用"精选优先第一行"策略，否则使用默认轮询分配。
 */
export function useDanmakuV2RowsData<T>(params: {
  items: T[];
  safeRows: number;
  isFeatured?: (item: T) => boolean;
}) {
  const { items, safeRows, isFeatured } = params;
  return useMemo(() => {
    return isFeatured
      ? distributeFeaturedFirst(items, safeRows, isFeatured)
      : distributeRoundRobin(items, safeRows);
  }, [items, safeRows, isFeatured]);
}

/**
 * rowBaseLens：每行 baseLen（未 repeat 前的 item 数量）。
 */
export function useDanmakuV2RowBaseLens<T>(rowsData: RowItem<T>[][]) {
  return useMemo(() => rowsData.map((row) => row.length), [rowsData]);
}
