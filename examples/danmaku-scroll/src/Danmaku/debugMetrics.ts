import type { DanmakuV2DebugMetrics, DanmakuV2SegmentInfo } from "./types";

function buildSegment(start: number, length: number): DanmakuV2SegmentInfo {
  if (length <= 0) return { start: 0, end: -1, length: 0 };
  return { start, end: start + length - 1, length };
}

export function buildDanmakuV2DebugMetrics(params: {
  rows: number;
  itemsLength: number;
  /**
   * 数据代际号（epoch）。
   *
   * 注意：返回结构为了对外兼容仍使用字段名 `dataVersion`（见 `types.ts` 的注释）。
   */
  epoch: number;
  baseLenByRow: number[];
  repeatByRow: number[];
}): DanmakuV2DebugMetrics {
  const rows = Math.max(0, Math.floor(params.rows));
  const baseLenByRow = Array.from({ length: rows }, (_, i) => Math.max(0, Math.floor(params.baseLenByRow[i] ?? 0)));
  const repeatByRow = Array.from({ length: rows }, (_, i) => Math.max(1, Math.floor(params.repeatByRow[i] ?? 1)));

  const segLenByRow = baseLenByRow.map((baseLen, i) => baseLen * repeatByRow[i]!);
  const segAByRow = segLenByRow.map((segLen) => buildSegment(0, segLen));
  const segBByRow = segLenByRow.map((segLen) => buildSegment(segLen, segLen));
  const totalListItemsByRow = segLenByRow.map((segLen) => 2 * segLen);
  const totalListItemsAllRows = totalListItemsByRow.reduce((s, v) => s + v, 0);

  return {
    rows,
    itemsLength: Math.max(0, Math.floor(params.itemsLength)),
    dataVersion: Math.max(0, Math.floor(params.epoch)),
    baseLenByRow,
    repeatByRow,
    segLenByRow,
    segAByRow,
    segBByRow,
    totalListItemsByRow,
    totalListItemsAllRows,
  };
}
