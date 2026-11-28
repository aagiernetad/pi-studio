// 可信子进程入口；用户代码只交给 WASM CPython，不作为宿主 JavaScript 执行。
import { readFile } from "node:fs/promises";
import { WASI, WASISnapshotPreview1 } from "@runno/wasi";
import { fetchWASIFS } from "@runno/sandbox";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const root = new URL("./langs/", import.meta.resolve("@runno/sandbox"));
if (isMainThread) {
  let code = "";
  for await (const chunk of process.stdin) code += chunk;
  // 宿主 Runtime 意外退出后，子进程仍有自己的期限；WASM 不阻塞此 watchdog。
  const worker = new Worker(new URL(import.meta.url), { workerData: code });
  const timer = setTimeout(() => process.exit(124), 3000);
  worker.once("message", result => { process.stdout.write(JSON.stringify(result)); });
  worker.once("error", () => process.exit(1));
  worker.once("exit", code => { clearTimeout(timer); process.exitCode = code; });
} else {
  const code = workerData;
  const limit = Symbol("output limit");
  let output = "";
  let bytes = 0;
  function append(text) {
    const data = Buffer.from(text);
    output += data.subarray(0, Math.max(0, 12000 - bytes)).toString("utf8");
    bytes += data.length;
    if (bytes > 12000) throw limit;
  }

  try {
    const wasi = new WASI({
      fs: await fetchWASIFS(new URL("python-3.11.3.tar.gz", root).href),
      args: ["python", "-I", "-S", "-B", "-c", code],
      env: {}, stdin: () => null, stdout: append, stderr: append,
      debug: () => undefined, // 及时清空 Runno 内部调试缓存，不保留或记录 syscall 数据。
    });
    const imports = wasi.getImportObject();
    // 所有文件均在内存中；同时拒绝虚拟文件写入，防止文件缓冲绕过 WASM 内存上限。
    for (const api of Object.values(imports)) {
      for (const name of ["fd_allocate", "fd_filestat_set_size", "fd_filestat_set_times", "fd_pwrite", "fd_renumber",
        "path_create_directory", "path_filestat_set_times", "path_link", "path_rename", "path_symlink", "path_remove_directory", "path_unlink_file"]) {
        api[name] = () => WASISnapshotPreview1.Result.EROFS;
      }
      const write = api.fd_write;
      api.fd_write = (fd, ...args) => fd === 1 || fd === 2 ? write(fd, ...args) : WASISnapshotPreview1.Result.EROFS;
      const open = api.path_open;
      api.path_open = (fd, flags, path, length, oflags, rights, ...args) =>
        (oflags & 13) || (rights & 64n) ? WASISnapshotPreview1.Result.EROFS : open(fd, flags, path, length, oflags, rights, ...args);
    }
    const binary = await readFile(new URL("python-3.11.3.wasm", root));
    const result = wasi.start(await WebAssembly.instantiate(binary, imports));
    parentPort.postMessage({ exitCode: result.exitCode, output });
  } catch (cause) {
    parentPort.postMessage({ exitCode: 1, output: cause === limit ? output + "\n[Python output limit reached]" : "Python sandbox could not execute the script." });
  }
}
