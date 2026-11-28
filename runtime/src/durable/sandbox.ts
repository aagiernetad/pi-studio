import { CodemodeSandbox, parseCodemodeSource } from "@earendil-works/pi-codemode";
import { createCodemodeExtension, createCodemodeTool } from "@earendil-works/pi-durable/codemode";

const TIMEOUT_MS = 3000;
const MAX_OUTPUT_TOKENS = 1024;

/** 原生 QuickJS / WASM 沙箱；不注入宿主文件、Shell、网络或 Models 能力。 */
export function createSandbox() {
  let workers = 0;
  const sandbox = new CodemodeSandbox({
    memoryLimitBytes: 32 * 1024 * 1024,
    acquireWorker() {
      if (workers >= 2) throw new Error("Sandbox is busy; try again later.");
      workers++;
      // 直到 worker 真正退出才释放名额，超时返回不意味着线程已退出。
      return () => { workers--; };
    },
  });
  const native = createCodemodeExtension({ sandbox, models: false });
  const tool = createCodemodeTool({ sandbox, models: false });
  return {
    extension: {
      ...native,
      tools: [{
        ...tool,
        description: tool.description + "\nHost limits: 3 seconds, 32 MiB VM memory, 1024 output tokens. No filesystem, shell, network, models or host tools are available.",
        executionMode: "sequential" as const,
        outputLimits: { maxBytes: 16 * 1024, maxLines: 200 },
        async execute(args, api, context) {
          if (args.code.length > 16000) return { isError: true, output: [{ type: "text", text: "Sandbox script exceeds 16000 characters." }] };
          const { code, options } = parseCodemodeSource(args.code);
          // 原生 start() 不使用构造器的默认期限；必须在 Durable 的源码选项中强制设上限。
          const limits = {
            timeout_ms: Math.min(options.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS),
            max_output_tokens: Math.min(options.maxOutputTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
          };
          return tool.execute({ code: `// @options: ${JSON.stringify(limits)}\n${code}` }, api, context);
        },
      } satisfies typeof tool],
    } satisfies ReturnType<typeof createCodemodeExtension>,
    close: () => sandbox.close(),
  };
}
