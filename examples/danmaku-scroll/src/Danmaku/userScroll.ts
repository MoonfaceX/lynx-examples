import { useCallback } from "@lynx-js/react";

import { TAP_MAX_DELTA_PX, TAP_MAX_DURATION_MS } from "./utils";

export type DanmakuV2UserScrollPayload = {
  velocityX: number;
  totalDeltaAbsPx: number;
  durationMs: number;
};

/**
 * 用户主动滚动上报（BG）
 *
 * 设计目标：
 * - 主线程只负责在手势结束时派发一次 payload（JSON 可序列化）
 * - BG 负责 tap 过滤与调用 onUserScroll（避免在主线程读取 props 函数引用）
 */
export function useDanmakuV2UserScrollReporter(
  onUserScroll?: (info: DanmakuV2UserScrollPayload) => void,
) {
  return useCallback(
    (payload: DanmakuV2UserScrollPayload) => {
      "background only";
      const isTap = payload.totalDeltaAbsPx < TAP_MAX_DELTA_PX && payload.durationMs < TAP_MAX_DURATION_MS;
      if (isTap) return;
      onUserScroll?.(payload);
    },
    [onUserScroll],
  );
}
