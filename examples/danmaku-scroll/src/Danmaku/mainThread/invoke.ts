import type { MainThread } from "@lynx-js/types";

/**
 * 主线程元素方法调用工具（兼容 invokeWithCallback 和 invoke）
 *
 * ## 背景
 * Lynx 的 MainThread.Element 有两种调用方式：
 * - `invokeWithCallback(method, params, onSuccess, onError)` - 回调模式
 * - `invoke(method, params)` - 返回 Promise
 *
 * 不同 Lynx 版本可能只支持其中一种，因此需要统一处理兼容性。
 *
 * ## 用法
 * ```typescript
 * invokeListMethod(el, 'autoScroll', { start: true }, {
 *   onSuccess: () => { console.log('成功'); },
 *   onError: (e) => { console.error('失败', e); },
 * });
 * ```
 */

type InvokeParams = Record<string, unknown>;

/** Signature of the legacy `invokeWithCallback` method on a main thread element. */
type InvokeWithCallbackFn = (
  method: string,
  params: InvokeParams,
  onSuccess: () => void,
  onError: (error: unknown) => void,
) => void;

interface InvokeOptions {
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

/**
 * 统一的 list 元素方法调用函数
 *
 * 优先使用 invokeWithCallback，不存在则 fallback 到 invoke + Promise
 */
export function invokeListMethod(
  el: MainThread.Element,
  method: string,
  params: InvokeParams,
  options?: InvokeOptions,
): void {
  "main thread";

  const elWithCallback = el as MainThread.Element & {
    invokeWithCallback?: InvokeWithCallbackFn;
  };

  if (typeof elWithCallback.invokeWithCallback === "function") {
    elWithCallback.invokeWithCallback(
      method,
      params,
      () => {
        options?.onSuccess?.();
      },
      (error) => {
        options?.onError?.(error);
      },
    );
  } else {
    // fallback: 使用 invoke + Promise
    try {
      const ret = el.invoke(method, params) as unknown as Promise<void> | void;

      if (ret && typeof (ret as Promise<void>).then === "function") {
        (ret as Promise<void>)
          .then(() => {
            options?.onSuccess?.();
          })
          .catch((error) => {
            options?.onError?.(error);
          });
      } else {
        // 同步完成（无返回值或非 Promise）
        options?.onSuccess?.();
      }
    } catch (error) {
      options?.onError?.(error);
    }
  }
}

/**
 * 检查当前环境是否支持 invokeWithCallback
 */
export function hasInvokeWithCallback(el: MainThread.Element): boolean {
  "main thread";
  const elWithCallback = el as MainThread.Element & {
    invokeWithCallback?: InvokeWithCallbackFn;
  };
  return typeof elWithCallback.invokeWithCallback === "function";
}
