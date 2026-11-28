import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { z } from "zod";

const Input = z.object({ code: z.string().min(1).max(16000) }).strict();
const Result = z.object({ exitCode: z.number().int().min(0).max(255), output: z.string().max(16000) }).strict();
const text = (output: string, isError = true): ToolExecutionResult => ({ output: [{ type: "text", text: output }], isError });

export function pythonTool(acquire: () => () => void) {
  return defineTool({
    name: "python",
    description: "Run isolated Python 3.11 code. Use print() to return results. Standard library only; no packages, host files, file writes, network, subprocesses or credentials. Fresh state each call. Limits: 3 seconds, 256 MiB WASM memory, 12000 output bytes, 16000 code characters.",
    parameters: { type: "object", properties: { code: { type: "string", minLength: 1, maxLength: 16000 } }, required: ["code"], additionalProperties: false },
    callers: ["model"], replay: "safe", executionMode: "sequential",
    outputLimits: { maxBytes: 16 * 1024, maxLines: 200 },
    async execute(args, _api, context) {
      const input = Input.safeParse(args);
      if (!input.success) return text("Invalid Python script.");
      context.abortSignal?.throwIfAborted();
      const release = acquire();
      try {
        return await new Promise<ToolExecutionResult>(resolve => {
          // 独立可信 Node 进程提供 WASM 与 V8 内存上限；不启动本机 Python / Shell。
          const child = spawn(process.execPath, ["--max-old-space-size=128", "--wasm-max-mem-pages=4096",
            fileURLToPath(new URL("./python-runner.mjs", import.meta.url))], { env: {}, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
          let output = "";
          let bytes = 0;
          let failure = "";
          const stop = (message: string) => { failure ||= message; child.kill(); };
          const abort = () => stop("Python execution stopped.");
          const timer = setTimeout(() => stop("Python execution timed out (3 seconds)."), 3000);
          context.abortSignal?.addEventListener("abort", abort, { once: true });
          if (context.abortSignal?.aborted) abort();
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 128 * 1024) stop("Python output limit reached.");
            else output += chunk;
          });
          child.stderr.resume(); // 宿主诊断不进入 Transcript 或日志。
          child.stdin.on("error", () => {}); // 超时或提前退出时 EPIPE 由 close 统一处理。
          child.on("error", () => { failure = "Python sandbox is unavailable."; });
          child.once("close", code => {
            clearTimeout(timer);
            context.abortSignal?.removeEventListener("abort", abort);
            if (failure || code !== 0) { resolve(text(failure || "Python sandbox exceeded its limits or could not start.")); return; }
            try {
              const result = Result.parse(JSON.parse(output));
              resolve(text(result.output || (result.exitCode === 0 ? "Python completed without output." : "Python script failed."), result.exitCode !== 0));
            } catch { resolve(text("Python sandbox returned an invalid result.")); }
          });
          child.stdin.end(input.data.code);
        });
      } finally { release(); } // 等到进程真正关闭后释放共享执行名额。
    },
  });
}
