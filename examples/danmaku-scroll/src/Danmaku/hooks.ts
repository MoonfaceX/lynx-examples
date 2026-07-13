import { useCallback, useEffect, useRef } from "@lynx-js/react";

/**
 * DanmakuV2 内部 hooks（仅用于组件实现，不建议业务层直接依赖）
 *
 * 目标：
 * - 把“引用稳定但语义最新”的回调包装逻辑集中起来，减少样板代码与出错概率。
 * - 用于配合 memo：避免仅因为父组件 rerender 导致函数 props 引用变化，从而触发大渲染子树重渲染。
 */

/**
 * useLatestRef：保存“最新值”的 ref。
 *
 * - `ref.current` 始终指向最新的 value
 * - 返回的 ref 对象本身在组件生命周期内稳定
 *
 * 注意：
 * - 这里使用 useEffect 同步，而不是在 render 期间直接写 ref，
 *   是为了规避项目里对“render 期间写 ref”可能存在的 lint 约束。
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

/**
 * useStableCallback：把一个函数包装为“引用稳定但语义最新”的回调。
 *
 * - 返回函数的 identity 恒定（空依赖 useCallback）
 * - 返回函数内部永远调用最新的 fn（通过 ref.current）
 *
 * 典型用途：
 * - renderItem / getItemKey / onItemClick 等函数型 props
 * - 防止父组件 rerender 造成函数引用变化，进而打破 memo 与触发昂贵提交
 */
export function useStableCallback<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult,
) {
  const fnRef = useLatestRef(fn);
  return useCallback((...args: TArgs) => {
    return fnRef.current(...args);
  }, []);
}

/**
 * useStableOptionalCallback：可选回调的稳定包装。
 *
 * - fn 为空时执行 fallback（例如 no-op 或返回默认值）
 * - fn 存在时执行 fn
 *
 * 返回值的 identity 恒定，语义随 fn 变化而更新。
 */
export function useStableOptionalCallback<TArgs extends unknown[], TResult>(
  fn: ((...args: TArgs) => TResult) | undefined,
  fallback: (...args: TArgs) => TResult,
) {
  const fnRef = useLatestRef(fn);
  const fallbackRef = useLatestRef(fallback);
  return useCallback((...args: TArgs) => {
    const f = fnRef.current;
    if (f) return f(...args);
    return fallbackRef.current(...args);
  }, []);
}
