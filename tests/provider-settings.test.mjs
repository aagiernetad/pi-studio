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

async function fixture(run, withChat = false) {
  const context = await browser.newContext();
  try {
    await context.addInitScript((chat) => {
      const state = window.fixture = { calls: [], stored: {}, configs: {}, failSave: false, delay: 0,
        entries: { 1: [], 2: [] }, statuses: {}, submissions: {}, submitArgs: [], resumeArgs: [], renameArgs: [], resetArgs: [], forkArgs: [], forks: {},
        usages: {}, conversations: chat ? [{ id: 1, title: "会话甲", createdAt: 1 }, { id: 2, title: "会话乙", createdAt: 2 }] : [] };
      const chatStatus = (id) => state.statuses[id] ??= { running: false, latestEntryId: null, partialText: "", model: null, failureReason: null, canResume: false, contextReset: false };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args = {}) => {
          state.calls.push(command);
          if (command.startsWith("plugin:event|")) return 1;
          if (command === "plugin:opener|open_url") { state.openedUrl = args.url; return; }
          if (command === "runtime_ping") return { message: args.message, runtime: "test", pid: 1 };
          if (command === "runtime_info") return { name: "test", platform: "test", nodeVersion: "test", pid: 1, uptime: 0 };
          if (command === "conversation_list") {
            const all = state.conversations.filter(item => (!args.beforeId || item.id < args.beforeId) && item.title.toLowerCase().includes((args.query ?? '').toLowerCase()));
            const items = structuredClone(all.slice(0, args.limit ?? 20));
            const result = { items, nextBeforeId: all.length > items.length ? items.at(-1).id : null };
            if (args.beforeId && state.holdConversationPage) return new Promise(resolve => { state.releaseConversationPage = () => resolve(result); });
            return result;
          }
          if (command === "conversation_fork") {
            const input = args.input;
            state.forkArgs.push(structuredClone(input));
            if (state.forks[input.requestId]) return { conversation: structuredClone(state.forks[input.requestId]) };
            if (state.holdFork) await new Promise(resolve => { state.releaseFork = resolve; });
            const source = state.conversations.find(item => item.id === input.conversationId);
            const id = Math.max(0, ...state.conversations.map(item => item.id)) + 1;
            const item = { id, title: source.title + '（分支）', createdAt: id,
              forkedFrom: { conversationId: input.conversationId, entryId: input.entryId } };
            state.conversations.unshift(item);
            state.forks[input.requestId] = item;
            state.entries[id] = structuredClone(state.entries[input.conversationId].filter(entry => entry.id <= input.entryId));
            state.statuses[id] = { ...chatStatus(input.conversationId), running: false, failureReason: null, canResume: false,
              latestEntryId: input.entryId, contextReset: false };
            if (state.failForkOnce) { state.failForkOnce = false; throw 'IPC_TIMEOUT: synthetic-fork-private'; }
            return { conversation: structuredClone(item) };
          }
          if (command === "conversation_rename") {
            state.renameArgs.push(structuredClone(args));
            const item = state.conversations.find(item => item.id === args.conversationId);
            if (state.holdRename) await new Promise(resolve => { state.releaseRename = resolve; });
            item.title = args.title;
            if (state.failRenameOnce) { state.failRenameOnce = false; throw 'IPC_TIMEOUT: synthetic-rename-private'; }
            return { conversation: structuredClone(item) };
          }
          if (command === "conversation_usage") {
            const all = (state.usages[args.conversationId] ?? []).filter(item => !args.afterModel || item.model > args.afterModel);
            const items = structuredClone(all.slice(0, args.limit ?? 20));
            const result = { items, nextAfterModel: all.length > items.length ? items.at(-1).model : null };
            if (args.afterModel && state.holdUsagePage) return new Promise(resolve => { state.releaseUsagePage = () => resolve(result); });
            if (!args.afterModel && state.holdUsageFor === args.conversationId) return new Promise(resolve => { state.releaseUsage = () => resolve(result); });
            return result;
          }
          if (command === "conversation_entries") {
            if (state.realEntryPages) {
              const all = [...(state.entries[args.conversationId] ?? [])].filter(entry => entry.id < (args.cursor?.before ?? Infinity)).sort((a, b) => b.id - a.id);
              const items = structuredClone(all.slice(0, args.limit ?? 10));
              const result = { items, nextCursor: all.length > items.length ? { before: items.at(-1).id } : null };
              if (args.cursor && state.overlapEntry) result.items.push(structuredClone(state.overlapEntry));
              return result;
            }
            if (args.cursor && state.holdOlder) return new Promise(resolve => { state.releaseOlder = () => resolve({ items: [{ id: 99, kind: "probe", data: "不应混入的旧页", model: null }], nextCursor: null }); });
            return { items: [...(state.entries[args.conversationId] ?? [])], nextCursor: state.paginated ? { before: 1 } : null };
          }
          if (command === "conversation_chat_status") {
            const result = structuredClone(chatStatus(args.conversationId));
            if (state.holdStatus === args.conversationId) await new Promise(resolve => { state.releaseStatus = resolve; });
            return result;
          }
          if (command === "conversation_chat_submit") {
            const input = args.input;
            state.submitArgs.push(structuredClone(input));
            if (state.submissions[input.requestId]) return { submissionId: state.submissions[input.requestId] };
            const id = Object.keys(state.submissions).length + 1;
            state.submissions[input.requestId] = id;
            const current = chatStatus(input.conversationId);
            current.model = { providerId: input.providerId, modelId: input.modelId };
            current.running = !!state.slowChat;
            current.canResume = false;
            current.contextReset = false;
            current.partialText = state.slowChat ? "正在回复" : "";
            current.latestEntryId = id * 2;
            state.entries[input.conversationId] = [
              ...(state.slowChat ? [] : [{ id: id * 2, kind: "pi.assistant", data: null, model: [{ role: "assistant", content: [{ type: "text", text: "本地页面回复" }], stopReason: "stop" }] }]),
              { id: id * 2 - 1, kind: "studio.chat-input", data: {}, model: [{ role: "user", content: input.content }] },
            ];
            if (state.failSubmitOnce) { state.failSubmitOnce = false; throw "IPC_TIMEOUT: synthetic-private-marker"; }
            return { submissionId: id };
          }
          if (command === "conversation_chat_resume") {
            const input = args.input;
            state.resumeArgs.push(structuredClone(input));
            if (state.submissions[input.requestId]) return { submissionId: state.submissions[input.requestId] };
            const current = chatStatus(input.conversationId);
            if (!current.canResume) throw "CHAT_NOT_RESUMABLE: no failed answer";
            const id = Object.keys(state.submissions).length + 1;
            state.submissions[input.requestId] = id;
            Object.assign(current, { running: false, canResume: false, failureReason: null, partialText: "", latestEntryId: 100 + id });
            state.entries[input.conversationId].unshift({ id: 100 + id, kind: "pi.assistant", data: null, model: [{ role: "assistant", content: [{ type: "text", text: "继续后的回复" }], stopReason: "stop" }] });
            if (state.resumeLostOnce) { state.resumeLostOnce = false; throw "IPC_TIMEOUT: synthetic-resume-private"; }
            return { submissionId: id };
          }
          if (command === "conversation_chat_abort") { Object.assign(chatStatus(args.conversationId), { running: false, partialText: "", failureReason: "aborted", canResume: true }); return { stopped: true }; }
          if (command === "conversation_context_reset") {
            const input = args.input;
            state.resetArgs.push(structuredClone(input));
            if (state.submissions[input.requestId]) return { submissionId: state.submissions[input.requestId], entryId: 200 + state.submissions[input.requestId] };
            if (state.holdReset) await new Promise(resolve => { state.releaseReset = resolve; });
            const current = chatStatus(input.conversationId);
            if (current.running) throw 'CONVERSATION_BUSY: busy';
            const id = Object.keys(state.submissions).length + 1;
            state.submissions[input.requestId] = id;
            Object.assign(current, { contextReset: true, canResume: false, failureReason: null, latestEntryId: 200 + id });
            state.entries[input.conversationId].unshift({ id: 200 + id, kind: 'pi.reset', data: null, model: null });
            if (state.failResetOnce) { state.failResetOnce = false; throw 'IPC_TIMEOUT: synthetic-reset-private'; }
            return { submissionId: id, entryId: 200 + id };
          }
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
            return { items: [{ id: state.configs[args.providerId]?.modelId ?? args.providerId + "-model", name: args.providerId, api: "openai-completions", contextWindow: 64000, maxTokens: 4096, supportsConnectionTest: args.providerId !== "oauth" }] };
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
    }, withChat);
    const page = await context.newPage();
    await page.goto(url);
    if (withChat) {
      await page.getByLabel("消息内容", { exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息内容"]').disabled);
    } else {
      await page.getByRole("navigation", { name: "工作区导航" }).getByRole("button", { name: "服务商", exact: true }).click();
      await page.getByLabel("API Key", { exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('.provider-editor[aria-busy="true"]'));
    }
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

test("聊天超时重试保留同一请求，历史直接显示消息正文", async () => fixture(async (page) => {
  const chat = page.locator('.chat-panel');
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息内容"]')?.disabled);
  await page.evaluate(() => { window.fixture.failSubmitOnce = true; });
  await chat.getByLabel('消息内容').fill('页面聊天消息');
  await chat.getByRole('button', { name: '发送消息', exact: true }).click();
  await chat.getByRole('button', { name: '重试同一请求', exact: true }).waitFor();
  assert.equal(await chat.getByLabel('消息内容').isDisabled(), true);
  assert.equal((await chat.innerText()).includes('synthetic-private-marker'), false);
  await chat.getByRole('button', { name: '重试同一请求', exact: true }).click();
  await page.locator('.transcript-list').getByText('本地页面回复', { exact: true }).waitFor();
  const args = await page.evaluate(() => window.fixture.submitArgs);
  assert.equal(args.length, 2);
  assert.equal(args[0].requestId, args[1].requestId);
  assert.equal(await page.evaluate(() => Object.keys(window.fixture.submissions).length), 1);
  assert.equal(await chat.getByLabel('消息内容').inputValue(), '');
}, true));

test("切换会话不终止原生成，迟到状态不覆盖当前会话，返回后可停止", async () => fixture(async (page) => {
  const chat = page.locator('.chat-panel');
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息内容"]')?.disabled);
  await page.evaluate(() => { window.fixture.slowChat = true; });
  await chat.getByLabel('消息内容').fill('慢速消息');
  await chat.getByRole('button', { name: '发送消息', exact: true }).click();
  await chat.getByText('正在生成回复...', { exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.holdStatus = 1; });
  await page.waitForFunction(() => typeof window.fixture.releaseStatus === 'function');
  await page.getByRole('button', { name: /会话乙/ }).click();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息内容"]')?.disabled);
  await page.evaluate(() => { window.fixture.holdStatus = null; window.fixture.releaseStatus(); });
  assert.equal(await chat.getByLabel('消息内容').isEnabled(), true);
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(c => c === 'conversation_chat_abort').length), 0);
  await page.getByRole('button', { name: /会话甲/ }).click();
  await chat.getByText('正在生成回复...', { exact: true }).waitFor();
  await chat.getByRole('button', { name: '停止生成', exact: true }).click();
  await chat.getByText('生成已停止，已产生的历史会保留。', { exact: true }).waitFor();
  assert.equal(await chat.getByLabel('消息内容').isEnabled(), true);
}, true));

test("新消息刷新历史时，旧分页请求不能混入新首页", async () => fixture(async (page) => {
  await page.evaluate(() => { window.fixture.paginated = true; window.fixture.holdOlder = true; });
  await page.getByRole('button', { name: '刷新历史', exact: true }).click();
  await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
  await page.waitForFunction(() => typeof window.fixture.releaseOlder === 'function');
  const chat = page.locator('.chat-panel');
  await chat.getByLabel('消息内容').fill('刷新历史的消息');
  await chat.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.transcript-list').getByText('本地页面回复', { exact: true }).waitFor();
  await page.evaluate(() => window.fixture.releaseOlder());
  assert.equal(await page.getByText('不应混入的旧页', { exact: true }).count(), 0);
}, true));

test("停止后可继续原上下文，超时重试沿用继续请求且保留未发送草稿", async () => fixture(async (page) => {
  const chat = page.locator('.chat-panel');
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息内容"]')?.disabled);
  await page.evaluate(() => { window.fixture.slowChat = true; });
  await chat.getByLabel('消息内容').fill('准备停止后继续');
  await chat.getByRole('button', { name: '发送消息', exact: true }).click();
  await chat.getByText('正在生成回复...', { exact: true }).waitFor();
  await chat.getByRole('button', { name: '停止生成', exact: true }).click();
  await chat.getByRole('button', { name: '继续上次生成', exact: true }).waitFor();
  await chat.getByLabel('消息内容').fill('尚未发送的下一条草稿');
  await page.evaluate(() => { window.fixture.resumeLostOnce = true; });
  await chat.getByRole('button', { name: '继续上次生成', exact: true }).click();
  await chat.getByRole('button', { name: '重试同一继续请求', exact: true }).waitFor();
  assert.equal(await chat.getByLabel('消息内容').isDisabled(), true);
  assert.equal((await chat.innerText()).includes('synthetic-resume-private'), false);
  await chat.getByRole('button', { name: '重试同一继续请求', exact: true }).click();
  await page.locator('.transcript-list').getByText('继续后的回复', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息内容"]')?.disabled);
  assert.equal(await chat.getByLabel('消息内容').inputValue(), '尚未发送的下一条草稿');
  assert.equal(await page.evaluate(() => window.fixture.submitArgs.length), 1);
  const args = await page.evaluate(() => window.fixture.resumeArgs);
  assert.equal(args.length, 2);
  assert.equal(args[0].requestId, args[1].requestId);
  assert.equal(await chat.getByRole('button', { name: '继续上次生成', exact: true }).count(), 0);
}, true));

test("助手回复渲染 Markdown 与表格，复制保留代码和原始消息，用户消息保持纯文本", async () => fixture(async (page) => {
  const reply = '# 验收结果\n\n**完成**，使用 `value`。\n\n| 项目 | 状态 |\n| --- | --- |\n| 渲染 | 通过 |\n\n```ts\nconst value = 42;\n```\n\n[参考](https://example.test/docs)';
  await page.evaluate((text) => {
    window.fixture.entries[1] = [
      { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }] }] },
      { id: 1, kind: 'studio.chat-input', model: [{ role: 'user', content: '# 用户原文 **不变**' }] },
    ];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.fixture.copied = value; } } });
  }, reply);
  await page.getByRole('button', { name: '刷新历史', exact: true }).click();
  const answer = page.locator('.transcript-entry').filter({ has: page.locator('.message-markdown') });
  await answer.getByRole('heading', { name: '验收结果' }).waitFor();
  assert.equal(await answer.locator('table tbody td').last().textContent(), '通过');
  assert.equal(await answer.locator('strong').filter({ hasText: '完成' }).count(), 1);
  await answer.getByRole('button', { name: '复制代码', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.copied), 'const value = 42;\n');
  await answer.getByRole('button', { name: '复制回复', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.copied), reply);
  await answer.getByRole('link', { name: '参考', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.openedUrl), 'https://example.test/docs');
  const user = page.locator('.transcript-entry').filter({ hasText: '# 用户原文 **不变**' });
  assert.equal(await user.locator('.message-markdown').count(), 0);
  await user.getByRole('button', { name: '复制消息', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.copied), '# 用户原文 **不变**');
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('private-clipboard-error'); }; });
  await answer.getByRole('button', { name: '复制回复', exact: true }).click();
  await answer.getByText('复制失败，请手动选择文本复制。', { exact: true }).waitFor();
  assert.equal((await answer.innerText()).includes('private-clipboard-error'), false);
}, true));

test("模型内容不能执行 HTML 或危险链接，也不会自动加载远程图片", async () => fixture(async (page) => {
  const requests = [];
  page.on('request', (request) => { if (request.url().includes('untrusted.example')) requests.push(request.url()); });
  await page.evaluate(() => {
    const text = '<script>window.modelExecuted = true</script>\n\n<img src="https://untrusted.example/raw.png" onerror="window.modelExecuted=true">\n\n[危险](javascript:alert(1)) [文件](file:///C:/test) [相对](/secret)\n\n![模型图片](https://untrusted.example/image.png)\n\n```html\n<script>示例代码</script>\n```';
    window.fixture.entries[1] = [{ id: 1, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }] }] }];
  });
  await page.getByRole('button', { name: '刷新历史', exact: true }).click();
  const rendered = page.locator('.message-markdown');
  await rendered.getByText('[图片：模型图片]', { exact: true }).waitFor();
  assert.equal(await rendered.locator('script, img, iframe, a').count(), 0);
  assert.equal(await rendered.locator('pre code').textContent(), '<script>示例代码</script>\n');
  assert.equal(await page.evaluate(() => !!window.modelExecuted), false);
  assert.deepEqual(requests, []);
}, true));

test("重命名失败可重试，标题搜索与清除搜索显示正确会话", async () => fixture(async (page) => {
  await page.getByLabel('消息内容', { exact: true }).fill('重命名时保留的聊天草稿');
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  const title = page.getByLabel('新的会话标题', { exact: true });
  await title.fill('   ');
  assert.equal(await page.getByRole('button', { name: '保存标题', exact: true }).isDisabled(), true);
  await title.fill('计划 Plan');
  await page.evaluate(() => { window.fixture.failRenameOnce = true; });
  await page.getByRole('button', { name: '保存标题', exact: true }).click();
  await page.getByText('标题保存结果尚未确认，可重试相同标题，或刷新列表核对。', { exact: true }).waitFor();
  assert.equal((await page.locator('.conversation-title-editor').innerText()).includes('synthetic-rename-private'), false);
  await page.getByRole('button', { name: '保存标题', exact: true }).click();
  await page.locator('.conversation-detail').getByRole('heading', { name: '计划 Plan', exact: true }).waitFor();
  assert.equal(await page.getByLabel('消息内容', { exact: true }).inputValue(), '重命名时保留的聊天草稿');
  assert.deepEqual(await page.evaluate(() => window.fixture.renameArgs), [
    { conversationId: 1, title: '计划 Plan' }, { conversationId: 1, title: '计划 Plan' },
  ]);
  await page.getByLabel('搜索会话标题', { exact: true }).fill('pLaN');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.conversation-item').length === 1);
  assert.match(await page.locator('.conversation-item').innerText(), /计划 Plan/);
  await page.getByLabel('搜索会话标题', { exact: true }).fill('没有的标题');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByText('没有匹配标题的会话。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.conversation-item').length === 2);
}, true));

test("保存标题时切换会话，迟到结果不能改变当前会话", async () => fixture(async (page) => {
  await page.evaluate(() => { window.fixture.holdRename = true; });
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await page.getByLabel('新的会话标题', { exact: true }).fill('甲的迟到标题');
  await page.getByRole('button', { name: '保存标题', exact: true }).click();
  await page.waitForFunction(() => typeof window.fixture.releaseRename === 'function');
  assert.equal(await page.getByRole('button', { name: '搜索', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: /会话乙/ }).click();
  await page.evaluate(() => { window.fixture.releaseRename(); });
  await page.locator('.conversation-detail').getByRole('heading', { name: '会话乙', exact: true }).waitFor();
  assert.equal(await page.locator('.conversation-detail').getByText('甲的迟到标题', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await page.getByRole('button', { name: /甲的迟到标题/ }).waitFor();
  assert.equal(await page.locator('.conversation-detail').getByRole('heading', { name: '会话乙', exact: true }).count(), 1);
}, true));

test("搜索覆盖未加载的会话，旧列表分页不能混入搜索结果", async () => fixture(async (page) => {
  await page.evaluate(() => {
    window.fixture.conversations = Array.from({ length: 21 }, (_, index) => ({
      id: 21 - index, createdAt: index + 1, title: index === 20 ? '旧页目标' : index === 11 ? '查找目标' : '普通会话 ' + (21 - index),
    }));
    window.fixture.holdConversationPage = true;
  });
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await page.waitForFunction(() => typeof window.fixture.releaseConversationPage === 'function');
  await page.getByLabel('搜索会话标题', { exact: true }).fill('查找');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.conversation-item').length === 1);
  await page.evaluate(() => { window.fixture.releaseConversationPage(); });
  assert.match(await page.locator('.conversation-item').innerText(), /查找目标/);
  await page.getByLabel('搜索会话标题', { exact: true }).fill('旧页');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: /旧页目标/ }).waitFor();
  assert.equal(await page.locator('.conversation-item').count(), 1);
}, true));

test("用量显示原生累计、缓存和推理明细，生成后刷新且缺失费用不显示免费", async () => fixture(async (page) => {
  await page.evaluate(() => {
    window.fixture.usages[1] = [{ model: 'custom-chat/usage-model', inputTokens: 1200, outputTokens: 60,
      cacheReadTokens: 80, cacheWriteTokens: 0, reasoningTokens: 20, totalTokens: 1340, costUsd: 0.00125 }];
    window.fixture.usages[2] = [{ model: 'custom-other/no-cost', inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, totalTokens: 0, costUsd: null }];
  });
  const usage = page.getByRole('region', { name: '会话用量', exact: true });
  await usage.getByRole('button', { name: '刷新用量', exact: true }).click();
  await usage.getByText('1,340', { exact: true }).waitFor();
  assert.match(await usage.innerText(), /缓存读取 80 · 写入 0 · 推理 20/);
  assert.equal(await usage.getByText('$0.001250', { exact: true }).count(), 1);
  await page.evaluate(() => { window.fixture.usages[1][0].outputTokens = 65; window.fixture.usages[1][0].totalTokens = 1345; });
  await page.getByLabel('消息内容', { exact: true }).fill('刷新累计用量');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await usage.getByText('1,345', { exact: true }).waitFor();
  await page.getByRole('button', { name: /会话乙/ }).click();
  await usage.getByRole('row').filter({ hasText: 'custom-other/no-cost' }).waitFor();
  assert.equal(await usage.getByText('未提供估算', { exact: true }).count(), 1);
  assert.equal((await usage.innerText()).includes('custom-chat/usage-model'), false);
  assert.equal((await usage.innerText()).includes('$0.000000'), false);
}, true));

test("新回复刷新用量后旧分页无效，切换会话后迟到用量不能覆盖当前记录", async () => fixture(async (page) => {
  await page.evaluate(() => {
    window.fixture.usages[1] = Array.from({ length: 21 }, (_, index) => ({ model: 'model-' + String(index).padStart(3, '0'),
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, totalTokens: 2, costUsd: null }));
    window.fixture.holdUsagePage = true;
  });
  const usage = page.getByRole('region', { name: '会话用量', exact: true });
  await usage.getByRole('button', { name: '刷新用量', exact: true }).click();
  await usage.getByRole('button', { name: '加载更多模型用量', exact: true }).click();
  await page.waitForFunction(() => typeof window.fixture.releaseUsagePage === 'function');
  await page.evaluate(() => {
    window.fixture.usages[1] = [{ ...window.fixture.usages[1][0], model: 'new-current-usage', costUsd: 0.00000001 }];
    window.fixture.statuses[1].latestEntryId = 999;
  });
  await usage.getByRole('row').filter({ hasText: 'new-current-usage' }).waitFor();
  await page.evaluate(() => { window.fixture.releaseUsagePage(); });
  assert.equal(await usage.locator('tbody tr').count(), 1);
  assert.equal(await usage.getByText('< $0.000001', { exact: true }).count(), 1);
  await page.evaluate(() => { window.fixture.holdUsageFor = 1; });
  await usage.getByRole('button', { name: '刷新用量', exact: true }).click();
  await page.waitForFunction(() => typeof window.fixture.releaseUsage === 'function');
  await page.getByRole('button', { name: /会话乙/ }).click();
  await usage.getByText('暂无已记录的模型用量。', { exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.releaseUsage(); });
  assert.equal(await usage.getByRole('row').filter({ hasText: 'new-current-usage' }).count(), 0);
}, true));

test("新上下文需要确认，未知结果重试同一请求且保留历史、模型和草稿", async () => fixture(async (page) => {
  const chat = page.locator('.chat-panel');
  await chat.getByLabel('消息内容').fill('重置前的原消息');
  await chat.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.transcript-list').getByText('本地页面回复', { exact: true }).waitFor();
  await chat.getByRole('button', { name: '开始新上下文', exact: true }).click();
  await chat.getByRole('button', { name: '取消重置', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.resetArgs.length), 0);
  await chat.getByLabel('消息内容').fill('保留的下一条草稿');
  const provider = await chat.getByLabel('对话服务商').inputValue();
  const model = await chat.getByLabel('对话模型').inputValue();
  await page.evaluate(() => { window.fixture.failResetOnce = true; window.fixture.holdStatus = 1; });
  await page.waitForFunction(() => typeof window.fixture.releaseStatus === 'function');
  await chat.getByRole('button', { name: '开始新上下文', exact: true }).click();
  await chat.getByRole('button', { name: '确认开始新上下文', exact: true }).click();
  await chat.getByRole('button', { name: '重试同一重置请求', exact: true }).waitFor();
  assert.equal(await chat.getByLabel('消息内容').isDisabled(), true);
  assert.equal(await chat.getByRole('button', { name: '取消重置', exact: true }).isDisabled(), true);
  assert.equal((await chat.innerText()).includes('synthetic-reset-private'), false);
  await chat.getByRole('button', { name: '重试同一重置请求', exact: true }).click();
  await chat.getByText('已开始新上下文。此前消息仍可在历史中查看。', { exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.holdStatus = null; window.fixture.releaseStatus(); });
  await page.locator('.transcript-list').getByText('此前消息保留在历史中，后续模型请求从这里开始。', { exact: true }).waitFor();
  assert.equal(await page.locator('.transcript-list').getByText('重置前的原消息', { exact: true }).count(), 1);
  assert.equal(await chat.getByLabel('消息内容').inputValue(), '保留的下一条草稿');
  assert.equal(await chat.getByText('已开始新上下文。此前消息仍可在历史中查看。', { exact: true }).count(), 1);
  assert.equal(await chat.getByLabel('对话服务商').inputValue(), provider);
  assert.equal(await chat.getByLabel('对话模型').inputValue(), model);
  const args = await page.evaluate(() => window.fixture.resetArgs);
  assert.equal(args.length, 2);
  assert.equal(args[0].requestId, args[1].requestId);
  assert.equal(await page.evaluate(() => window.fixture.entries[1].filter(item => item.kind === 'pi.reset').length), 1);
  assert.equal(await page.evaluate(() => window.fixture.submitArgs.length), 1);
}, true));

test("生成时禁止重置，切换会话后迟到重置不能影响新草稿，返回后显示原生边界", async () => fixture(async (page) => {
  const chat = page.locator('.chat-panel');
  await page.evaluate(() => { window.fixture.slowChat = true; window.fixture.holdReset = true; });
  await chat.getByLabel('消息内容').fill('生成后停止再重置');
  await chat.getByRole('button', { name: '发送消息', exact: true }).click();
  await chat.getByText('正在生成回复...', { exact: true }).waitFor();
  assert.equal(await chat.getByRole('button', { name: '开始新上下文', exact: true }).isDisabled(), true);
  await chat.getByRole('button', { name: '停止生成', exact: true }).click();
  await chat.getByRole('button', { name: '继续上次生成', exact: true }).waitFor();
  await chat.getByRole('button', { name: '开始新上下文', exact: true }).click();
  await chat.getByRole('button', { name: '确认开始新上下文', exact: true }).click();
  await page.waitForFunction(() => typeof window.fixture.releaseReset === 'function');
  await page.getByRole('button', { name: /会话乙/ }).click();
  await chat.getByLabel('消息内容').fill('乙的草稿');
  await page.evaluate(() => { window.fixture.releaseReset(); });
  assert.equal(await chat.getByLabel('消息内容').inputValue(), '乙的草稿');
  assert.equal(await chat.getByText('已开始新上下文。此前消息仍可在历史中查看。', { exact: true }).count(), 0);
  await page.getByRole('button', { name: /会话甲/ }).click();
  await chat.getByText('已开始新上下文。此前消息仍可在历史中查看。', { exact: true }).waitFor();
  assert.equal(await chat.getByRole('button', { name: '继续上次生成', exact: true }).count(), 0);
}, true));


test("fork UI keeps the same request after a lost reply and opens an independent conversation", async () => {
  await fixture(async (page) => {
    await page.evaluate(() => {
      const f = window.fixture;
      f.entries[1] = [
        { id: 4, kind: 'pi.assistant', data: null, model: [{ role: 'assistant', content: [{ type: 'text', text: '稍后的回复' }], stopReason: 'stop' }] },
        { id: 3, kind: 'studio.chat-input', data: null, model: [{ role: 'user', content: '稍后的问题' }] },
        { id: 2, kind: 'pi.assistant', data: null, model: [{ role: 'assistant', content: [{ type: 'text', text: '原始回复' }], stopReason: 'stop' }] },
        { id: 1, kind: 'studio.chat-input', data: null, model: [{ role: 'user', content: '原始问题' }] },
      ];
      f.statuses[1] = { running: false, model: { providerId: 'deepseek', modelId: 'deepseek-model' }, canResume: false };
      f.failForkOnce = true;
    });
    await page.getByRole('button', { name: '刷新历史', exact: true }).click();
    const reply = page.locator('article').filter({ hasText: '原始回复' });
    await reply.getByRole('button', { name: '从此处新建分支会话' }).click();
    await page.getByRole('alert').filter({ hasText: '创建分支结果未确认' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '从此处新建分支会话' }).first().isDisabled(), true);
    assert.equal((await page.locator('body').innerText()).includes('synthetic-fork-private'), false);
    await page.getByRole('button', { name: '重试创建分支' }).click();
    await page.locator('.conversation-item.active').filter({ hasText: '会话甲（分支）' }).waitFor();
    await page.getByText('分支来自会话 #1 的回复 #2；用量仅统计此分支的新请求。', { exact: true }).waitFor();
    await page.locator('.transcript-list').getByText('原始回复', { exact: true }).waitFor();
    assert.equal(await page.locator('.transcript-list').getByText('稍后的回复', { exact: true }).count(), 0);
    await page.waitForFunction(() => document.querySelector('[aria-label="对话模型"]')?.value === 'deepseek-model');
    const result = await page.evaluate(() => ({ args: window.fixture.forkArgs, count: window.fixture.conversations.length,
      source: window.fixture.entries[1].length, chatCalls: window.fixture.submitArgs.length }));
    assert.deepEqual(result.args[0], result.args[1]);
    assert.equal(result.count, 3);
    assert.equal(result.source, 4);
    assert.equal(result.chatCalls, 0);
    await page.getByRole('button', { name: /^会话甲 #1/ }).click();
    await page.locator('.transcript-list').getByText('稍后的回复', { exact: true }).waitFor();
  }, true);
});

test("late fork result cannot switch the newly selected conversation and unfinished replies have no fork action", async () => {
  await fixture(async (page) => {
    await page.evaluate(() => {
      const f = window.fixture;
      f.holdFork = true;
      f.entries[1] = [
        { id: 2, kind: 'pi.assistant', data: null, model: [{ role: 'assistant', content: [{ type: 'text', text: '完整回复' }], stopReason: 'stop' }] },
        { id: 3, kind: 'pi.assistant', data: null, model: [{ role: 'assistant', content: [{ type: 'text', text: '中断回复' }], stopReason: 'aborted' }] },
      ];
    });
    await page.getByRole('button', { name: '刷新历史', exact: true }).click();
    await page.getByRole('button', { name: '从此处新建分支会话' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '从此处新建分支会话' }).count(), 1);
    await page.getByRole('button', { name: '从此处新建分支会话' }).click();
    await page.waitForFunction(() => typeof window.fixture.releaseFork === 'function');
    await page.getByRole('button', { name: /^会话乙 #2/ }).click();
    await page.getByLabel('消息内容').fill('会话乙保留的草稿');
    await page.evaluate(() => window.fixture.releaseFork());
    await page.waitForFunction(() => window.fixture.conversations.length === 3);
    assert.ok((await page.locator('.conversation-item.active').innerText()).includes('会话乙'));
    assert.equal(await page.getByLabel('消息内容').inputValue(), '会话乙保留的草稿');
    await page.getByRole('button', { name: '刷新列表', exact: true }).click();
    await page.getByRole('button', { name: /会话甲（分支）/ }).waitFor();
  }, true);
});


test("工作区默认进入会话，导航保留草稿并让运行诊断独立可用", async () => fixture(async (page) => {
  const nav = page.getByRole('navigation', { name: '工作区导航' });
  assert.equal(await nav.getByRole('button', { name: '会话', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await page.getByRole('heading', { name: 'IPC 通信测试', exact: true }).isVisible(), false);
  assert.equal(await page.locator('.provider-settings').count(), 0);
  await page.getByLabel('消息内容', { exact: true }).fill('跨页面保留的草稿');
  await nav.getByRole('button', { name: '诊断', exact: true }).click();
  await page.getByRole('heading', { name: '运行诊断', exact: true }).waitFor();
  assert.equal(await page.getByLabel('消息内容', { exact: true }).isVisible(), false);
  await page.getByPlaceholder('输入 Ping 消息').fill('导航通信验收');
  await page.getByRole('button', { name: '发送 Ping', exact: true }).click();
  await page.locator('.result').filter({ hasText: '导航通信验收' }).waitFor();
  await nav.getByRole('button', { name: '会话', exact: true }).click();
  assert.equal(await page.getByLabel('消息内容', { exact: true }).inputValue(), '跨页面保留的草稿');
  assert.ok((await page.locator('.conversation-item.active').innerText()).includes('会话甲'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 400));
  const box = await nav.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0);
  await nav.getByRole('button', { name: '服务商', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('API Key', { exact: true }).waitFor();
}, true));

test("离开设置清除未保存密钥，保存期间阻止导航，完成后可安全切换", async () => fixture(async (page, panel) => {
  const nav = page.getByRole('navigation', { name: '工作区导航' });
  await panel.getByLabel('API Key', { exact: true }).fill('synthetic-unsaved-navigation-key');
  await nav.getByRole('button', { name: '会话', exact: true }).click();
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await nav.getByRole('button', { name: '服务商', exact: true }).click();
  await panel.getByLabel('API Key', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('API Key', { exact: true }).inputValue(), '');
  await page.evaluate(() => { window.fixture.holdSave = true; });
  await panel.getByLabel('API Key', { exact: true }).fill('synthetic-saved-navigation-key');
  await panel.getByRole('button', { name: '保存 API Key', exact: true }).click();
  await page.waitForFunction(() => typeof window.fixture.releaseSave === 'function');
  assert.equal(await nav.getByRole('button', { name: '会话', exact: true }).isDisabled(), true);
  assert.equal(await nav.getByRole('button', { name: '诊断', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.fixture.releaseSave());
  await panel.getByText('API Key 已保存到 Windows 凭据管理器。', { exact: true }).waitFor();
  await nav.getByRole('button', { name: '会话', exact: true }).click();
  await nav.getByRole('button', { name: '服务商', exact: true }).click();
  await panel.getByText('已保存 API Key', { exact: false }).waitFor();
  assert.equal(await panel.getByLabel('API Key', { exact: true }).inputValue(), '');
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
}));

test("返回会话刷新模型目录，页面切换保留生成与未确认消息的幂等请求", async () => fixture(async (page) => {
  const nav = page.getByRole('navigation', { name: '工作区导航' });
  await page.getByLabel('消息内容', { exact: true }).fill('保留目录刷新草稿');
  await nav.getByRole('button', { name: '服务商', exact: true }).click();
  await page.getByRole('button', { name: '自定义配置', exact: true }).click();
  await page.getByLabel('配置标识', { exact: true }).fill('custom-navigation');
  await page.getByLabel('显示名称', { exact: true }).fill('导航新模型');
  await page.getByLabel('API 基础地址', { exact: true }).fill('https://model.example.test/v1');
  await page.getByLabel('模型 ID', { exact: true }).fill('new-model');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('配置已保存，可设置 API Key 并测试连接。', { exact: true }).waitFor();
  await nav.getByRole('button', { name: '会话', exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('[aria-label="对话服务商"] option[value="custom-navigation"]'));
  assert.equal(await page.getByLabel('消息内容', { exact: true }).inputValue(), '保留目录刷新草稿');
  await page.evaluate(() => { window.fixture.failSubmitOnce = true; });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '重试同一请求', exact: true }).waitFor();
  await nav.getByRole('button', { name: '诊断', exact: true }).click();
  await nav.getByRole('button', { name: '会话', exact: true }).click();
  await page.getByRole('button', { name: '重试同一请求', exact: true }).click();
  await page.locator('.transcript-list').getByText('本地页面回复', { exact: true }).waitFor();
  const args = await page.evaluate(() => window.fixture.submitArgs);
  assert.equal(args[0].requestId, args[1].requestId);
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息内容"]').disabled);
  await page.evaluate(() => { window.fixture.slowChat = true; });
  await page.getByLabel('消息内容', { exact: true }).fill('切换页面不中断生成');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('正在生成回复...', { exact: true }).waitFor();
  await nav.getByRole('button', { name: '服务商', exact: true }).click();
  await nav.getByRole('button', { name: '会话', exact: true }).click();
  await page.getByText('正在生成回复...', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(item => item === 'conversation_chat_abort').length), 0);
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await page.getByRole('button', { name: '继续上次生成', exact: true }).waitFor();
}, true));


test("对话按时间正序阅读，更早分页置顶且加载后保留阅读位置并去重", async () => fixture(async (page) => {
  await page.evaluate(() => {
    const f = window.fixture;
    f.realEntryPages = true;
    f.entries[1] = Array.from({ length: 14 }, (_, index) => ({ id: index + 1,
      kind: index % 2 ? 'pi.assistant' : 'studio.chat-input', data: null,
      model: [{ role: index % 2 ? 'assistant' : 'user', content: '分页消息' + (index + 1) + '\n' + '正文内容\n'.repeat(12), stopReason: 'stop' }] }));
    f.overlapEntry = structuredClone(f.entries[1][4]);
  });
  await page.getByRole('button', { name: '刷新历史', exact: true }).click();
  const list = page.getByRole('region', { name: '对话消息', exact: true });
  await page.waitForFunction(() => document.querySelectorAll('.transcript-entry').length === 10);
  assert.deepEqual(await list.locator('article').evaluateAll(items => items.map(item => Number(item.dataset.entryId))), [5,6,7,8,9,10,11,12,13,14]);
  assert.equal(await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === '加载更早记录');
    return !!(button.compareDocumentPosition(document.querySelector('.transcript-list')) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      !!(document.querySelector('.transcript-list').compareDocumentPosition(document.querySelector('.chat-panel')) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true);
  await list.evaluate(element => { element.scrollTop = 0; });
  const before = await list.locator('[data-entry-id="5"]').evaluate(element => element.getBoundingClientRect().top - element.parentElement.getBoundingClientRect().top);
  await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.transcript-entry').length === 14);
  const after = await list.locator('[data-entry-id="5"]').evaluate(element => element.getBoundingClientRect().top - element.parentElement.getBoundingClientRect().top);
  assert.ok(Math.abs(after - before) < 2, '加载更早消息后应保持原阅读位置');
  assert.deepEqual(await list.locator('article').evaluateAll(items => items.map(item => Number(item.dataset.entryId))), Array.from({ length: 14 }, (_, i) => i + 1));
  const nav = page.getByRole('navigation', { name: '工作区导航' });
  await nav.getByRole('button', { name: '诊断', exact: true }).click();
  const reads = await page.evaluate(() => window.fixture.calls.filter(item => item === 'conversation_entries').length);
  await page.evaluate(() => {
    const f = window.fixture;
    f.entries[1].push({ id: 15, kind: 'pi.assistant', data: null,
      model: [{ role: 'assistant', content: '隐藏期间的新回复\n' + '正文\n'.repeat(12), stopReason: 'stop' }] });
    f.statuses[1].latestEntryId = 15;
  });
  await page.waitForFunction(count => window.fixture.calls.filter(item => item === 'conversation_entries').length > count, reads);
  await nav.getByRole('button', { name: '会话', exact: true }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector('.transcript-list');
    return el && el.lastElementChild?.dataset.entryId === "15" && el.clientHeight > 0 && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2;
  });
  assert.equal(await list.locator('article').last().getAttribute('data-entry-id'), '15');
}, true));

test("输入区 Enter 换行，组合输入不发送，Ctrl 或 Command Enter 每次只提交一条", async () => fixture(async (page) => {
  const input = page.getByLabel('消息内容', { exact: true });
  await input.fill('第一行');
  await input.press('Enter');
  await input.press('End');
  await input.type('第二行');
  assert.equal(await page.evaluate(() => window.fixture.submitArgs.length), 0);
  assert.ok((await input.inputValue()).includes('\n'));
  await input.evaluate(element => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true, bubbles: true }));
  });
  assert.equal(await page.evaluate(() => window.fixture.submitArgs.length), 0);
  await input.press('Control+Enter');
  await page.waitForFunction(() => window.fixture.submitArgs.length === 1);
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息内容"]').disabled);
  await input.fill('Command 快捷发送');
  await input.press('Meta+Enter');
  await page.waitForFunction(() => window.fixture.submitArgs.length === 2);
  const args = await page.evaluate(() => window.fixture.submitArgs);
  assert.notEqual(args[0].requestId, args[1].requestId);
  assert.equal(args[1].content, 'Command 快捷发送');
  await page.getByRole('navigation', { name: '工作区导航' }).getByRole('button', { name: '服务商', exact: true }).click();
  await page.getByRole('navigation', { name: '工作区导航' }).getByRole('button', { name: '会话', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.submitArgs.length), 2);
}, true));
