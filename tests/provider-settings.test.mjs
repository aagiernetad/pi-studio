import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";

let server, browser, url;
before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(run) {
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => {
      const state = window.fixture = { calls: [], stored: {}, configs: {}, failSave: false, delay: 0 };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args = {}) => {
          state.calls.push(command);
          if (command.startsWith("plugin:event|")) return 1;
          if (command === "runtime_info") return { name: "test", platform: "test", nodeVersion: "test", pid: 1, uptime: 0 };
          if (command === "conversation_list") return { items: [], nextCursor: null };
          if (command === "provider_list") return { items: [
            { id: "deepseek", name: "DeepSeek", supportsApiKey: true },
            { id: "other", name: "Other", supportsApiKey: true },
            { id: "oauth", name: "OAuth", supportsApiKey: false },
            ...Object.values(state.configs).map(item => ({ id: item.id, name: item.name, supportsApiKey: true })),
          ] };
          if (command === "provider_config_list") return { items: Object.values(state.configs) };
          if (command === "provider_config_set") {
            state.configs[args.config.id] = { ...args.config };
            return args.config;
          }
          if (command === "provider_config_delete") { delete state.configs[args.providerId]; return { deleted: true }; }
          if (command === "model_list") {
            if (args.providerId === "deepseek" && state.delay) await new Promise(r => setTimeout(r, state.delay));
            return { items: [{ id: state.configs[args.providerId]?.modelId ?? args.providerId + "-model", name: args.providerId, contextWindow: 64000, maxTokens: 4096, supportsConnectionTest: args.providerId !== "oauth" }] };
          }
          const status = () => ({ providerId: args.providerId, stored: !!state.stored[args.providerId], type: state.stored[args.providerId] ? "api_key" : null });
          if (command === "provider_credential_status") return status();
          if (command === "provider_credential_set") {
            if (state.holdSave) await new Promise(resolve => { state.releaseSave = resolve; });
            if (state.failSave) throw "UNKNOWN: synthetic-secret-marker";
            state.stored[args.providerId] = true;
            return status();
          }
          if (command === "provider_credential_delete") { delete state.stored[args.providerId]; return status(); }
          if (command === "provider_test") return { connected: true, durationMs: 12 };
          throw "Unexpected command: " + command;
        },
      };
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.getByText("服务商设置", { exact: true }).click();
    await page.getByLabel("API Key", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.provider-editor[aria-busy="true"]'));
    await run(page, page.locator(".provider-settings"));
  } finally { await context.close(); }
}

test("保存、测试和删除凭据，密钥清空且不进入浏览器持久存储", async () => fixture(async (page, panel) => {
  const key = panel.getByLabel("API Key", { exact: true });
  assert.equal(await panel.getByRole("button", { name: "测试连接", exact: true }).isDisabled(), true);
  await key.fill("synthetic-ui-key");
  await panel.getByRole("button", { name: "保存 API Key", exact: true }).click();
  await panel.getByText("API Key 已保存到 Windows 凭据管理器。", { exact: true }).waitFor();
  assert.equal(await key.inputValue(), "");
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  await panel.getByRole("button", { name: "测试连接", exact: true }).click();
  await panel.getByText("连接成功，用时 12 毫秒。", { exact: true }).waitFor();
  await key.fill("unsaved-replacement");
  assert.equal(await panel.getByRole("button", { name: "测试连接", exact: true }).isDisabled(), true);
  await panel.getByRole("button", { name: "删除已保存凭据", exact: true }).click();
  await panel.getByText("已删除该服务商保存的凭据。", { exact: true }).waitFor();
  assert.equal(await key.inputValue(), "");
}));

test("服务商切换丢弃未保存密钥，迟到的模型结果不能覆盖新选择", async () => fixture(async (page, panel) => {
  await panel.getByLabel("API Key", { exact: true }).fill("unsaved-key");
  await page.evaluate(() => { window.fixture.delay = 400; });
  await panel.getByRole("button", { name: "刷新状态", exact: true }).click();
  await panel.getByLabel("服务商", { exact: true }).selectOption("other");
  await page.waitForTimeout(500);
  assert.equal(await panel.getByLabel("用于测试的模型").inputValue(), "other-model");
  assert.equal(await panel.getByLabel("API Key", { exact: true }).inputValue(), "");
  await panel.getByLabel("API Key", { exact: true }).fill("discard-on-collapse");
  await page.getByText("服务商设置", { exact: true }).click();
  await page.getByText("服务商设置", { exact: true }).click();
  assert.equal(await panel.getByLabel("API Key", { exact: true }).inputValue(), "");
}));

test("保存失败隐藏原始异常，重新查询状态后才能重试", async () => fixture(async (page, panel) => {
  await page.evaluate(() => { window.fixture.failSave = true; });
  await panel.getByLabel("API Key", { exact: true }).fill("synthetic-secret-marker");
  await panel.getByRole("button", { name: "保存 API Key", exact: true }).click();
  await panel.getByRole("alert").waitFor();
  assert.equal((await panel.innerText()).includes("synthetic-secret-marker"), false);
  assert.equal(await panel.getByLabel("API Key", { exact: true }).inputValue(), "");
  assert.equal(await panel.getByLabel("API Key", { exact: true }).isDisabled(), true);
  await panel.getByRole("button", { name: "刷新状态", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.provider-editor[aria-busy="true"]'));
  assert.equal(await panel.getByLabel("API Key", { exact: true }).isEnabled(), true);
  await panel.getByLabel("服务商", { exact: true }).selectOption("oauth");
  await panel.getByText("该服务商需要 OAuth 或其他配置，当前设置面板仅支持 API Key。", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "测试连接", exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.fixture.calls.includes("provider_test")), false);
}));

test("保存期间阻止切换和重复提交，完成后恢复操作", async () => fixture(async (page, panel) => {
  await page.evaluate(() => { window.fixture.holdSave = true; });
  await panel.getByLabel("API Key", { exact: true }).fill("synthetic-delayed-key");
  await panel.getByRole("button", { name: "保存 API Key", exact: true }).click();
  assert.equal(await panel.getByLabel("服务商", { exact: true }).isDisabled(), true);
  assert.equal(await panel.getByRole("button", { name: "正在保存...", exact: true }).isDisabled(), true);
  assert.equal(await panel.getByLabel("API Key", { exact: true }).inputValue(), "");
  await page.getByText("服务商设置", { exact: true }).click();
  await page.getByText("服务商设置", { exact: true }).click();
  assert.equal(await panel.getByRole("button", { name: "正在保存...", exact: true }).isDisabled(), true);
  await page.evaluate(() => window.fixture.releaseSave());
  await panel.getByText("API Key 已保存到 Windows 凭据管理器。", { exact: true }).waitFor();
  assert.equal(await panel.getByLabel("服务商", { exact: true }).isEnabled(), true);
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(c => c === "provider_credential_set").length), 1);
}));

test("自定义配置新建、编辑和删除接入现有服务商列表，删除不触碰凭据", async () => fixture(async (page, panel) => {
  await panel.getByRole("button", { name: "自定义配置", exact: true }).click();
  await panel.getByLabel("配置标识", { exact: true }).fill("custom-ui");
  await panel.getByLabel("显示名称", { exact: true }).fill("UI test");
  await panel.getByLabel("API 基础地址", { exact: true }).fill("https://example.test/v1");
  await panel.getByLabel("模型 ID", { exact: true }).fill("custom-model");
  await panel.getByRole("button", { name: "保存配置", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="服务商"]')?.value === "custom-ui");
  assert.equal(await panel.getByLabel("用于测试的模型").inputValue(), "custom-model");
  await panel.getByRole("button", { name: "自定义配置", exact: true }).click();
  await panel.getByLabel("编辑配置", { exact: true }).selectOption("custom-ui");
  assert.equal(await panel.getByLabel("配置标识").getAttribute("readonly"), "");
  assert.equal(await panel.getByLabel("API 基础地址").inputValue(), "https://example.test/v1");
  await panel.getByLabel("模型 ID").fill("updated-model");
  await panel.getByRole("button", { name: "保存配置", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="用于测试的模型"]')?.value === "updated-model");
  await page.evaluate(() => { window.fixture.stored["custom-ui"] = true; });
  await panel.getByRole("button", { name: "自定义配置", exact: true }).click();
  await panel.getByLabel("编辑配置", { exact: true }).selectOption("custom-ui");
  await panel.getByRole("button", { name: "删除配置（保留凭据）", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="服务商"]')?.value === "deepseek");
  assert.equal(await page.evaluate(() => window.fixture.stored["custom-ui"]), true);
  assert.equal(await panel.getByLabel("服务商").locator('option[value="custom-ui"]').count(), 0);
  assert.equal(await page.evaluate(() => window.fixture.calls.includes("provider_test")), false);
}));
