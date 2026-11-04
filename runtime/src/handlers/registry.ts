
import type { RuntimeHandler } from "./types.js";

/**
 * Handler 注册中心。
 *
 * 职责：
 * 1. 注册 Handler
 * 2. 检查重复注册
 * 3. 根据 method 查找 Handler
 * 4. 支持注销 Handler
 * 5. 提供已注册方法列表
 */
export class RuntimeHandlerRegistry {
  private readonly handlers = new Map<string, RuntimeHandler>();

  /**
   * 注册 Handler。
   */
  register(method: string, handler: RuntimeHandler): void {
    const normalizedMethod = method.trim();

    if (
      !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(normalizedMethod)
    ) {
      throw new Error(`Invalid handler method: ${method}`);
    }

    if (this.handlers.has(normalizedMethod)) {
      throw new Error(
        `Handler already registered: ${normalizedMethod}`,
      );
    }

    this.handlers.set(normalizedMethod, handler);
  }

  /**
   * 根据方法名称获取 Handler。
   */
  resolve(method: string): RuntimeHandler | undefined {
    return this.handlers.get(method);
  }

  /**
   * 判断 Handler 是否存在。
   */
  has(method: string): boolean {
    return this.handlers.has(method);
  }

  /**
   * 注销 Handler。
   */
  unregister(method: string): boolean {
    return this.handlers.delete(method);
  }

  /**
   * 返回所有已经注册的方法。
   */
  listMethods(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
