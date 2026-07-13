/**
 * DanmakuV2 phase subscribe（轻量订阅，不触发 React 渲染）
 *
 * 设计目标：
 * - 对外暴露 DanmakuV2 的首屏 phase（bootstrap/padding/ready）变化；
 * - subscribe 本身不引起任何组件重渲染；
 * - 订阅方如果需要更新 UI，应自行在回调中 setState（且 phase 变化频率很低）。
 *
 * 订阅规则：
 * - phase/epoch 任一变化都会发布；
 * - ready -> ready 不发布；
 * - 为避免“初始即 ready”漏报：subscribe 时会立即以当前快照触发一次回调（若已有快照）。
 *
 * 注意：
 * - 这是一个模块级单例（无多实例隔离）；当前页面若同时存在多个 DanmakuV2，会以“最后发布者”为准。
 * - `publishDanmakuV2PhaseSnapshot` 仅供 DanmakuV2 内部调用，不建议业务层直接调用。
 */

export type DanmakuV2FirstScreenPhase = "bootstrap" | "padding" | "ready";

export type DanmakuV2PhaseSnapshot = {
  phase: DanmakuV2FirstScreenPhase;
};

type Listener = (next: DanmakuV2PhaseSnapshot, prev: DanmakuV2PhaseSnapshot | null) => void;

let currentSnapshot: DanmakuV2PhaseSnapshot | null = null;
const listeners = new Set<Listener>();

export function getDanmakuV2PhaseSnapshot(): DanmakuV2PhaseSnapshot | null {
  return currentSnapshot;
}

export function subscribeDanmakuV2Phase(callback: Listener) {
  listeners.add(callback);

  // 立即对齐当前快照：避免订阅发生在 ready 之后导致漏报
  if (currentSnapshot) {
    try {
      callback(currentSnapshot, null);
    } catch {
      // ignore
    }
  }

  return () => {
    listeners.delete(callback);
  };
}

export function publishDanmakuV2PhaseSnapshot(next: DanmakuV2PhaseSnapshot) {
  const prev = currentSnapshot;
  if (prev && prev.phase === next.phase) return;

  currentSnapshot = next;

  listeners.forEach((fn) => {
    try {
      fn(next, prev);
    } catch {
      // ignore
    }
  });
}
