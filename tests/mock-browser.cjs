const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const { chromium } = require(process.env.AGENTDOCK_PLAYWRIGHT_PATH || 'playwright');
const root = resolve(__dirname, '..');
const output = join(root, 'test-results');
const url = pathToFileURL(join(root, 'Demo/agent-dock-mock.html')).href;
const key = 'agentdock.mock.workspace.v1';

async function main() {
  mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  const results = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  page.on('dialog', dialog => dialog.accept());
  const step = async (name, callback) => {
    await callback();
    results.push({ name, passed: true });
    process.stdout.write(`PASS ${name}\n`);
  };
  const select = id => page.locator(`.session[data-session-id="${id}"]`).click();
  const terminal = id => page.locator(`[data-terminal-id="${id}"]`);
  const waitStatus = async status => page.waitForFunction(value => document.getElementById('active-status').textContent === value, status);
  const openMenu = async () => { if (await page.locator('#menu').isHidden()) await page.locator('#session-menu').click(); };
  const confirmStop = async () => {
    await page.locator('#toggle-run').click();
    await page.locator('#accept-confirm').click();
    await waitStatus('已停止');
  };
  try {
    await page.goto(url);
    await page.evaluate(storageKey => localStorage.removeItem(storageKey), key);
    await page.reload();
    await step('首次打开：两个项目、三个独立模拟终端，持续显示模拟标签', async () => {
      await page.waitForFunction(() => document.getElementById('running-count').textContent.startsWith('3 '));
      assert.equal(await page.locator('.session').count(), 3);
      assert.equal(await page.locator('.project').count(), 2);
      assert.ok(await page.locator('.badge').isVisible());
    });
    let sessions = await page.evaluate(() => engine.workspace.sessions.map(session => ({ ...session })));
    const first = sessions[0].id;
    const second = sessions[1].id;
    await step('切换三种工具时各自显示独立输出；同目录提示共用文件', async () => {
      for (const session of sessions) {
        await select(session.id);
        assert.ok((await terminal(session.id).innerText()).includes(AgentName(session.agent)));
      }
      await select(first);
      assert.ok(await page.locator('#shared-note').isVisible());
      await page.screenshot({ path: join(output, '1440x900.png') });
    });
    await step('A 发送后立即切换 B；迟到回复只属于 A，B 草稿与焦点保持', async () => {
      await page.locator('#composer-input').fill('仅属于 A 的异步任务');
      await page.locator('#send').click();
      await select(second);
      await page.locator('#composer-input').fill('B 独立输入草稿');
      await page.locator('#composer-input').focus();
      await page.waitForFunction(id => engine.runtime(id).lines.some(line => line.text.includes('收到：仅属于 A')), first);
      assert.ok(!(await terminal(second).innerText()).includes('仅属于 A'));
      assert.equal(await page.locator('#composer-input').inputValue(), 'B 独立输入草稿');
      assert.ok(await page.locator('#composer-input').evaluate(input => input === document.activeElement));
      assert.ok(await page.locator(`[data-session-id="${first}"] .unread`).count());
      await select(first);
      assert.equal(await page.locator(`[data-session-id="${first}"] .unread`).count(), 0);
      await select(second);
      assert.equal(await page.locator('#composer-input').inputValue(), 'B 独立输入草稿');
    });
    await step('取消停止不改变运行；停止确认后禁用重复操作', async () => {
      await page.locator('#toggle-run').click();
      assert.ok((await page.locator('#confirm-copy').innerText()).includes('停止将结束'));
      await page.locator('#cancel-confirm').click();
      assert.equal(await page.locator('#active-status').innerText(), '运行中');
      await page.locator('#toggle-run').click();
      await page.locator('#accept-confirm').click();
      assert.equal(await page.locator('#active-status').innerText(), '停止中');
      assert.ok(await page.locator('#toggle-run').isDisabled());
      await waitStatus('已停止');
      assert.ok(await page.locator('#composer-input').isDisabled());
    });
    await step('停止立即重启：旧输出保留，旧 runId 输出和退出均被拒绝', async () => {
      const previous = await page.evaluate(id => engine.runtime(id).runId, second);
      await page.locator('#toggle-run').click();
      await waitStatus('运行中');
      const accepted = await page.evaluate(({ id, previous }) => [engine.output(id, previous, '迟到污染'), engine.exit(id, previous, 1)], { id: second, previous });
      assert.deepEqual(accepted, [false, false]);
      assert.ok((await terminal(second).innerText()).includes('新的一次运行'));
      assert.ok(!(await terminal(second).innerText()).includes('迟到污染'));
      assert.equal(await page.locator('#composer-input').inputValue(), 'B 独立输入草稿');
    });
    await step('新建独立中文空格目录，连点提交不会重复创建，也不改写原目录', async () => {
      await page.locator('#new-session').click();
      await page.locator('#pick-directory').click();
      await page.locator('#directory-options button').last().click();
      await page.locator('#session-name').fill('中文目录新会话');
      await page.locator('#create-submit').evaluate(button => { button.click(); button.click(); });
      await waitStatus('运行中');
      assert.equal(await page.locator('.session').count(), 4);
      assert.equal(await page.locator('.project').count(), 3);
      assert.equal(await page.locator('#active-path').innerText(), 'E:\\我的项目\\演示 空间\\新工作台');
      assert.equal(await page.evaluate(() => engine.workspace.projects[0].rootPath), 'D:\\Projects\\website');
    });
    const chineseId = await page.evaluate(() => engine.workspace.activeSessionId);
    await step('同路径新建 Claude 自动归组；模拟路径相同名称的其他目录不合并', async () => {
      await page.locator('#new-session').click();
      await page.locator('[data-agent="claude"]').click();
      await page.locator('#directory').fill('E:/我的项目/演示 空间/新工作台/');
      await page.locator('#session-name').fill('共享目录检查');
      await page.locator('#create-submit').click();
      await waitStatus('运行中');
      assert.equal(await page.locator('.project').count(), 3);
      assert.ok(await page.locator('#shared-note').isVisible());
      await page.locator('#new-session').click();
      await page.locator('#directory').fill('F:\\另一位置\\新工作台');
      await page.locator('#create-submit').click();
      await waitStatus('运行中');
      assert.equal(await page.locator('.project').count(), 4);
      assert.equal(await page.locator('.project-parent').count(), 2);
    });
    await step('在其他目录新建会话沿用工具，旧目录及运行不变', async () => {
      const old = await page.evaluate(() => ({ id: engine.workspace.activeSessionId, runId: engine.runtime(engine.workspace.activeSessionId).runId }));
      await openMenu(); await page.locator('#other-directory').click();
      assert.equal(await page.locator('[data-agent="codex"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#directory').inputValue(), '');
      await page.locator('#cancel-create').click();
      assert.equal(await page.evaluate(id => engine.runtime(id).runId, old.id), old.runId);
    });
    await step('浏览旧输出时不跳底，切换后滚动位置恢复，回到最新可用', async () => {
      await select(first);
      await page.evaluate(id => {
        const runId = engine.runtime(id).runId;
        for (let index = 0; index < 65; index++) engine.output(id, runId, `[模拟] 滚动验收第 ${index} 行`);
      }, first);
      await terminal(first).evaluate(pane => { pane.scrollTop = 180; });
      await page.waitForFunction(id => !engine.runtime(id).follow, first);
      const scrollTop = await terminal(first).evaluate(pane => pane.scrollTop);
      await select(second); await select(first);
      assert.ok(Math.abs(await terminal(first).evaluate(pane => pane.scrollTop) - scrollTop) < 3);
      await page.evaluate(id => engine.output(id, engine.runtime(id).runId, '[模拟] 新增行不抢滚动'), first);
      assert.ok(Math.abs(await terminal(first).evaluate(pane => pane.scrollTop) - scrollTop) < 3);
      assert.ok(await page.locator('#latest').isVisible());
      await page.locator('#latest').click();
      assert.ok(await page.locator('#latest').isHidden());
    });
    await step('后台裁剪 5000 行上限时保留可见内容锚点；锚点被裁掉时显示最早保留行', async () => {
      await page.evaluate(id => {
        const listener = engine.onChange;
        engine.onChange = () => {};
        const runId = engine.runtime(id).runId;
        for (let index = 0; index < 5000; index++) engine.output(id, runId, `[模拟] 有界历史第 ${index} 行`);
        engine.onChange = listener;
        panes.get(id).remove(); panes.delete(id); renderActive();
      }, first);
      const visibleLine = async () => terminal(first).evaluate(pane => {
        const top = pane.getBoundingClientRect().top;
        return [...pane.querySelectorAll('.line')].find(line => line.getBoundingClientRect().bottom > top + 1)?.textContent;
      });
      await terminal(first).evaluate(pane => { pane.scrollTop = 6000; });
      await page.waitForFunction(id => !engine.runtime(id).follow, first);
      const anchorText = await visibleLine();
      await select(second);
      await page.evaluate(id => { for (let index = 0; index < 100; index++) engine.output(id, engine.runtime(id).runId, `[模拟] 后台追加 ${index}`); }, first);
      await select(first);
      assert.equal(await visibleLine(), anchorText);
      await terminal(first).evaluate(pane => { pane.scrollTop = 200; });
      await select(second);
      await page.evaluate(id => { for (let index = 0; index < 100; index++) engine.output(id, engine.runtime(id).runId, `[模拟] 再次追加 ${index}`); }, first);
      await select(first);
      assert.equal(await terminal(first).evaluate(pane => pane.scrollTop), 0);
      assert.equal(await terminal(first).locator('.line').count(), 5000);
      await page.locator('#latest').click();
    });
    await step('搜索无结果、折叠与长路径均可操作', async () => {
      await page.locator('#search').fill('绝不存在的搜索词');
      assert.ok((await page.locator('#tree').innerText()).includes('没有匹配'));
      await page.locator('#search').fill('');
      await page.locator('.project-toggle').first().click();
      assert.equal(await page.locator('.project-toggle').first().getAttribute('aria-expanded'), 'false');
      await page.locator('.project-toggle').first().click();
      await select(chineseId);
      assert.equal(await page.locator('#active-path').getAttribute('title'), 'E:\\我的项目\\演示 空间\\新工作台');
      const longPath = 'E:\\我的项目\\' + Array(6).fill('很长的中文目录名称与 空格用于检查路径省略展示').join('\\') + '\\新工作台';
      await page.locator('#new-session').click();
      await page.locator('#directory').fill(longPath);
      await page.locator('#session-name').fill('长中文路径下的临时验收会话');
      await page.locator('#create-submit').click(); await waitStatus('运行中');
      assert.equal(await page.locator('#active-path').getAttribute('title'), longPath);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.app,.content,.workspace,.workspace-head,.head-path,.path-text,.terminal,.statusbar')].map(container => ({ class: container.className, width: container.getBoundingClientRect().width, scrollWidth: container.scrollWidth })))));
      await page.screenshot({ path: join(output, 'long-path.png') });
      const extraId = await page.evaluate(() => engine.workspace.activeSessionId);
      await openMenu(); await page.locator('#remove-session').click(); await page.locator('#accept-confirm').click();
      await page.waitForFunction(id => !engine.session(id), extraId);
      await select(chineseId);
    });
    await step('模拟启动失败可重试，单会话失败不影响其他终端', async () => {
      await openMenu(); await page.locator('#menu summary').click(); await page.locator('#fail-start').click();
      await confirmStop(); await page.locator('#toggle-run').click(); await waitStatus('启动失败');
      assert.ok(await page.locator('#runtime-error').isVisible());
      assert.equal(await page.evaluate(id => engine.runtime(id).status, first), 'running');
      await page.locator('#toggle-run').click(); await waitStatus('运行中');
    });
    await step('模拟停止失败时不提前移除，退出异常保留退出码', async () => {
      await openMenu();
      if (!await page.locator('#fail-stop').isVisible()) await page.locator('#menu summary').click();
      await page.locator('#fail-stop').click();
      await openMenu(); await page.locator('#remove-session').click(); await page.locator('#accept-confirm').click();
      await page.waitForFunction(() => document.getElementById('runtime-error').textContent.includes('停止失败'));
      assert.ok(await page.locator(`.session[data-session-id="${chineseId}"]`).count());
      assert.equal(await page.locator('#active-status').innerText(), '运行中');
      await openMenu(); await page.locator('#simulate-exit').click(); await waitStatus('已停止');
      assert.ok((await page.locator('#runtime-error').innerText()).includes('退出码 1'));
    });
    await step('连续启动全部保持同一运行；关闭自动启动后刷新保持未启动', async () => {
      await page.locator('#start-all').click(); await waitStatus('运行中');
      const before = await page.evaluate(() => engine.workspace.sessions.map(session => engine.runtime(session.id).runId));
      await page.locator('#start-all').click(); await page.locator('#start-all').click();
      const after = await page.evaluate(() => engine.workspace.sessions.map(session => engine.runtime(session.id).runId));
      assert.deepEqual(after, before);
      await openMenu(); await page.locator('#launch-on-open').uncheck();
      await page.locator('#session-menu').click();
      await page.reload(); await waitStatus('未启动');
      assert.equal(await page.locator('.session').count(), 6);
      assert.equal(await terminal(chineseId).innerText(), '');
      await page.waitForFunction(() => document.getElementById('running-count').textContent.startsWith('5 '));
      await page.screenshot({ path: join(output, 'configuration-restored.png') });
    });
    await step('持久化仅含会话定义，无旧指令、草稿、终端输出与 runId', async () => {
      const saved = await page.evaluate(storageKey => localStorage.getItem(storageKey), key);
      assert.ok(!/runId|lines|draft|仅属于 A/.test(saved));
      assert.equal(JSON.parse(saved).sessions.length, 6);
    });
    await step('960×640 无横向溢出，控件可见；新建对话框可操作', async () => {
      await page.setViewportSize({ width: 960, height: 640 });
      await page.screenshot({ path: join(output, '960x640.png') });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.ok(await page.locator('#new-session').isVisible());
      await page.locator('#new-session').click();
      const bounds = await page.locator('#create-dialog').boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 640);
      await page.locator('#cancel-create').click();
    });
    await step('小窗口侧栏收起，可展开选择会话，Esc 收起；焦点可见', async () => {
      await page.setViewportSize({ width: 720, height: 720 });
      await page.locator('#show-projects').click();
      assert.equal(await page.locator('#show-projects').getAttribute('aria-expanded'), 'true');
      await select(second);
      assert.equal(await page.locator('#show-projects').getAttribute('aria-expanded'), 'false');
      await page.locator('#show-projects').click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#show-projects').getAttribute('aria-expanded'), 'false');
      await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
      assert.ok(await page.locator('#show-projects').evaluate(button => getComputedStyle(button).outlineStyle !== 'none'));
      await page.screenshot({ path: join(output, '720x720.png') });
      await page.setViewportSize({ width: 1440, height: 900 });
    });
    await step('中文输入组合 Enter 不发送，Shift+Enter 可换行；路径输入拒绝相对路径', async () => {
      await page.locator('#composer-input').fill('中文候选');
      await page.locator('#composer-input').focus();
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      assert.ok(await page.locator('#composer-input').evaluate(input => getComputedStyle(input).outlineStyle !== 'none'));
      const before = await terminal(second).innerText();
      await page.locator('#composer-input').evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
      assert.equal(await terminal(second).innerText(), before);
      await page.locator('#composer-input').press('Shift+Enter');
      assert.ok((await page.locator('#composer-input').inputValue()).includes('\n'));
      await page.locator('#new-session').click(); await page.locator('#directory').fill('relative-path');
      await page.locator('#create-submit').click();
      await page.waitForFunction(() => document.getElementById('create-error').textContent.includes('绝对路径'));
      await page.keyboard.press('Escape');
      assert.ok(await page.locator('#create-dialog').isHidden());
    });
    await step('取消移除保留会话，移除当前会话选择相邻', async () => {
      await openMenu(); await page.locator('#remove-session').click(); await page.locator('#cancel-confirm').click();
      assert.equal(await page.locator('.session').count(), 6);
      await openMenu(); await page.locator('#remove-session').click(); await page.locator('#accept-confirm').click();
      await page.waitForFunction(() => engine.workspace.sessions.length === 5);
      assert.notEqual(await page.evaluate(() => engine.workspace.activeSessionId), second);
    });
    await step('移除最后会话清理空项目；刷新空配置不再注入种子', async () => {
      while (await page.locator('.session').count()) {
        const previous = await page.evaluate(() => engine.workspace.sessions.length);
        await openMenu(); await page.locator('#remove-session').click(); await page.locator('#accept-confirm').click();
        await page.waitForFunction(count => engine.workspace.sessions.length < count, previous);
      }
      assert.ok(await page.locator('#new-first').isVisible());
      assert.equal(await page.locator('.project').count(), 0);
      await page.reload();
      assert.ok(await page.locator('#new-first').isVisible());
      assert.equal(await page.locator('.session').count(), 0);
    });
    await step('浏览器存储写入失败有明确提示，恢复后可重试保存', async () => {
      await page.evaluate(() => { window.originalSave = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new Error('模拟 quota'); }; });
      await page.locator('#new-first').click(); await page.locator('#directory').fill('D:\\Mock\\save-error'); await page.locator('#create-submit').click();
      assert.ok(await page.locator('#storage-warning').isVisible());
      assert.ok((await page.locator('#save-state').innerText()).includes('未保存'));
      await page.evaluate(() => { Storage.prototype.setItem = window.originalSave; });
      await page.locator('#retry-save').click();
      assert.ok(await page.locator('#storage-warning').isHidden());
    });
    await step('浏览器没有脚本异常，也未发起 HTTP 或 HTTPS 请求', async () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(requests, []);
    });
    writeFileSync(join(output, 'browser-results.json'), JSON.stringify({ browser: await browser.version(), url, results, errors, requests }, null, 2));
    process.stdout.write(`${results.length} browser checks passed\n`);
  } catch (error) {
    await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    writeFileSync(join(output, 'browser-results.json'), JSON.stringify({ results, failure: error.stack, errors, requests }, null, 2));
    throw error;
  } finally { await browser.close(); }
}

function AgentName(agent) { return { codex: 'Codex', agy: 'Antigravity', claude: 'Claude Code' }[agent]; }

main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
