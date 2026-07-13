import { useEffect, useMemo, useRef } from "@lynx-js/react";

import type { RowItem } from "./types";

/**
 * 曝光子系统（后台线程）
 *
 * ## 这个文件负责什么
 * - 为每一行 `<list>` 生成可选的 `bindscroll` handler（仅当传入 onItemExpose 时启用）。
 * - 根据 list 的 `attachedCells` 推导“当前可见的 item”，并按 key 去重上报曝光。
 *
 * ## 数据流
 * - 输入：rowsData（按行分配后的数据）、stableGetKey（稳定 key）、onItemExpose（曝光回调）
 * - 事件：list `bindscroll` → e.detail.attachedCells → 计算 logicalIndex（按 baseLen 取模）→ 去重 → 回调上报
 *
 * ## 性能注意
 * - 默认不绑定 scroll（onItemExpose 不存在时直接返回 undefined handlers），避免无意义的事件回调开销。
 * - 去重用 Set，并在 epoch/rows 变化时重置，避免新数据被旧 key 误判为已曝光。
 */

type ListScrollEventForExposure = {
  detail?: {
    attachedCells?: Array<{
      index?: number;
      position?: number;
    }>;
  };
};

/**
 * DanmakuV2 曝光子系统（BG）
 *
 * 设计目标：
 * - 仅在传入 onItemExpose 时创建 scroll handlers，避免默认绑定 scroll 带来额外开销
 * - 同一个 item 在同一次挂载期间只上报一次（按 row 去重）
 * - handler identity 尽量稳定：通过 refs 读取 rowsData/onItemExpose，避免 rowsData 变化导致重绑
 */
export function useDanmakuV2ExposureHandlers<T>(params: {
  safeRows: number;
  /** 数据代际号（epoch）：变化时需要重置曝光去重状态 */
  epoch: number;
  rowsData: RowItem<T>[][];
  stableGetKey: (item: T) => string;
  onItemExpose?: (item: T, indexInRow: number, rowIndex: number) => void;
}) {
  const { safeRows, epoch, rowsData, stableGetKey, onItemExpose } = params;
  const enabled = !!onItemExpose;

  /**
   * 每行一个 Set，用于保证“同一 item 在一次挂载周期内只上报一次曝光”。
   * - Set 存储 stableGetKey(item)（若为空则回退 localIndex）
   */
  const exposedKeysByRowRef = useRef<Array<Set<string | number>>>([]);

  // items/rows 变化时重置曝光去重（避免新数据被旧 key 误伤）
  useEffect(() => {
    exposedKeysByRowRef.current = Array.from({ length: safeRows }, () => new Set());
  }, [epoch, safeRows]);

  const handlers = useMemo(() => {
    /**
     * 仅在需要曝光回调时创建 handlers：
     * - enabled=false → 返回全 undefined，避免绑定 scroll 带来的开销
     * - enabled=true  → 每行一个 handler
     */
    if (!enabled) return Array.from({ length: safeRows }, () => undefined);

    const next = Array.from(
      { length: safeRows },
      () => undefined as ((e: ListScrollEventForExposure) => void) | undefined,
    );

    for (let rowIndex = 0; rowIndex < safeRows; rowIndex++) {
      next[rowIndex] = (e: ListScrollEventForExposure) => {
        "background only";
        if (!onItemExpose) return;

        const rowItems = rowsData?.[rowIndex] ?? [];
        const baseLen = rowItems.length;
        if (baseLen <= 0) return;

        const exposedSet = exposedKeysByRowRef.current[rowIndex]
          ?? (exposedKeysByRowRef.current[rowIndex] = new Set());

        // 已经把该行所有 item 都曝光过了，直接跳过
        if (exposedSet.size >= baseLen) return;

        const attachedCells = e?.detail?.attachedCells;
        if (!Array.isArray(attachedCells) || attachedCells.length === 0) return;

        for (let i = 0; i < attachedCells.length; i++) {
          const c = attachedCells[i]!;
          const listIndex = typeof c.index === "number"
            ? c.index
            : typeof c.position === "number"
            ? c.position
            : null;
          if (typeof listIndex !== "number") continue;

          // listIndex 可能包含重复段/双段，按 baseLen 取模得到“逻辑 index（对应 rowsData 里的位置）”
          const logicalIndex = ((listIndex % baseLen) + baseLen) % baseLen;
          const rowItem = rowItems[logicalIndex];
          if (!rowItem) continue;

          const key = stableGetKey(rowItem.item) || rowItem.localIndex;
          if (exposedSet.has(key)) continue;

          exposedSet.add(key);
          onItemExpose(rowItem.item, logicalIndex, rowIndex);

          if (exposedSet.size >= baseLen) return;
        }
      };
    }

    return next;
  }, [enabled, onItemExpose, rowsData, safeRows, stableGetKey]);

  return handlers;
}
