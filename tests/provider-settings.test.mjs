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
  const context = await browser.newContext({ colorScheme: "dark" });
  try {
    await context.addInitScript((chat) => {
      const state = window.fixture = { calls: [], stored: {}, configs: {}, failSave: false, delay: 0,
        entries: { 1: [], 2: [] }, modelArgs: [], statuses: {}, submissions: {}, submitArgs: [], resumeArgs: [], renameArgs: [], resetArgs: [], forkArgs: [], forks: {},
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
          if (command === "workspace_state") return { workspace: structuredClone(state.workspace ?? null) };
          if (command === "workspace_choose") {
            state.chooseArgs ??= []; state.chooseArgs.push(structuredClone(args));
            if (state.cancelWorkspace) return { cancelled: true };
            state.workspace = state.nextWorkspace ?? { id: 'workspace-one', name: '示例项目' };
            if (state.loseWorkspaceChoice) { state.loseWorkspaceChoice = false; throw 'IPC_TIMEOUT: synthetic-workspace-private'; }
            return { workspace: structuredClone(state.workspace) };
          }
          if (command === "workspace_close") {
            state.workspace = null;
            if (state.loseWorkspaceClose) { state.loseWorkspaceClose = false; throw 'IPC_TIMEOUT: synthetic-close-private'; }
            return { closed: true };
          }
          if (command === "workspace_list") {
            const result = { workspaceId: args.input.workspaceId, path: args.input.path, truncated: !!state.workspaceTruncated,
              items: structuredClone(state.workspaceItems?.[args.input.path] ?? [
                { name: 'docs', path: 'docs', kind: 'directory', previewable: false },
                { name: 'README.md', path: 'README.md', kind: 'file', previewable: true },
                { name: 'app.exe', path: 'app.exe', kind: 'file', previewable: false },
              ]) };
            if (state.failWorkspaceList) throw 'INTERNAL_ERROR: synthetic-path-private';
            if (state.holdWorkspaceList === args.input.path) return new Promise(resolve => { state.releaseWorkspaceList = () => resolve(result); });
            return result;
          }
          if (command === "workspace_read") {
            const text = state.fileContents?.[args.input.path] ?? '# 本地文件预览';
            const result = { workspaceId: args.input.workspaceId, path: args.input.path, name: args.input.path.split('/').at(-1),
              bytes: new TextEncoder().encode(text).length, text };
            if (state.failWorkspaceRead) throw 'WORKSPACE_FILE_TOO_LARGE: synthetic-path-private';
            if (state.holdWorkspaceRead === args.input.path) return new Promise(resolve => { state.releaseWorkspaceRead = () => resolve(result); });
            return result;
          }
          if (command === "conversation_create") {
            state.created ??= {};
            if (state.created[args.requestId]) return { conversation: structuredClone(state.created[args.requestId]) };
            const item = { id: Math.max(0, ...state.conversations.map(item => item.id)) + 1, title: args.title || '新建会话', createdAt: Date.now() };
            state.created[args.requestId] = item; state.conversations.unshift(item); state.entries[item.id] = [];
            return { conversation: structuredClone(item) };
          }
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
          if (command === "conversation_context_usage") {
            const result = structuredClone(state.contextUsages?.[args.conversationId] ?? { conversationId: args.conversationId, latestEntryId: chatStatus(args.conversationId).latestEntryId, state: 'empty', lastRequest: null });
            state.contextUsageArgs ??= []; state.contextUsageArgs.push(args.conversationId);
            if (state.failContextUsage) throw 'IPC_TIMEOUT: synthetic-context-private';
            if (state.holdContextUsageFor === args.conversationId) return new Promise(resolve => { state.releaseContextUsage = () => resolve(result); });
            return result;
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
            if (state.rejectSubmitOnce) { state.rejectSubmitOnce = false; throw 'PROVIDER_NOT_CONFIGURED: synthetic-no-credential'; }
            const id = Object.keys(state.submissions).length + 1;
            state.submissions[input.requestId] = id;
            const current = chatStatus(input.conversationId);
            current.model = { providerId: input.providerId, modelId: input.modelId };
            current.thinkingLevel = input.thinkingLevel ?? "off";
            if (state.nextContextUsage) { state.contextUsages ??= {}; state.contextUsages[input.conversationId] = { ...structuredClone(state.nextContextUsage), conversationId: input.conversationId, latestEntryId: id * 2 }; }
            current.running = !!state.slowChat;
            current.canResume = false;
            current.contextReset = false;
            current.partialText = state.slowChat ? "正在回复" : "";
            current.latestEntryId = id * 2;
            state.entries[input.conversationId] = [
              ...(state.slowChat ? [] : [{ id: id * 2, kind: "pi.assistant", data: null, model: [{ role: "assistant", content: [{ type: "text", text: "本地页面回复" }], stopReason: "stop" }] }]),
              { id: id * 2 - 1, kind: "studio.chat-input", data: {}, model: [{ role: "user", content: input.content }] },
            ];
            if (state.holdSubmitReply) await new Promise(resolve => { state.releaseSubmitReply = resolve; });
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
            state.contextUsages ??= {}; state.contextUsages[input.conversationId] = { conversationId: input.conversationId, latestEntryId: 200 + id, state: "empty", lastRequest: null };
            state.entries[input.conversationId].unshift({ id: 200 + id, kind: 'pi.reset', data: null, model: null });
            if (state.failResetOnce) { state.failResetOnce = false; throw 'IPC_TIMEOUT: synthetic-reset-private'; }
            return { submissionId: id, entryId: 200 + id };
          }
          if (command === "provider_list" && state.providerDelay) await new Promise(resolve => setTimeout(resolve, state.providerDelay));
          if (command === "provider_list" && state.failProviderList) throw "IPC_TIMEOUT: synthetic-catalog-private";
          if (command === "provider_list" && state.emptyProviderList) return { items: [] };
          if (command === "provider_list") return { items: [
            { id: "deepseek", name: "DeepSeek", supportsApiKey: true },
            { id: "other", name: "Other", supportsApiKey: true },
            { id: "oauth", name: "OAuth", supportsApiKey: false },
            ...Object.values(state.configs).map(item => ({ id: item.id, name: item.name, supportsApiKey: true })),
          ] };
          if (command === "provider_config_list" && state.failConfigList) throw "IPC_TIMEOUT: synthetic-config-private";
          if (command === "provider_config_list") return { items: Object.values(state.configs) };
          if (command === "provider_config_set") {
            state.configs[args.config.id] = { ...args.config };
            return args.config;
          }
          if (command === "provider_config_delete") { delete state.configs[args.providerId]; return { deleted: true }; }
          if (command === "model_list") {
            state.modelArgs.push(args.providerId);
            if (state.failModelsFor === args.providerId) throw "IPC_TIMEOUT: synthetic-model-private";
            if (state.emptyModelsFor === args.providerId) return { items: [] };
            if (args.providerId === "deepseek" && state.delay) await new Promise(r => setTimeout(r, state.delay));
            if (state.modelsByProvider?.[args.providerId]) return { items: structuredClone(state.modelsByProvider[args.providerId]) };
            return { items: [{ id: state.configs[args.providerId]?.modelId ?? args.providerId + "-model", name: args.providerId, api: "openai-completions", contextWindow: 64000, maxTokens: 4096, supportsConnectionTest: args.providerId !== "oauth" }] };
          }
          const status = () => ({ providerId: args.providerId, stored: !!state.stored[args.providerId], type: state.stored[args.providerId] ? "api_key" : null });
          if (command === "provider_credential_status" && state.failCredentialStatusFor === args.providerId) throw "CREDENTIAL_STORE_UNAVAILABLE: synthetic-credential-private";
          if (command === "provider_credential_status") return status();
          if (command === "provider_credential_set") {
            if (state.holdSave) await new Promise(resolve => { state.releaseSave = resolve; });
            if (state.failSave) throw "UNKNOWN: synthetic-secret-marker";
            state.stored[args.providerId] = true;
            return status();
          }
          if (command === "provider_credential_delete") { delete state.stored[args.providerId]; return status(); }
          if (command === "provider_test" && state.failTest) throw "PROVIDER_TEST_FAILED: synthetic-test-private";
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

test("工作区选择、目录导航与纯文本预览接入现有桌面，关闭后清除内容", async () => fixture(async page => {
  await page.getByRole('navigation', { name: '工作区导航', exact: true }).getByRole('button', { name: '工作区', exact: true }).click();
  const workspace = page.locator('.file-workspace');
  await workspace.getByRole('button', { name: '选择目录', exact: true }).click();
  await workspace.getByRole('button', { name: 'README.md', exact: true }).waitFor();
  assert.equal(await workspace.getByRole('button', { name: 'app.exe', exact: true }).isDisabled(), true);
  await page.evaluate(() => {
    fixture.workspaceItems = { docs: [{ name: 'guide.md', path: 'docs/guide.md', kind: 'file', previewable: true }] };
    fixture.fileContents = { 'docs/guide.md': '<img src="https://invalid.example/file"><script>window.unsafeFile = true</script>\n文件正文' };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { fixture.copiedFile = text; } } });
  });
  await workspace.getByRole('button', { name: 'docs', exact: true }).click();
  await workspace.getByRole('button', { name: 'guide.md', exact: true }).click();
  await workspace.getByLabel('文件内容', { exact: true }).waitFor();
  assert.ok((await workspace.getByLabel('文件内容', { exact: true }).innerText()).includes('<script>'));
  assert.equal(await workspace.locator('img,script').count(), 0);
  assert.equal(await page.evaluate(() => window.unsafeFile), undefined);
  await workspace.getByRole('button', { name: '复制文件内容', exact: true }).click();
  assert.equal(await page.evaluate(() => fixture.copiedFile === fixture.fileContents['docs/guide.md']), true);
  assert.deepEqual(await page.evaluate(() => fixture.chooseArgs), [{}]);
  assert.equal(await page.evaluate(() => fixture.calls.includes('conversation_chat_submit')), false);
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  await workspace.getByRole('button', { name: '关闭工作区', exact: true }).click();
  await workspace.getByText('选择一个工作目录', { exact: true }).waitFor();
  assert.equal(await workspace.getByLabel('文件内容', { exact: true }).count(), 0);
}, true));

test("工作区旧文件和旧目录的迟到结果不能覆盖当前预览或新目录", async () => fixture(async page => {
  await page.getByRole('navigation', { name: '工作区导航', exact: true }).getByRole('button', { name: '工作区', exact: true }).click();
  const workspace = page.locator('.file-workspace');
  await workspace.getByRole('button', { name: '选择目录', exact: true }).click();
  await page.evaluate(() => { fixture.holdWorkspaceRead = 'README.md'; fixture.fileContents = { 'README.md': '迟到文件标记' }; });
  await workspace.getByRole('button', { name: 'README.md', exact: true }).click();
  await page.waitForFunction(() => typeof fixture.releaseWorkspaceRead === 'function');
  await page.evaluate(() => { fixture.workspaceItems = { docs: [{ name: 'new.md', path: 'docs/new.md', kind: 'file', previewable: true }] }; });
  await workspace.getByRole('button', { name: 'docs', exact: true }).click();
  await workspace.getByRole('button', { name: 'new.md', exact: true }).click();
  await workspace.getByLabel('文件内容', { exact: true }).waitFor();
  await page.evaluate(() => fixture.releaseWorkspaceRead());
  assert.equal(await workspace.getByLabel('文件内容', { exact: true }).innerText(), '# 本地文件预览');
  await page.evaluate(() => { fixture.holdWorkspaceList = ''; });
  await workspace.getByRole('navigation', { name: '目录位置' }).getByRole('button', { name: '示例项目', exact: true }).click();
  await page.waitForFunction(() => typeof fixture.releaseWorkspaceList === 'function');
  await page.evaluate(() => { fixture.holdWorkspaceList = null; fixture.nextWorkspace = { id: 'workspace-two', name: '另一个项目' }; });
  await workspace.getByRole('button', { name: '切换目录', exact: true }).click();
  await workspace.getByRole('navigation', { name: '目录位置' }).getByRole('button', { name: '另一个项目', exact: true }).waitFor();
  await page.evaluate(() => fixture.releaseWorkspaceList());
  assert.equal(await workspace.getByRole('navigation', { name: '目录位置' }).getByRole('button', { name: '示例项目', exact: true }).count(), 0);
  assert.equal(await workspace.getByLabel('文件内容', { exact: true }).count(), 0);
}, true));

test("取消目录选择保留预览，未知结果从 Node 状态恢复且错误不泄露原始路径", async () => fixture(async page => {
  await page.getByRole('navigation', { name: '工作区导航', exact: true }).getByRole('button', { name: '工作区', exact: true }).click();
  const workspace = page.locator('.file-workspace');
  await page.evaluate(() => { fixture.loseWorkspaceChoice = true; });
  await workspace.getByRole('button', { name: '选择目录', exact: true }).click();
  await workspace.getByRole('button', { name: 'README.md', exact: true }).waitFor();
  assert.equal((await workspace.innerText()).includes('synthetic-workspace-private'), false);
  assert.equal(await workspace.locator(':scope > [role="alert"]').count(), 0);
  await workspace.getByRole('button', { name: 'README.md', exact: true }).click();
  await workspace.getByLabel('文件内容', { exact: true }).waitFor();
  await page.evaluate(() => { fixture.cancelWorkspace = true; });
  await workspace.getByRole('button', { name: '切换目录', exact: true }).click();
  assert.equal(await workspace.getByLabel('文件内容', { exact: true }).innerText(), '# 本地文件预览');
  await page.evaluate(() => { fixture.failWorkspaceRead = true; });
  await workspace.getByRole('button', { name: 'README.md', exact: true }).click();
  await workspace.getByText('文件超过 64 KiB，暂不支持预览。', { exact: true }).waitFor();
  assert.equal((await workspace.innerText()).includes('synthetic-path-private'), false);
  await page.evaluate(() => { fixture.loseWorkspaceClose = true; });
  await workspace.getByRole('button', { name: '关闭工作区', exact: true }).click();
  await workspace.getByText('选择一个工作目录', { exact: true }).waitFor();
  assert.equal(await workspace.locator(':scope > [role="alert"]').count(), 0);
}, true));

test("工作区保留聊天草稿，深浅与窄窗均可浏览预览，目录失败可重试", async () => fixture(async page => {
  await page.getByLabel('消息内容', { exact: true }).fill('原会话草稿');
  const nav = page.getByRole('navigation', { name: '工作区导航', exact: true });
  await nav.getByRole('button', { name: '工作区', exact: true }).click();
  const workspace = page.locator('.file-workspace');
  await page.evaluate(() => { fixture.failWorkspaceList = true; });
  await workspace.getByRole('button', { name: '选择目录', exact: true }).click();
  await workspace.getByRole('button', { name: '重试目录', exact: true }).waitFor();
  await page.evaluate(() => { fixture.failWorkspaceList = false; fixture.workspaceTruncated = true; });
  await workspace.getByRole('button', { name: '重试目录', exact: true }).click();
  await workspace.getByRole('button', { name: 'README.md', exact: true }).click();
  await workspace.getByLabel('文件内容', { exact: true }).waitFor();
  await workspace.getByText('目录较大，仅显示部分文件（最多 200 项）。', { exact: true }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await workspace.getByLabel('文件内容', { exact: true }).isVisible(), true);
  }
  await nav.getByRole('button', { name: '会话', exact: true }).click();
  assert.equal(await page.getByLabel('消息内容', { exact: true }).inputValue(), '原会话草稿');
}, true));

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
  await panel.getByLabel("API Key", { exact: true }).fill("discard-on-mode-change");
  await panel.getByRole("button", { name: "自定义配置", exact: true }).click();
  await panel.getByRole("button", { name: "密钥与连接", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.provider-editor[aria-busy="true"]'));
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
  assert.equal(await panel.getByRole("button", { name: "自定义配置", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("navigation", { name: "工作区导航" }).getByRole("button", { name: "会话", exact: true }).isDisabled(), true);
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

test("原生思考流可折叠，轮询保留展开状态，停止后清除实时预览", async () => fixture(async page => {
  const chat = page.locator('.chat-panel');
  await chat.getByLabel('消息内容', { exact: true }).fill('保留当前草稿');
  await page.evaluate(() => { Object.assign(window.fixture.statuses[1], {
    running: true, phase: 'thinking', partialThinking: '<img src="https://invalid.example/probe">思考正文', partialText: '', thinkingTruncated: false,
  }); });
  await chat.getByRole('status').filter({ hasText: '正在思考...' }).waitFor();
  const thinking = chat.locator('.message-thinking');
  assert.equal(await thinking.getAttribute('open'), null);
  await thinking.locator('summary').focus(); await page.keyboard.press('Enter');
  await thinking.locator('pre').waitFor();
  assert.equal(await thinking.locator('img').count(), 0);
  assert.ok((await thinking.locator('pre').innerText()).includes('<img'));
  await page.evaluate(() => Object.assign(window.fixture.statuses[1], {
    phase: 'responding', partialThinking: '后续思考', thinkingTruncated: true, partialText: '真正回复正文',
  }));
  await chat.getByText('正在回复...', { exact: true }).waitFor();
  assert.notEqual(await thinking.getAttribute('open'), null);
  assert.equal(await thinking.locator('pre').innerText(), '后续思考');
  await chat.getByText('真正回复正文', { exact: true }).waitFor();
  await thinking.getByText('实时预览仅显示末尾部分，完成后可查看完整内容。', { exact: true }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await chat.getByRole('button', { name: '停止生成', exact: true }).click();
  await chat.getByText('生成已停止，已产生的历史会保留。', { exact: true }).waitFor();
  assert.equal(await chat.locator('.chat-live').count(), 0);
  assert.equal(await chat.getByLabel('消息内容', { exact: true }).inputValue(), '保留当前草稿');
}, true));

test("历史思考与正文分开展示，遮蔽内容、签名和失败文本不进入思考面板", async () => fixture(async page => {
  await page.evaluate(() => {
    const assistant = (id, content, stopReason = 'stop') => ({ id, kind: 'pi.assistant', data: null, model: [{ role: 'assistant', content, stopReason }] });
    window.fixture.entries[1] = [
      assistant(1, [{ type: 'thinking', thinking: '完整历史思考', thinkingSignature: 'opaque-history-signature' }, { type: 'text', text: '独立回复正文' }]),
      assistant(2, [{ type: 'thinking', thinking: '遮蔽的思考', redacted: true, thinkingSignature: 'opaque-redacted-signature' }, { type: 'text', text: '正常正文' }]),
      assistant(3, [{ type: 'thinking', thinking: '只有思考的回复' }]),
      assistant(4, [{ type: 'thinking', thinking: '失败时的私密文本' }], 'error'),
    ];
  });
  await page.getByRole('button', { name: '刷新历史', exact: true }).click();
  const history = page.locator('.transcript-list');
  await history.getByText('独立回复正文', { exact: true }).waitFor();
  assert.equal(await history.locator('.message-thinking').count(), 2);
  const mixed = history.locator('[data-entry-id="1"]');
  assert.equal(await mixed.locator('.message-thinking').getAttribute('open'), null);
  await mixed.locator('.message-thinking summary').click();
  await mixed.getByText('完整历史思考', { exact: true }).waitFor();
  assert.equal((await mixed.locator('.chat-message').innerText()).includes('完整历史思考'), false);
  const only = history.locator('[data-entry-id="3"]');
  assert.equal(await only.locator('.chat-message, .transcript-content').count(), 0);
  const visible = await history.innerText();
  for (const hidden of ['遮蔽的思考', 'opaque-history-signature', 'opaque-redacted-signature', '失败时的私密文本']) assert.equal(visible.includes(hidden), false);
}, true));

test("回复统计使用原生请求耗时和输出量，复制正文不夹带统计或推理计数", async () => fixture(async page => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => {
    window.fixture.entries[1] = [{ id: 1, kind: 'pi.assistant', data: null, model: [{ role: 'assistant', stopReason: 'stop',
      durationMs: 1250, usage: { input: 100, output: 8, reasoning: 3 }, content: [{ type: 'text', text: '带有真实统计的回复' }] }] }];
  });
  await page.getByRole('button', { name: '刷新历史', exact: true }).click();
  const history = page.locator('.transcript-list');
  const metrics = history.getByLabel('本次请求统计', { exact: true });
  await metrics.getByText('耗时 1.3 秒', { exact: true }).waitFor();
  assert.equal((await metrics.innerText()).includes('输出 8 tokens'), true);
  assert.equal((await metrics.innerText()).includes('11 tokens'), false);
  await history.getByRole('button', { name: '复制回复', exact: true }).click();
  await history.getByText('已复制', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '带有真实统计的回复');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.setViewportSize({ width: 320, height: 650 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await metrics.isVisible(), true);
  }
}, true));

test("缺失或无效计量不伪造耗时和零用量，失败与停止回复不显示成功统计", async () => fixture(async page => {
  await page.evaluate(() => {
    const entry = (id, durationMs, output, stopReason = 'stop') => ({ id, kind: 'pi.assistant', data: null,
      model: [{ role: 'assistant', content: [{ type: 'text', text: `计量边界 ${id}` }], stopReason, durationMs, usage: { output } }] });
    window.fixture.entries[1] = [entry(1, undefined, undefined), entry(2, -1, 0), entry(3, NaN, -5), entry(4, Infinity, 1.5),
      entry(5, 500, 5, 'error'), entry(6, 500, 5, 'aborted'), entry(7, 0, 0), entry(8, undefined, 9), entry(9, 250, undefined, 'length')];
  });
  await page.getByRole('button', { name: '刷新历史', exact: true }).click();
  const history = page.locator('.transcript-list');
  await history.getByText('计量边界 9', { exact: true }).waitFor();
  for (const id of [1, 2, 3, 4, 5, 6]) assert.equal(await history.locator(`[data-entry-id="${id}"] .response-metrics`).count(), 0);
  assert.equal(await history.locator('[data-entry-id="7"] .response-metrics').innerText(), '耗时 <1 毫秒');
  assert.equal(await history.locator('[data-entry-id="8"] .response-metrics').innerText(), '输出 9 tokens');
  assert.equal(await history.locator('[data-entry-id="9"] .response-metrics').innerText(), '耗时 250 毫秒');
}, true));

test("模型选择不改写历史计量，重新打开会话仍显示对应回复的数据", async () => fixture(async page => {
  await page.evaluate(() => {
    const entry = (id, durationMs) => ({ id, kind: 'pi.assistant', data: null, model: [{ role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text: `独立计量 ${id}` }], durationMs, usage: { output: id } }] });
    window.fixture.entries[1] = [entry(1, 250)]; window.fixture.entries[2] = [entry(2, 2500)];
  });
  await page.getByRole('button', { name: '刷新历史', exact: true }).click();
  await page.getByLabel('本次请求统计', { exact: true }).getByText('耗时 250 毫秒', { exact: true }).waitFor();
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.getByRole('combobox', { name: '对话服务商', exact: true }).selectOption('other');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByLabel('本次请求统计', { exact: true }).innerText(), '耗时 250 毫秒\n输出 1 tokens');
  await page.getByRole('button', { name: /会话乙/ }).click();
  await page.getByLabel('本次请求统计', { exact: true }).getByText('耗时 2.5 秒', { exact: true }).waitFor();
  await page.getByRole('button', { name: /会话甲/ }).click();
  await page.getByLabel('本次请求统计', { exact: true }).getByText('耗时 250 毫秒', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.calls.includes('conversation_chat_submit')), false);
}, true));

test("切换会话后迟到思考流不串入新会话，返回可读取原生实时状态", async () => fixture(async page => {
  await page.evaluate(() => { Object.assign(window.fixture.statuses[1], { running: true, phase: 'thinking', partialThinking: '会话甲独有思考' }); });
  await page.getByText('正在思考...', { exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.holdStatus = 1; });
  await page.waitForFunction(() => typeof window.fixture.releaseStatus === 'function');
  await page.getByRole('button', { name: /会话乙/ }).click();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息内容"]').disabled);
  await page.evaluate(() => { window.fixture.holdStatus = null; window.fixture.releaseStatus(); });
  assert.equal(await page.locator('.chat-live').count(), 0);
  await page.getByRole('button', { name: /会话甲/ }).click();
  await page.getByText('正在思考...', { exact: true }).waitFor();
  await page.locator('.chat-live .message-thinking summary').click();
  await page.locator('.chat-live').getByText('会话甲独有思考', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.calls.includes('conversation_chat_abort')), false);
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
  await page.locator('.conversation-inspector > summary').click();
  const usage = page.getByRole('region', { name: '会话用量', exact: true });
  await usage.getByRole('button', { name: '刷新用量', exact: true }).click();
  await usage.getByText('1,340', { exact: true }).waitFor();
  assert.match(await usage.innerText(), /缓存读取 80 · 写入 0 · 推理 20/);
  assert.equal(await usage.getByText('$0.001250', { exact: true }).count(), 1);
  await page.evaluate(() => { window.fixture.usages[1][0].outputTokens = 65; window.fixture.usages[1][0].totalTokens = 1345; });
  await page.locator('.conversation-inspector > summary').click();
  await page.getByLabel('消息内容', { exact: true }).fill('刷新累计用量');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.conversation-inspector > summary').click();
  await usage.getByText('1,345', { exact: true }).waitFor();
  await page.getByRole('button', { name: /会话乙/ }).click();
  await page.locator('.conversation-inspector > summary').click();
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
  await page.locator('.conversation-inspector > summary').click();
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
  await page.locator('.conversation-inspector > summary').click();
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
    await page.locator('.conversation-inspector > summary').click();
    await page.getByText('分支来自会话 #1 的回复 #2；用量仅统计此分支的新请求。', { exact: true }).waitFor();
    await page.locator('.conversation-inspector > summary').click();
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
  await page.getByText('配置已保存。', { exact: true }).waitFor();
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


test("服务商读取失败可重试，空目录提供自定义配置入口且不回显底层错误", async () => fixture(async (page, panel) => {
  await page.evaluate(() => { window.fixture.failProviderList = true; });
  await panel.getByRole('button', { name: '刷新服务商', exact: true }).click();
  await panel.getByRole('button', { name: '重试读取服务商', exact: true }).waitFor();
  assert.equal(await panel.getByLabel('服务商', { exact: true }).isDisabled(), true);
  assert.equal(await panel.getByLabel('API Key', { exact: true }).count(), 0);
  assert.equal((await panel.innerText()).includes('synthetic-catalog-private'), false);
  await page.evaluate(() => { window.fixture.failProviderList = false; window.fixture.emptyProviderList = true; });
  await panel.getByRole('button', { name: '重试读取服务商', exact: true }).click();
  await panel.getByRole('button', { name: '添加自定义服务商', exact: true }).click();
  await panel.getByText('暂无自定义服务商。', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('配置标识', { exact: true }).isEnabled(), true);
}));

test("模型目录失败不阻止管理已知凭据，空模型与失败分别提示，凭据失败仍禁止写入", async () => fixture(async (page, panel) => {
  await page.evaluate(() => { window.fixture.failModelsFor = 'deepseek'; });
  await panel.getByRole('button', { name: '刷新状态', exact: true }).click();
  await panel.getByText('模型目录读取失败，可刷新状态重试。', { exact: true }).waitFor();
  await panel.getByLabel('API Key', { exact: true }).fill('synthetic-independent-key');
  await panel.getByRole('button', { name: '保存 API Key', exact: true }).click();
  await panel.getByText('API Key 已保存到 Windows 凭据管理器。', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: '删除已保存凭据', exact: true }).isEnabled(), true);
  assert.equal(await panel.getByRole('button', { name: '测试连接', exact: true }).isDisabled(), true);
  assert.equal((await panel.innerText()).includes('synthetic-model-private'), false);
  await page.evaluate(() => { window.fixture.failModelsFor = null; window.fixture.emptyModelsFor = 'deepseek'; });
  await panel.getByRole('button', { name: '刷新状态', exact: true }).click();
  await panel.getByText('该服务商暂无模型。可刷新状态，或在“自定义配置”中添加兼容服务商。', { exact: true }).waitFor();
  assert.equal(await panel.getByText('模型目录读取失败，可刷新状态重试。', { exact: true }).count(), 0);
  await page.evaluate(() => { window.fixture.emptyModelsFor = null; window.fixture.failCredentialStatusFor = 'deepseek'; });
  await panel.getByRole('button', { name: '刷新状态', exact: true }).click();
  await panel.getByText('无法访问系统凭据管理器，请稍后重试。', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('API Key', { exact: true }).isDisabled(), true);
  assert.equal(await panel.getByRole('button', { name: '保存 API Key', exact: true }).isDisabled(), true);
  assert.equal(await panel.getByRole('button', { name: '测试连接', exact: true }).isDisabled(), true);
  assert.equal((await panel.innerText()).includes('synthetic-credential-private'), false);
  await page.evaluate(() => { window.fixture.failCredentialStatusFor = null; });
  await panel.getByRole('button', { name: '刷新状态', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.provider-editor[aria-busy="true"]'));
  assert.equal(await panel.getByRole('button', { name: '测试连接', exact: true }).isEnabled(), true);
  await page.evaluate(() => { window.fixture.failTest = true; });
  await panel.getByRole('button', { name: '测试连接', exact: true }).click();
  const connection = panel.getByRole('region', { name: '2. 测试模型连接', exact: true });
  await connection.getByRole('alert').filter({ hasText: '连接失败，请检查 API Key、模型权限或网络。' }).waitFor();
  assert.equal(await panel.getByRole('region', { name: '1. 保存访问凭据', exact: true }).getByRole('alert').count(), 0);
  assert.equal(await panel.getByRole('button', { name: '删除已保存凭据', exact: true }).isEnabled(), true);
  assert.equal((await panel.innerText()).includes('synthetic-test-private'), false);
}));

test("自定义配置读取失败可恢复，重试后表单可保存并进入凭据设置", async () => fixture(async (page, panel) => {
  await page.evaluate(() => { window.fixture.failConfigList = true; });
  await panel.getByRole('button', { name: '自定义配置', exact: true }).click();
  await panel.getByRole('button', { name: '重试读取配置', exact: true }).waitFor();
  assert.equal(await panel.getByLabel('配置标识', { exact: true }).isDisabled(), true);
  assert.equal((await panel.innerText()).includes('synthetic-config-private'), false);
  await page.evaluate(() => { window.fixture.failConfigList = false; });
  await panel.getByRole('button', { name: '重试读取配置', exact: true }).click();
  await panel.getByText('暂无自定义服务商。', { exact: true }).waitFor();
  await panel.getByLabel('配置标识', { exact: true }).fill('custom-recovered');
  await panel.getByLabel('显示名称', { exact: true }).fill('重试恢复的服务商');
  await panel.getByLabel('API 基础地址', { exact: true }).fill('https://model.example.test/v1');
  await panel.getByLabel('模型 ID', { exact: true }).fill('recovered-model');
  await panel.getByRole('button', { name: '保存配置', exact: true }).click();
  await panel.getByText('配置已保存。', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('服务商', { exact: true }).inputValue(), 'custom-recovered');
  await panel.getByRole('heading', { name: '1. 保存访问凭据', exact: true }).waitFor();
  await panel.getByRole('heading', { name: '2. 测试模型连接', exact: true }).waitFor();
}));


test("按会话恢复草稿，搜索隐藏后仍可找回，清空与重新打开不留下持久内容", async () => fixture(async (page) => {
  const input = page.getByLabel('消息内容', { exact: true });
  await input.fill('甲的多行草稿\n第二行');
  await page.getByRole('button', { name: /会话乙/ }).click();
  assert.equal(await input.inputValue(), '');
  await input.fill('乙的独立草稿');
  await page.getByRole('button', { name: /会话甲/ }).click();
  assert.equal(await input.inputValue(), '甲的多行草稿\n第二行');
  await page.getByLabel('搜索会话标题', { exact: true }).fill('没有的标题');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByText('没有匹配标题的会话。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await input.waitFor();
  assert.equal(await input.inputValue(), '甲的多行草稿\n第二行');
  await input.fill('');
  await page.getByRole('button', { name: /会话乙/ }).click();
  assert.equal(await input.inputValue(), '乙的独立草稿');
  await page.getByRole('button', { name: /会话甲/ }).click();
  assert.equal(await input.inputValue(), '');
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, window.fixture.submitArgs.length]), [0, 0, 0]);
  await page.reload();
  await input.waitFor();
  assert.equal(await input.inputValue(), '');
}, true));

test("未确认消息切换会话后仍沿用原请求，确认后清空自身草稿", async () => fixture(async (page) => {
  const input = page.getByLabel('消息内容', { exact: true });
  await page.evaluate(() => { window.fixture.failSubmitOnce = true; });
  await input.fill('跨会话核对同一条消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '重试同一请求', exact: true }).waitFor();
  await page.getByRole('button', { name: /会话乙/ }).click();
  await input.fill('乙的草稿不能被甲清除');
  await page.getByRole('button', { name: /会话甲/ }).click();
  assert.equal(await input.inputValue(), '跨会话核对同一条消息');
  assert.equal(await input.isDisabled(), true);
  await page.getByRole('button', { name: '重试同一请求', exact: true }).click();
  await page.waitForFunction(() => window.fixture.submitArgs.length === 2);
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息内容"]').disabled);
  const result = await page.evaluate(() => ({ args: window.fixture.submitArgs, count: Object.keys(window.fixture.submissions).length }));
  assert.deepEqual(result.args[0], result.args[1]);
  assert.equal(result.count, 1);
  await page.getByRole('button', { name: /会话乙/ }).click();
  assert.equal(await input.inputValue(), '乙的草稿不能被甲清除');
  await page.getByRole('button', { name: /会话甲/ }).click();
  assert.equal(await input.inputValue(), '');
}, true));

test("发送的迟到确认只清理源草稿，明确拒绝的消息保留为可编辑草稿", async () => fixture(async (page) => {
  const input = page.getByLabel('消息内容', { exact: true });
  await page.evaluate(() => { window.fixture.holdSubmitReply = true; });
  await input.fill('甲已发送等待确认');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(() => typeof window.fixture.releaseSubmitReply === 'function');
  await page.getByRole('button', { name: /会话乙/ }).click();
  await input.fill('乙未发送的草稿');
  await page.evaluate(() => { window.fixture.holdSubmitReply = false; window.fixture.releaseSubmitReply(); });
  await page.getByRole('button', { name: /会话甲/ }).click();
  assert.equal(await input.inputValue(), '');
  await page.getByRole('button', { name: /会话乙/ }).click();
  assert.equal(await input.inputValue(), '乙未发送的草稿');
  await page.evaluate(() => { window.fixture.rejectSubmitOnce = true; });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '请先在服务商设置中保存 API Key。' }).waitFor();
  await page.getByRole('button', { name: /会话甲/ }).click();
  await page.getByRole('button', { name: /会话乙/ }).click();
  assert.equal(await input.inputValue(), '乙未发送的草稿');
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息内容"]').disabled);
  await input.fill('乙可修改后重新发送');
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isEnabled(), true);
}, true));


test("工作台在桌面和紧凑窗口始终保留输入与发送，长消息和长列表独立滚动", async () => fixture(async (page) => {
  await page.evaluate(() => {
    const f = window.fixture;
    f.conversations = Array.from({ length: 40 }, (_, i) => ({ id: 40-i, title: '会话 ' + (40-i), createdAt: i+1 }));
    f.entries[40] = Array.from({ length: 20 }, (_, i) => ({ id: i+1, kind: i%2 ? 'pi.assistant' : 'studio.chat-input', data: null,
      model: [{ role: i%2 ? 'assistant' : 'user', content: ('足够长的实际消息内容\n').repeat(15), stopReason: 'stop' }] }));
  });
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.transcript-entry').length === 20);
  for (const size of [{width:1280,height:800},{width:1000,height:700},{width:705,height:564}]) {
    await page.setViewportSize(size);
    await page.locator('.transcript-list').evaluate(el => { el.scrollTop = 0; });
    const input = await page.getByLabel('消息内容', { exact:true }).boundingBox();
    const send = await page.getByRole('button', {name:'发送消息',exact:true}).boundingBox();
    assert.ok(input.y >= 0 && input.y+input.height <= size.height, '输入框须保持在窗口内');
    assert.ok(send.y >= 0 && send.y+send.height <= size.height, '发送按钮须保持在窗口内');
    assert.equal(await page.locator('.conversation-sidebar').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight+1), true);
  }
  await page.getByRole('button', {name:'回到最新',exact:true}).click();
  assert.equal(await page.locator('.transcript-list').evaluate(el => Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<2), true);
}, true));

test("窄屏可在列表与对话之间切换并保留草稿，详情可用键盘关闭", async () => fixture(async (page) => {
  await page.setViewportSize({width:390,height:844});
  const input = page.getByLabel('消息内容', {exact:true});
  await input.fill('窄屏甲草稿');
  await page.getByRole('button',{name:'☰ 会话列表',exact:true}).click();
  assert.equal(await input.isVisible(), false);
  await page.getByRole('button',{name:/会话乙/}).click();
  await input.fill('窄屏乙草稿');
  await page.getByRole('button',{name:'☰ 会话列表',exact:true}).click();
  await page.getByRole('button',{name:/会话甲/}).click();
  assert.equal(await input.inputValue(), '窄屏甲草稿');
  await page.locator('.conversation-inspector > summary').click();
  await page.getByRole('region',{name:'会话用量',exact:true}).waitFor();
  await page.locator('.conversation-inspector > summary').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('region',{name:'会话用量',exact:true}).isVisible(), false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), true);
  await page.setViewportSize({width:507,height:394});
  const inputBox=await input.boundingBox();
  const sendBox=await page.getByRole('button',{name:'发送消息',exact:true}).boundingBox();
  assert.ok(inputBox.y>=0 && inputBox.y+inputBox.height<=394);
  assert.ok(sendBox.y>=0 && sendBox.y+sendBox.height<=394);
}, true));

test("空工作台可直接创建真实会话或打开服务商配置", async () => fixture(async (page) => {
  const nav=page.getByRole('navigation',{name:'工作区导航'});
  await nav.getByRole('button',{name:'会话',exact:true}).click();
  await page.getByRole('heading',{name:'从一个想法开始',exact:true}).waitFor();
  await page.getByRole('button',{name:'配置服务商',exact:true}).click();
  await page.getByRole('heading',{name:'服务商与模型',exact:true}).waitFor();
  await nav.getByRole('button',{name:'会话',exact:true}).click();
  await page.getByRole('button',{name:'新建会话',exact:true}).click();
  await page.getByLabel('消息内容',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.fixture.conversations.length),1);
  assert.equal(await page.getByRole('heading',{name:'新建会话',exact:true}).count(),1);
}));


test("历史服务商已删除时恢复有效目录，目录先后返回均不请求失效配置", async () => fixture(async (page) => {
  for (const delay of [0, 200]) {
    await page.getByRole('button',{name:/会话乙/}).click();
    await page.evaluate(value => {
      const f=window.fixture; f.providerDelay=value; f.modelArgs=[];
      f.statuses[1].model={providerId:'custom-deleted',modelId:'removed-model'};
    }, delay);
    await page.getByRole('button',{name:/会话甲/}).click();
    await page.waitForFunction(()=>document.querySelector('[aria-label="对话服务商"]').value==='deepseek' &&
      document.querySelector('[aria-label="对话模型"]').value==='deepseek-model' && !document.querySelector('textarea').disabled);
    assert.equal(await page.evaluate(()=>window.fixture.modelArgs.includes('custom-deleted')),false);
  }
}, true));


test("切换至有效模型目录后清除旧模型错误且保留输入", async () => fixture(async (page) => {
  await page.getByLabel('消息内容',{exact:true}).fill('恢复模型目录后仍保留');
  await page.evaluate(()=>{window.fixture.failModelsFor='deepseek';});
  await page.getByRole('button',{name:'选择模型',exact:true}).click();
  await page.getByRole('button',{name:'刷新模型目录',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'模型目录读取失败'}).waitFor();
  await page.getByRole('button',{name:'选择模型',exact:true}).click();
  await page.getByLabel('对话服务商',{exact:true}).selectOption('other');
  await page.waitForFunction(()=>document.querySelector('[aria-label="对话模型"]').value==='other-model');
  await page.getByRole('button',{name:'关闭模型菜单',exact:true}).click();
  assert.equal(await page.getByRole('alert').filter({hasText:'模型目录读取失败'}).count(),0);
  assert.equal(await page.getByLabel('消息内容',{exact:true}).inputValue(),'恢复模型目录后仍保留');
},true));


test("黑曜视觉保留可读对比、键盘焦点和减少动态效果，设置页在窄窗可操作", async () => fixture(async (page, panel) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const nav = page.getByRole("navigation", { name: "工作区导航" });
  const chat = nav.getByRole("button", { name: "会话", exact: true });
  await chat.click();
  await page.getByLabel("消息内容", { exact: true }).focus();
  const accessibility = await page.getByLabel("消息内容", { exact: true }).evaluate(element => {
    const style = getComputedStyle(element);
    const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = color => rgb(color).map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    // Conservative comparison with the lighter end of the input card gradient.
    const background = luminance("rgb(32, 32, 39)");
    const contrast = color => (luminance(color) + .05) / (background + .05);
    return { text: contrast(style.color), placeholder: contrast(getComputedStyle(element, "::placeholder").color),
      outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth),
      transition: getComputedStyle(element.closest(".chat-panel")).transitionDuration };
  });
  assert.ok(accessibility.text >= 4.5);
  assert.ok(accessibility.placeholder >= 4.5);
  assert.equal(accessibility.outline, "solid");
  assert.ok(accessibility.outlineWidth >= 2);
  assert.equal(accessibility.transition, "0s");
  // Decorative icons must not change the navigation's accessible names.
  assert.equal(await chat.getAttribute("aria-current"), "page");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await nav.getByRole("button", { name: "服务商", exact: true }).click();
    for (const mode of ["密钥与连接", "自定义配置"]) {
      await panel.getByRole("button", { name: mode, exact: true }).click();
      assert.equal(await panel.getByRole("button", { name: mode, exact: true }).getAttribute("aria-pressed"), "true");
      const geometry = await panel.evaluate(element => ({
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        fieldsInside: [...element.querySelectorAll("input, select")].every(field => {
          const box = field.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth;
        }),
      }));
      assert.ok(geometry.pageWidth <= geometry.viewportWidth);
      assert.ok(geometry.fieldsInside);
    }
  }
}, true));


test("主题首次跟随系统，手动切换保留草稿且重开后记住选择", async () => fixture(async page => {
  const theme = () => page.locator("html").getAttribute("data-theme");
  assert.equal(await theme(), "dark");
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await page.getByLabel("消息内容", { exact: true }).fill("明暗切换仍保留的草稿");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await page.getByRole("button", { name: "切换至深色模式", exact: true }).click();
  assert.equal(await theme(), "dark");
  assert.equal(await page.getByLabel("消息内容", { exact: true }).inputValue(), "明暗切换仍保留的草稿");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal(await theme(), "dark");
  await page.reload();
  await page.getByRole("button", { name: "切换至浅色模式", exact: true }).waitFor();
  assert.equal(await theme(), "dark");
  await page.getByRole("button", { name: "切换至浅色模式", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "切换至深色模式", exact: true }).waitFor();
  assert.equal(await theme(), "light");
  assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), localStorage.getItem("pi-studio.theme"), sessionStorage.length]), [["pi-studio.theme"], "light", 0]);
}, true));

test("浅色模式下消息代码与设置保持可读，窄窗导航和发送可用", async () => fixture(async (page, panel) => {
  await page.getByRole("button", { name: "切换至浅色模式", exact: true }).click();
  await page.evaluate(() => {
    fixture.entries[1] = [{ id: 2, kind: "pi.assistant", data: null, model: [{ role: "assistant", content: [{ type: "text", text: "浅色阅读验证\n\n~~~ts\nconst theme = 'light';\n~~~" }], stopReason: "stop" }] }];
    fixture.stored.deepseek = true;
  });
  await page.getByRole("button", { name: "刷新历史", exact: true }).click();
  await page.locator(".message-code pre code").waitFor();
  const codeContrast = await page.locator(".message-code pre code").evaluate(element => {
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const text = luminance(getComputedStyle(element).color);
    const background = luminance(getComputedStyle(element.closest(".message-code")).backgroundColor);
    return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
  });
  assert.ok(codeContrast >= 4.5);
  const nav = page.getByRole("navigation", { name: "工作区导航" });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const controls = await page.evaluate(() => {
      const theme = document.querySelector(".theme-toggle").getBoundingClientRect();
      const send = [...document.querySelectorAll("button")].find(button => button.textContent.includes("发送消息")).getBoundingClientRect();
      return { fits: theme.left >= 0 && theme.right <= innerWidth && send.right <= innerWidth && send.bottom <= innerHeight,
        pageFits: document.documentElement.scrollWidth <= innerWidth };
    });
    assert.ok(controls.fits && controls.pageFits);
    await nav.getByRole("button", { name: "服务商", exact: true }).click();
    await panel.getByLabel("API Key", { exact: true }).waitFor();
    assert.equal(await panel.getByLabel("API Key", { exact: true }).getAttribute("type"), "password");
    assert.ok(await panel.evaluate(element => [...element.querySelectorAll("input, select")].every(field => field.getBoundingClientRect().right <= innerWidth)));
    await nav.getByRole("button", { name: "会话", exact: true }).click();
  }
  await nav.getByRole("button", { name: "服务商", exact: true }).click();
  await panel.getByLabel("API Key", { exact: true }).fill("synthetic-theme-key");
  await page.getByRole("button", { name: "切换至深色模式", exact: true }).click();
  assert.equal(await panel.getByLabel("API Key", { exact: true }).inputValue(), "synthetic-theme-key");
  assert.equal(await page.evaluate(() => Object.values(localStorage).includes("synthetic-theme-key")), false);
}, true));

test("主题偏好无法读取或保存时仍可切换界面", async () => fixture(async page => {
  await page.addInitScript(() => {
    Object.defineProperty(Storage.prototype, "getItem", { value() { throw new Error("blocked"); } });
    Object.defineProperty(Storage.prototype, "setItem", { value() { throw new Error("blocked"); } });
  });
  await page.reload();
  await page.getByRole("button", { name: "切换至浅色模式", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByLabel("消息内容", { exact: true }).fill("仍能输入");
  assert.equal(await page.getByLabel("消息内容", { exact: true }).inputValue(), "仍能输入");
}, true));


test("四套主题与阅读外观即时生效，重新打开恢复选择", async () => fixture(async page => {
  const nav = page.getByRole("navigation", { name: "工作区导航" });
  await nav.getByRole("button", { name: "外观", exact: true }).click();
  for (const [name, palette, theme] of [
    ["暖炭玄岩", "warm", "dark"], ["暖白画册", "alabaster", "light"],
    ["白昼冷晶", "crystal", "light"], ["深空黑曜", "obsidian", "dark"],
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.palette, document.documentElement.dataset.theme]), [palette, theme]);
    assert.equal(await page.getByRole("button", { name, exact: true }).getAttribute("aria-pressed"), "true");
  }
  await page.getByLabel("强调色", { exact: true }).selectOption("iris");
  await page.getByLabel("圆角", { exact: true }).selectOption("soft");
  await page.getByLabel("代码字体", { exact: true }).selectOption("cascadia");
  await page.getByLabel("代码连字", { exact: true }).check();
  await page.getByLabel("阅读宽度", { exact: true }).selectOption("wide");
  await page.getByLabel("侧栏密度", { exact: true }).selectOption("compact");
  await page.reload();
  assert.deepEqual(await page.evaluate(() => {
    const d = document.documentElement.dataset;
    return [d.palette, d.accent, d.corners, d.codeFont, d.ligatures, d.readingWidth, d.density];
  }), ["obsidian", "iris", "soft", "cascadia", "true", "wide", "compact"]);
  await nav.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByRole("button", { name: "静默省电", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.motion, document.documentElement.dataset.ambient, getComputedStyle(document.querySelector(".theme-toggle")).transitionDuration]), ["off", "off", "0s"]);
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "跟随系统", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByLabel("强调色", { exact: true }).inputValue(), "theme");
}, true));

test("外观备份可导入导出，额外字段和大文件被拒绝且不泄露内容", async () => fixture(async page => {
  await page.getByRole("navigation", { name: "工作区导航" }).getByRole("button", { name: "外观", exact: true }).click();
  await page.getByRole("button", { name: "暖白画册", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出外观", exact: true }).click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), "pi-studio-appearance.json");
  const { readFile } = await import("node:fs/promises");
  const backup = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.deepEqual(Object.keys(backup).sort(), ["appearance", "mode", "version"]);
  assert.equal(backup.mode, "light");
  await page.getByRole("button", { name: "深空黑曜", exact: true }).click();
  const upload = page.getByLabel("导入外观文件", { exact: true });
  await upload.setInputFiles({ name: "appearance.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await page.getByText("外观已导入。", { exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-palette"), "alabaster");
  const original = await page.evaluate(() => localStorage.getItem("pi-studio.appearance"));
  for (const invalid of [
    JSON.stringify({ ...backup, apiKey: "synthetic-must-never-render" }),
    JSON.stringify({ ...backup, appearance: { ...backup.appearance, accent: "url(private)" } }),
    " ".repeat(17000),
  ]) {
    await upload.setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from(invalid) });
    await page.getByText("配置文件无效，未修改外观。", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("pi-studio.appearance")), original);
    assert.equal((await page.locator("body").innerText()).includes("synthetic-must-never-render"), false);
  }
}, true));

test("离开外观页后迟到的导入不能覆盖当前界面", async () => fixture(async page => {
  await page.getByRole("navigation", { name: "工作区导航" }).getByRole("button", { name: "外观", exact: true }).click();
  const backup = await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      if (this.name === "late.json") return new Promise(resolve => { window.releaseAppearanceImport = resolve; });
      return original.call(this);
    };
    return { version: 1, mode: "light", appearance: { darkPalette: "warm", lightPalette: "alabaster", accent: "iris", corners: "soft", codeFont: "default", density: "compact", motion: "off", ambient: "off", width: "wide", ligatures: false, scroll: "smooth" } };
  });
  await page.getByLabel("导入外观文件", { exact: true }).setInputFiles({ name: "late.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await page.waitForFunction(() => typeof window.releaseAppearanceImport === "function");
  await page.getByRole("navigation", { name: "工作区导航" }).getByRole("button", { name: "会话", exact: true }).click();
  await page.evaluate(value => window.releaseAppearanceImport(JSON.stringify(value)), backup);
  await page.waitForTimeout(30);
  assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.palette, localStorage.getItem("pi-studio.appearance")]), ["obsidian", null]);
}, true));

test("模型弹层支持搜索、服务商切换与 Escape，选择后保留草稿", async () => fixture(async page => {
  await page.evaluate(() => {
    fixture.modelsByProvider = { deepseek: [
      { id: "deepseek-model", name: "DeepSeek Chat", api: "openai-completions", contextWindow: 64000, maxTokens: 4096 },
      { id: "reasoner", name: "DeepSeek Reasoner", api: "openai-completions" },
      { id: "unsupported", name: "Unsupported", api: "unknown" },
    ] };
  });
  await page.getByLabel("消息内容", { exact: true }).fill("模型选择时保留的草稿");
  const trigger = page.getByRole("button", { name: "选择模型", exact: true });
  await trigger.click();
  const picker = page.getByRole("dialog", { name: "模型选择", exact: true });
  await picker.getByRole("button", { name: "刷新模型目录", exact: true }).click();
  await trigger.click();
  await picker.getByRole("option", { name: "DeepSeek Reasoner · reasoner", exact: true }).waitFor();
  await picker.getByLabel("搜索模型", { exact: true }).fill("reason");
  assert.equal(await picker.getByLabel("对话模型", { exact: true }).getByRole("option").count(), 2);
  await picker.getByLabel("对话模型", { exact: true }).selectOption("reasoner");
  await picker.waitFor({ state: "hidden" });
  assert.equal(await trigger.innerText().then(text => text.includes("DeepSeek Reasoner")), true);
  assert.equal(await page.getByLabel("消息内容", { exact: true }).inputValue(), "模型选择时保留的草稿");
  await trigger.click();
  await picker.getByLabel("搜索模型", { exact: true }).fill("no-matches");
  await picker.getByText("没有匹配模型。", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByLabel("对话模型", { exact: true }).inputValue(), "reasoner");
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
  await trigger.click();
  await picker.getByLabel("对话服务商", { exact: true }).selectOption("other");
  await page.waitForFunction(() => document.querySelector('[aria-label="对话模型"]').value === "other-model");
  await picker.getByRole("button", { name: "关闭模型菜单", exact: true }).click();
  assert.equal(await page.evaluate(() => fixture.submitArgs.length), 0);
}, true));

test("后台状态进入生成时关闭模型弹层并禁止更改当前模型", async () => fixture(async page => {
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.evaluate(() => { fixture.statuses[1].running = true; });
  await page.getByRole("dialog", { name: "模型选择", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "选择模型", exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("对话服务商", { exact: true }).isDisabled(), true);
}, true));

test("长代码默认完整显示，可手动收起展开，折叠后仍复制完整代码", async () => fixture(async page => {
  await page.evaluate(() => {
    const code = Array.from({ length: 60 }, (_, index) => "const value" + index + " = " + index + ";").join("\n");
    fixture.longCode = code + "\n";
    fixture.entries[1] = [
      { id: 1, kind: "pi.assistant", data: null, model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "~~~ts\n" + code + "\n~~~" }] }] },
      { id: 2, kind: "studio.chat-input", data: null, model: [{ role: "user", content: "后续问题\n".repeat(100) }] },
    ];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { fixture.copiedCode = value; } } });
  });
  await page.getByRole("button", { name: "刷新历史", exact: true }).click();
  const block = page.locator(".message-code");
  const fold = block.getByRole("button", { name: "收起代码 · 60 行", exact: true });
  await fold.waitFor();
  assert.ok((await block.locator("pre").boundingBox()).height > 500);
  await fold.scrollIntoViewIfNeeded();
  const before = await block.locator(".message-code-heading").boundingBox();
  await fold.click();
  assert.ok((await block.locator("pre").boundingBox()).height <= 192);
  assert.equal(await block.getByRole("button", { name: "展开代码 · 60 行", exact: true }).getAttribute("aria-expanded"), "false");
  const after = await block.locator(".message-code-heading").boundingBox();
  assert.ok(Math.abs(before.y - after.y) < 8);
  await block.getByRole("button", { name: "复制代码", exact: true }).click();
  assert.equal(await page.evaluate(() => fixture.copiedCode === fixture.longCode), true);
  await block.getByRole("button", { name: "展开代码 · 60 行", exact: true }).click();
  assert.ok((await block.locator("pre").boundingBox()).height > 500);
}, true));

test("对话大纲搜索已加载问题并跳转，分页及键盘跳转不干扰输入", async () => fixture(async page => {
  await page.evaluate(() => {
    fixture.realEntryPages = true;
    fixture.entries[1] = Array.from({ length: 40 }, (_, index) => ({
      id: index + 1, kind: index % 2 ? "pi.assistant" : "studio.chat-input", data: null,
      model: [{ role: index % 2 ? "assistant" : "user", content: index % 2 ? [{ type: "text", text: "回复内容\n".repeat(8) }] : "问题 " + ((index + 2) / 2), stopReason: "stop" }],
    }));
  });
  await page.getByRole("button", { name: "刷新历史", exact: true }).click();
  const outline = page.locator(".conversation-outline");
  await outline.locator("summary").click();
  assert.equal(await outline.locator("[data-question-id]").count(), 5);
  await page.getByLabel("搜索对话大纲", { exact: true }).fill("问题 18");
  await outline.locator('[data-question-id="35"]').click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-entry-id") === "35");
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-entry-id") === "37");
  await page.keyboard.press("Alt+ArrowUp");
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-entry-id") === "35");
  await page.getByLabel("消息内容", { exact: true }).fill("Alt 组合键不影响草稿");
  const top = await page.locator(".transcript-list").evaluate(element => element.scrollTop);
  await page.keyboard.press("Alt+ArrowDown");
  assert.equal(await page.locator(".transcript-list").evaluate(element => element.scrollTop), top);
  await outline.locator("summary").click();
  await page.getByLabel("搜索对话大纲", { exact: true }).fill("");
  await outline.getByRole("button", { name: "加载更早问题", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-question-id]").length === 10);
  await page.getByLabel("搜索对话大纲", { exact: true }).focus();
  await page.keyboard.press("Escape");
  assert.equal(await outline.getAttribute("open"), null);
  assert.equal(await page.getByLabel("消息内容", { exact: true }).inputValue(), "Alt 组合键不影响草稿");
}, true));


test("模型弹层在紧凑窗口内可搜索和关闭，恢复输入焦点路径", async () => fixture(async page => {
  await page.getByLabel("消息内容", { exact: true }).fill("窄窗仍保留的草稿");
  for (const [width, height] of [[1280, 850], [705, 564], [390, 844], [320, 394]]) {
    await page.setViewportSize({ width, height });
    const trigger = page.getByRole("button", { name: "选择模型", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "模型选择", exact: true });
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 10 && box.y >= 10 && box.x + box.width <= width - 10 && box.y + box.height <= height - 10);
    await dialog.getByLabel("搜索模型", { exact: true }).fill("deep");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.getByLabel("消息内容", { exact: true }).inputValue(), "窄窗仍保留的草稿");
  }
}, true));


test("侧栏新建可按需命名，创建后收起命名框并保留原会话", async () => fixture(async page => {
  const naming = page.locator(".conversation-naming");
  assert.equal(await naming.getAttribute("open"), null);
  await naming.locator("summary").click();
  await page.getByLabel("会话标题", { exact: true }).fill("新命名会话");
  await page.getByRole("button", { name: "＋ 新建会话", exact: true }).click();
  await page.locator(".conversation-item.active").filter({ hasText: "新命名会话" }).waitFor();
  assert.equal(await naming.getAttribute("open"), null);
  assert.equal(await page.evaluate(() => fixture.conversations.length), 3);
  assert.equal(await page.getByLabel("会话标题", { exact: true }).inputValue(), "");
}, true));

test("推理滑杆只显示原生可用档位，提交与会话重新打开保留实际选择", async () => fixture(async page => {
  await page.evaluate(() => {
    fixture.modelsByProvider = { deepseek: [{ id: "deepseek-model", name: "Reasoner", api: "openai-completions", thinkingLevels: ["low", "high", "xhigh"] }] };
  });
  const trigger = page.getByRole("button", { name: "选择模型", exact: true });
  await trigger.click();
  await page.getByRole("button", { name: "刷新模型目录", exact: true }).click();
  await trigger.click();
  const slider = page.getByRole("slider", { name: "推理强度", exact: true });
  await slider.waitFor();
  assert.equal(await slider.getAttribute("aria-valuetext"), "低");
  assert.equal(await page.locator(".thinking-ticks").innerText(), "低\n高\n极高");
  await slider.focus();
  await page.keyboard.press("End");
  assert.equal(await slider.getAttribute("aria-valuetext"), "极高");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await slider.getAttribute("aria-valuetext"), "高");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => fixture.submitArgs.length), 0);
  await page.getByLabel("消息内容", { exact: true }).fill("使用真实推理档位");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.waitForFunction(() => fixture.submitArgs.length === 1 && !document.querySelector('[aria-label="消息内容"]').disabled);
  assert.equal(await page.evaluate(() => fixture.submitArgs[0].thinkingLevel), "high");
  await page.getByRole("button", { name: /会话乙.*#2/ }).click();
  await page.getByRole("button", { name: /会话甲.*#1/ }).click();
  await trigger.click();
  assert.equal(await slider.getAttribute("aria-valuetext"), "高");
  await page.keyboard.press("Escape");
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
}, true));

test("推理参数随未确认请求按会话保留，重试不改变档位或重复创建输入", async () => fixture(async page => {
  await page.evaluate(() => {
    fixture.modelsByProvider = { deepseek: [{ id: "deepseek-model", name: "Reasoner", api: "openai-completions", thinkingLevels: ["off", "low", "high"] }] };
    fixture.failSubmitOnce = true;
  });
  const trigger = page.getByRole("button", { name: "选择模型", exact: true });
  await trigger.click();
  await page.getByRole("button", { name: "刷新模型目录", exact: true }).click();
  await trigger.click();
  const slider = page.getByRole("slider", { name: "推理强度", exact: true });
  await slider.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Escape");
  await page.getByLabel("消息内容", { exact: true }).fill("待确认的推理消息");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.getByRole("button", { name: "重试同一请求", exact: true }).waitFor();
  assert.equal(await trigger.isDisabled(), true);
  await page.getByRole("button", { name: /会话乙.*#2/ }).click();
  await page.getByRole("button", { name: /会话甲.*#1/ }).click();
  await page.getByRole("button", { name: "重试同一请求", exact: true }).click();
  await page.waitForFunction(() => fixture.submitArgs.length === 2 && !document.querySelector('[aria-label="消息内容"]').disabled);
  const inputs = await page.evaluate(() => fixture.submitArgs);
  assert.deepEqual(inputs[0], inputs[1]);
  assert.equal(inputs[0].thinkingLevel, "high");
  assert.equal(await page.evaluate(() => Object.keys(fixture.submissions).length), 1);
}, true));

test("非推理模型不显示滑杆，切换模型后不携带旧模型档位，窄窗仍可调整", async () => fixture(async page => {
  await page.evaluate(() => {
    fixture.modelsByProvider = { deepseek: [
      { id: "deepseek-model", name: "Reasoner", api: "openai-completions", thinkingLevels: ["off", "low", "high"] },
      { id: "plain", name: "Plain", api: "openai-completions", thinkingLevels: ["off"] },
    ] };
  });
  const trigger = page.getByRole("button", { name: "选择模型", exact: true });
  await trigger.click();
  await page.getByRole("button", { name: "刷新模型目录", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 394 });
  await trigger.click();
  const slider = page.getByRole("slider", { name: "推理强度", exact: true });
  await slider.scrollIntoViewIfNeeded();
  await slider.focus();
  await page.keyboard.press("End");
  assert.equal(await slider.getAttribute("aria-valuetext"), "高");
  const box = await page.getByRole("dialog", { name: "模型选择", exact: true }).boundingBox();
  assert.ok(box.x >= 10 && box.y >= 10 && box.x + box.width <= 310 && box.y + box.height <= 384);
  await page.getByLabel("对话模型", { exact: true }).selectOption("plain");
  await trigger.click();
  assert.equal(await slider.count(), 0);
  await page.keyboard.press("Escape");
  await page.getByLabel("消息内容", { exact: true }).fill("普通模型不携带推理档位");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.waitForFunction(() => fixture.submitArgs.length === 1);
  assert.equal(await page.evaluate(() => fixture.submitArgs[0].thinkingLevel ?? "off"), "off");
}, true));

test("模型胶囊有悬停扫光与按压反馈，弹层状态和草稿保持一致", async () => fixture(async page => {
  await page.bringToFront();
  await page.getByLabel("消息内容", { exact: true }).fill("动效不改变草稿");
  const trigger = page.getByRole("button", { name: "选择模型", exact: true });
  const box = await trigger.boundingBox();
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  const first = await trigger.evaluate(element => element.style.getPropertyValue("--reflect-x"));
  await page.mouse.move(box.x + box.width - 15, box.y + box.height / 2);
  assert.notEqual(await trigger.evaluate(element => element.style.getPropertyValue("--reflect-x")), first);
  assert.ok(await trigger.evaluate(element => element.getAnimations({ subtree: true }).some(animation => animation.animationName === "capsule-sheen" && animation.playState === "running")));
  await page.mouse.down();
  await page.waitForTimeout(250);
  assert.ok(await trigger.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a < 1));
  await page.mouse.up();
  const dialog = page.getByRole("dialog", { name: "模型选择", exact: true });
  await dialog.waitFor();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".model-picker-trigger").getAttribute("aria-expanded") === "false");
  await page.mouse.move(1, 1);
  assert.equal(await trigger.evaluate(element => element.style.getPropertyValue("--reflect-x")), "");
  assert.equal(await page.getByLabel("消息内容", { exact: true }).inputValue(), "动效不改变草稿");
  assert.equal(await page.evaluate(() => fixture.submitArgs.length), 0);
}, true));

test("切档充能与流光真实运动，窗口失焦暂停、恢复焦点继续且关闭菜单后停止", async () => fixture(async page => {
  await page.bringToFront();
  await page.evaluate(() => {
    fixture.modelsByProvider = { deepseek: [{ id: "deepseek-model", name: "Reasoner", api: "openai-completions", thinkingLevels: ["off", "low", "high", "xhigh", "max"] }] };
  });
  const trigger = page.getByRole("button", { name: "选择模型", exact: true });
  await trigger.click();
  await page.getByRole("button", { name: "刷新模型目录", exact: true }).click();
  await trigger.click();
  const slider = page.getByRole("slider", { name: "推理强度", exact: true });
  await slider.focus();
  const before = await page.locator(".thinking-energy").evaluate(element => element.getBoundingClientRect().width);
  await page.keyboard.press("End");
  await page.waitForTimeout(220);
  assert.equal(await slider.getAttribute("aria-valuetext"), "最高");
  assert.ok((await page.locator(".thinking-energy").evaluate(element => element.getBoundingClientRect().width)) > before + 150);
  const orbit = page.locator(".thinking-control .model-orbit");
  const time = () => orbit.evaluate(element => element.getAnimations().find(animation => animation.animationName === "capsule-orbit")?.currentTime);
  const start = await time();
  await page.waitForTimeout(120);
  assert.ok(await time() > start + 50);
  assert.equal(await page.locator(".thinking-energy").evaluate(element => getComputedStyle(element, "::after").animationName), "capsule-sheen");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  assert.equal(await orbit.evaluate(element => getComputedStyle(element).animationPlayState), "paused");
  const paused = await time();
  await page.waitForTimeout(120);
  assert.ok(Math.abs(await time() - paused) < 20);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(120);
  assert.ok(await time() > paused + 50);
  await page.keyboard.press("Escape");
  await page.mouse.move(1, 1);
  await page.getByLabel("消息内容", { exact: true }).focus();
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running" && animation.effect?.getTiming().iterations === Infinity).length), 0);
  assert.equal(await page.evaluate(() => fixture.submitArgs.length), 0);
}, true));

test("明暗主题与窄窗保留胶囊可操作性，关闭动效和系统减少动态效果均生效", async () => fixture(async page => {
  await page.bringToFront();
  await page.evaluate(() => {
    fixture.modelsByProvider = { deepseek: [{ id: "deepseek-model", name: "Reasoner", api: "openai-completions", thinkingLevels: ["off", "high", "xhigh"] }] };
  });
  const trigger = page.getByRole("button", { name: "选择模型", exact: true });
  await trigger.click();
  await page.getByRole("button", { name: "刷新模型目录", exact: true }).click();
  for (const theme of ["dark", "light"]) {
    if (theme === "light") await page.getByRole("button", { name: "切换至浅色模式", exact: true }).click();
    await trigger.click();
    const slider = page.getByRole("slider", { name: "推理强度", exact: true });
    await slider.focus();
    await page.keyboard.press("End");
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const selector of [".thinking-control .model-glyph", ".thinking-control .model-orbit", ".model-picker-dialog"]) {
      assert.equal(await page.locator(selector).evaluate(element => getComputedStyle(element).animationName), "none");
    }
    assert.equal(await page.locator(".thinking-energy").evaluate(element => getComputedStyle(element, "::after").animationName), "none");
    await page.keyboard.press("Home");
    assert.equal(await slider.getAttribute("aria-valuetext"), "关闭");
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
  const nav = page.getByRole("navigation", { name: "工作区导航" });
  await nav.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByLabel("界面过渡", { exact: true }).selectOption("off");
  await nav.getByRole("button", { name: "会话", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 394 });
  await trigger.click();
  const slider = page.getByRole("slider", { name: "推理强度", exact: true });
  await slider.focus();
  await page.keyboard.press("End");
  assert.equal(await page.locator(".thinking-control .model-orbit").evaluate(element => getComputedStyle(element).animationName), "none");
  const box = await page.getByRole("dialog", { name: "模型选择", exact: true }).boundingBox();
  assert.ok(box.x >= 10 && box.y >= 10 && box.x + box.width <= 310 && box.y + box.height <= 384);
  await page.keyboard.press("Escape");
  const triggerBox = await trigger.boundingBox();
  assert.ok(triggerBox.x >= 0 && triggerBox.x + triggerBox.width <= 320);
  assert.equal(await page.evaluate(() => fixture.submitArgs.length), 0);
}, true));

test("上下文试管展示上次输入及缓存明细，不随模型选择或草稿变化，也不重复轮询历史", async () => fixture(async page => {
  await page.evaluate(() => {
    fixture.contextUsages = { 1: { conversationId: 1, latestEntryId: 2, state: "reported", lastRequest: {
      providerId: "deepseek", modelId: "deepseek-model", inputTokens: 1100, outputTokens: 40,
      cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 7, contextWindow: 2000,
    } } };
    fixture.statuses[1].latestEntryId = 2;
  });
  const trigger = page.getByRole("button", { name: "查看上下文用量", exact: true });
  await trigger.filter({ hasText: "上次输入 55%" }).waitFor();
  await page.getByLabel("消息内容", { exact: true }).fill("尚未发送的草稿不计入用量");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "上下文用量", exact: true });
  assert.equal(await dialog.locator("dd").allTextContents().then(values => values.join("|")), "1,100 tokens|2,000 tokens|40|100|0|7");
  await dialog.getByText("deepseek / deepseek-model", { exact: true }).waitFor();
  const count = await page.evaluate(() => fixture.contextUsageArgs.length);
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => fixture.contextUsageArgs.length), count);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByLabel("对话服务商", { exact: true }).selectOption("other");
  await page.waitForFunction(() => document.querySelector('[aria-label="对话模型"]').value === "other-model");
  await page.keyboard.press("Escape");
  await trigger.filter({ hasText: "上次输入 55%" }).waitFor();
  assert.equal(await page.getByLabel("消息内容", { exact: true }).inputValue(), "尚未发送的草稿不计入用量");
  assert.equal(await page.evaluate(() => fixture.submitArgs.length), 0);
}, true));

test("用量未报告或模型目录缺失时不伪造百分比，读取失败可安全重试", async () => fixture(async page => {
  await page.evaluate(() => {
    fixture.contextUsages = { 1: { conversationId: 1, latestEntryId: 2, state: "unreported", lastRequest: null } };
    fixture.statuses[1].latestEntryId = 2;
  });
  const trigger = page.getByRole("button", { name: "查看上下文用量", exact: true });
  await trigger.filter({ hasText: "上次输入 —" }).waitFor();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "上下文用量", exact: true });
  await dialog.getByText("服务商未报告有效输入用量。", { exact: true }).waitFor();
  await page.evaluate(() => { fixture.failContextUsage = true; });
  await dialog.getByRole("button", { name: "刷新用量", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal((await page.locator("body").textContent()).includes("synthetic-context-private"), false);
  await page.evaluate(() => {
    fixture.failContextUsage = false;
    fixture.contextUsages[1] = { conversationId: 1, latestEntryId: 2, state: "reported", lastRequest: {
      providerId: "removed", modelId: "old-model", inputTokens: 80, outputTokens: null,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, contextWindow: null,
    } };
  });
  await dialog.getByRole("button", { name: "刷新用量", exact: true }).click();
  await dialog.getByText("目录不可用", { exact: true }).waitFor();
  await dialog.getByText("80 tokens", { exact: true }).waitFor();
  assert.equal((await trigger.innerText()).includes("%"), false);
  assert.equal(await dialog.locator("dd").filter({ hasText: "未报告" }).count(), 1);
  await page.evaluate(() => { fixture.contextUsages[1].lastRequest.inputTokens = 1; fixture.contextUsages[1].lastRequest.contextWindow = 64000; });
  await dialog.getByRole("button", { name: "刷新用量", exact: true }).click();
  await trigger.filter({ hasText: "上次输入 <0.1%" }).waitFor();
}, true));

test("切换会话后迟到的上下文读数不串入新会话", async () => fixture(async page => {
  await page.evaluate(() => {
    fixture.contextUsages = { 1: { conversationId: 1, latestEntryId: 2, state: "reported", lastRequest: {
      providerId: "old", modelId: "old", inputTokens: 99, outputTokens: 2,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, contextWindow: 100,
    } } };
    fixture.holdContextUsageFor = 1;
    fixture.statuses[1].latestEntryId = 2;
  });
  await page.waitForFunction(() => typeof fixture.releaseContextUsage === "function");
  await page.evaluate(() => { fixture.oldContextRelease = fixture.releaseContextUsage; fixture.holdContextUsageFor = null; });
  await page.getByRole("button", { name: /会话乙.*#2/ }).click();
  const trigger = page.getByRole("button", { name: "查看上下文用量", exact: true });
  await trigger.filter({ hasText: "新上下文" }).waitFor();
  await page.evaluate(() => fixture.oldContextRelease());
  await page.waitForTimeout(80);
  assert.equal((await trigger.innerText()).includes("99%"), false);
  await trigger.click();
  await page.getByRole("dialog", { name: "上下文用量", exact: true }).getByText("当前上下文还没有请求用量。", { exact: true }).waitFor();
}, true));

test("试管中的重置沿用确认流程并清除旧读数，生成时禁止重置", async () => fixture(async page => {
  await page.evaluate(() => {
    fixture.contextUsages = { 1: { conversationId: 1, latestEntryId: 2, state: "reported", lastRequest: {
      providerId: "deepseek", modelId: "deepseek-model", inputTokens: 90, outputTokens: 4,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, contextWindow: 100,
    } } };
    fixture.statuses[1].latestEntryId = 2;
  });
  const trigger = page.getByRole("button", { name: "查看上下文用量", exact: true });
  await trigger.filter({ hasText: "上次输入 90%" }).waitFor();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "上下文用量", exact: true });
  await dialog.getByText("上次输入已接近该模型目录窗口，可开始新上下文。", { exact: true }).waitFor();
  await page.evaluate(() => { fixture.statuses[1].running = true; });
  await page.waitForFunction(() => document.querySelector('.context-usage-dialog footer button:last-child').disabled);
  await page.evaluate(() => { fixture.statuses[1].running = false; });
  await dialog.getByRole("button", { name: "开始新上下文", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => fixture.resetArgs.length), 0);
  await page.getByRole("button", { name: "确认开始新上下文", exact: true }).click();
  await trigger.filter({ hasText: "新上下文" }).waitFor();
  await trigger.click();
  assert.equal((await dialog.innerText()).includes("90%"), false);
  assert.equal(await page.evaluate(() => fixture.resetArgs.length), 1);
}, true));

test("上下文弹层适配明暗与窄窗，Escape 恢复焦点且不会遮断发送路径", async () => fixture(async page => {
  await page.getByLabel("消息内容", { exact: true }).fill("窄窗用量检查");
  const trigger = page.getByRole("button", { name: "查看上下文用量", exact: true });
  for (const [width, height] of [[1280, 850], [705, 564], [390, 844], [320, 394]]) {
    await page.setViewportSize({ width, height });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "上下文用量", exact: true });
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 10 && box.y >= 10 && box.x + box.width <= width - 10 && box.y + box.height <= height - 10);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
  }
  await page.getByRole("button", { name: "切换至浅色模式", exact: true }).click();
  await trigger.click();
  await page.getByRole("dialog", { name: "上下文用量", exact: true }).getByText("当前上下文还没有请求用量。", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("button", { name: "发送消息", exact: true }).isEnabled(), true);
  assert.equal(await page.getByLabel("消息内容", { exact: true }).inputValue(), "窄窗用量检查");
}, true));
