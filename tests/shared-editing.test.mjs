import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("concurrent editing API and two browser sessions", { timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "caraul-sync-test-"));
  const storePath = path.join(directory, "store.json");
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], { cwd: root, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATABASE_URL: "", AUTH_STORE_FILE: storePath }, windowsHide: true, stdio: "pipe" });
  let logs = ""; server.stdout.on("data", (chunk) => logs += chunk); server.stderr.on("data", (chunk) => logs += chunk);
  t.after(async () => { server.kill(); await new Promise((resolve) => server.exitCode !== null ? resolve() : server.once("exit", resolve)); await rm(directory, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch { /* Startup. */ }
    if (server.exitCode !== null) throw Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  function session() {
    return { cookie: "", async request(route, method = "GET", body) {
      const response = await fetch(origin + route, { method, headers: { cookie: this.cookie, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const cookie = response.headers.getSetCookie()[0]; if (cookie) this.cookie = cookie.split(";")[0];
      return { status: response.status, body: await response.json() };
    } };
  }
  const owner = session(), editor = session(), viewer = session();
  for (const [login, account] of [["sync-owner", owner], ["sync-editor", editor], ["sync-viewer", viewer]]) {
    assert.equal((await account.request("/api/auth/register", "POST", { login, password: "test-password-42", passwordRepeat: "test-password-42" })).status, 201);
  }
  const created = await owner.request("/api/guards", "POST", { name: "Тест синхронизации" });
  const guardId = created.body.guard.id;
  const access = (await owner.request("/api/access")).body;
  for (const [system, account] of [["editor", editor], ["viewer", viewer]]) {
    const invite = await owner.request("/api/invites", "POST", { roleId: access.roles.find((role) => role.system === system).id });
    const token = new URL(invite.body.inviteUrl).searchParams.get("invite");
    assert.equal((await account.request("/api/invites/accept", "POST", { token })).status, 200);
  }
  const seed = { appTitle: "Караул", employees: [], absences: [], rosters: {}, templateBlocks: [], rosterCommentTemplates: [], equipmentGroups: { g: "ПТВ", target: "Отдельный раздел" }, equipmentGroupsConfigured: true, equipmentLocations: [], equipment: [
    { id: "hose", name: "Рукав", group: "g", unit: "шт.", quantity: 1, trackingMode: "quantity", condition: "READY", location: "", comment: "" },
    { id: "pump", name: "Насос", group: "g", unit: "шт.", quantity: 1, trackingMode: "quantity", condition: "READY", location: "", comment: "" }
  ] };
  assert.equal((await owner.request("/api/state", "PUT", { state: seed, baseState: null })).status, 200);

  await t.test("simultaneous requests preserve both records and file storage", async () => {
    const base = (await editor.request("/api/state")).body.state;
    const a = structuredClone(base), b = structuredClone(base);
    a.equipment[0].quantity = 2; b.equipment[1].quantity = 3;
    const results = await Promise.all([editor.request("/api/state", "PUT", { baseState: base, state: a }), owner.request("/api/state", "PUT", { baseState: base, state: b })]);
    assert.deepEqual(results.map((result) => result.status), [200, 200]);
    const saved = (await owner.request("/api/state")).body.state;
    assert.deepEqual(saved.equipment.map((item) => item.quantity), [2, 3]);
    const disk = JSON.parse(await readFile(storePath, "utf8"));
    assert.deepEqual(disk.states[guardId].equipment.map((item) => item.quantity), [2, 3]);
  });

  await t.test("same record conflicts atomically; stale old clients and viewers cannot overwrite", async () => {
    const base = (await editor.request("/api/state")).body.state;
    const a = structuredClone(base), b = structuredClone(base);
    a.equipment[0].quantity = 4; b.equipment[0].quantity = 5; b.equipment[1].quantity = 99;
    assert.equal((await owner.request("/api/state", "PUT", { baseState: base, state: a })).status, 200);
    const rejected = await editor.request("/api/state", "PUT", { baseState: base, state: b });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.conflicts[0].path[1], "hose");
    assert.deepEqual((await owner.request("/api/state")).body.state.equipment.map((item) => item.quantity), [4, 3]);
    assert.equal((await owner.request("/api/state", "PUT", { state: b })).status, 409);
    assert.equal((await viewer.request("/api/state", "PUT", { baseState: base, state: b })).status, 403);
  });

  await t.test("browser refresh preserves an open form and handles conflicts and offline drafts", async (browserTest) => {
    let chromium;
    try { ({ chromium } = await import("playwright")); } catch { browserTest.skip("Playwright is not installed"); return; }
    let browser;
    const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
    try { browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) }); }
    catch (error) { if (error.message.includes("Executable doesn't exist")) { browserTest.skip("Browser is not installed"); return; } throw error; }
    browserTest.after(() => browser.close());
    const contexts = await Promise.all([owner, editor].map(async (account) => {
      const context = await browser.newContext({ viewport: { width: 703, height: 779 } });
      const [name, value] = account.cookie.split("="); await context.addCookies([{ name, value, url: origin }]);
      return context;
    }));
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    for (const page of pages) { await page.goto(origin); await page.locator('[data-view="work"]:visible').click(); }
    const [first, second] = pages;
    const openPump = async (page) => { const toggle = page.locator('[data-toggle-equipment="pump"]'); if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click(); await page.locator('[data-edit-equipment="pump"]').click(); };
    await openPump(second); await second.getByLabel("Комментарий", { exact: true }).filter({ visible: true }).fill("Моя запись");
    const base = (await owner.request("/api/state")).body.state;
    const remote = structuredClone(base); remote.equipment.find((item) => item.id === "pump").comment = "Общая запись";
    assert.equal((await owner.request("/api/state", "PUT", { baseState: base, state: remote })).status, 200);
    await second.waitForTimeout(5500);
    assert.equal(await second.getByLabel("Комментарий", { exact: true }).filter({ visible: true }).inputValue(), "Моя запись");
    await second.getByRole("button", { name: "Сохранить", exact: true }).click();
    await second.getByRole("button", { name: "Сравнить варианты", exact: true }).waitFor();
    await second.reload(); await second.locator('[data-view="work"]:visible').click();
    await second.getByRole("button", { name: "Сравнить варианты", exact: true }).click();
    assert.ok((await second.locator('[data-sync-conflict-form]').innerText()).includes("Моя запись"));
    assert.ok((await second.locator('[data-sync-conflict-form]').innerText()).includes("Общая запись"));
    await mkdir(path.join(root, "output"), { recursive: true });
    await second.screenshot({ path: path.join(root, "output", "concurrent-conflict.png") });
    await second.locator('[data-sync-choice]').selectOption("remote");
    await second.getByRole("button", { name: "Сохранить выбранное", exact: true }).click();
    await second.waitForTimeout(1200);
    assert.equal((await editor.request("/api/state")).body.state.equipment.find((item) => item.id === "pump").comment, "Общая запись");
    await first.waitForTimeout(5500);
    await openPump(first);
    assert.equal(await first.getByLabel("Комментарий", { exact: true }).filter({ visible: true }).inputValue(), "Общая запись");
    await first.getByRole("button", { name: "Закрыть карточку оборудования", exact: true }).click();
    await openPump(second); await second.getByLabel("Комментарий", { exact: true }).filter({ visible: true }).fill("После обрыва связи");
    await contexts[1].setOffline(true);
    await second.getByRole("button", { name: "Сохранить", exact: true }).click();
    await second.getByText("Нет связи с сервером.", { exact: false }).waitFor();
    await contexts[1].setOffline(false); await second.reload();
    await second.waitForTimeout(1500);
    assert.equal((await editor.request("/api/state")).body.state.equipment.find((item) => item.id === "pump").comment, "После обрыва связи");
    // A response must not advance the baseline underneath another open form.
    await first.waitForTimeout(5500);
    await openPump(first);
    await first.getByLabel("Комментарий", { exact: true }).filter({ visible: true }).fill("Следующая проверка");
    let release;
    const held = new Promise((resolve) => release = resolve);
    let entered;
    const started = new Promise((resolve) => entered = resolve);
    let once = true;
    await first.route("**/api/state", async (route) => {
      if (route.request().method() === "PUT" && once) { once = false; entered(); await held; }
      await route.continue();
    });
    await first.getByRole("button", { name: "Сохранить", exact: true }).click();
    await started;
    await first.locator('[data-toggle-equipment="hose"]').click();
    await first.locator('[data-edit-equipment="hose"]').click();
    await first.getByLabel("Комментарий", { exact: true }).filter({ visible: true }).fill("Моя новая правка рукава");
    const fresh = (await owner.request("/api/state")).body.state;
    const changed = structuredClone(fresh); changed.equipment.find((item) => item.id === "hose").comment = "Чужая новая правка рукава";
    assert.equal((await owner.request("/api/state", "PUT", { baseState: fresh, state: changed })).status, 200);
    release(); await first.waitForTimeout(1000);
    assert.equal(await first.getByLabel("Комментарий", { exact: true }).filter({ visible: true }).inputValue(), "Моя новая правка рукава");
    await first.getByRole("button", { name: "Сохранить", exact: true }).click();
    await first.getByRole("button", { name: "Сравнить варианты", exact: true }).waitFor();
    assert.equal((await owner.request("/api/state")).body.state.equipment.find((item) => item.id === "hose").comment, "Чужая новая правка рукава");
    // Live name warnings must preserve both the form draft and deliberate exceptions.
    await second.reload(); await second.locator('[data-view="work"]:visible').click();
    await second.locator('[data-add-equipment]').click();
    await second.getByLabel("Наименование", { exact: true }).fill("Насосс");
    await second.locator('[data-equipment-name-matches]').waitFor({ state: "visible" });
    await second.locator('[name="instanceNumber"]').fill("TEST-9");
    await second.locator('[name="instanceComment"]').fill("Черновик экземпляра");
    await second.locator('[data-open-equipment-match="pump"]').click();
    await second.getByRole("button", { name: "← Вернуться к введённой записи", exact: true }).click();
    assert.equal(await second.getByLabel("Наименование", { exact: true }).inputValue(), "Насосс");
    assert.equal(await second.locator('[name="instanceNumber"]').inputValue(), "TEST-9");
    assert.equal(await second.locator('[name="instanceComment"]').inputValue(), "Черновик экземпляра");
    await second.screenshot({ path: path.join(root, "output", "equipment-name-warning.png") });
    await second.getByRole("button", { name: "Сохранить", exact: true }).click();
    await second.locator('[data-equipment-error]').waitFor({ state: "visible" });
    assert.equal((await editor.request("/api/state")).body.state.equipment.length, 2);
    await second.locator('[data-confirm-separate-equipment]').check();
    await second.getByLabel("Другие названия и сокращения", { exact: true }).fill("Н-9");
    await second.locator('[data-confirm-separate-equipment]').check();
    await second.getByRole("button", { name: "Сохранить", exact: true }).click();
    await second.waitForTimeout(1000);
    const separate = (await editor.request("/api/state")).body.state.equipment.find((item) => item.name === "Насосс");
    assert.equal(separate.instances[0].inventoryNumber, "TEST-9");
    assert.deepEqual(separate.aliases, ["Н-9"]);
    await second.locator('[data-add-equipment]').click();
    await second.getByLabel("Наименование", { exact: true }).fill("Н9");
    await second.locator('[data-open-equipment-match]').waitFor({ state: "visible" });
    assert.ok((await second.locator('[data-equipment-name-matches]').innerText()).includes("Насосс"));
    await second.getByRole("button", { name: "Закрыть карточку оборудования", exact: true }).click();
    const beforeMove = (await editor.request("/api/state")).body.state.equipment;
    await second.getByRole("button", { name: "Выбрать позиции", exact: true }).click();
    await second.getByRole("button", { name: "Поиск оборудования", exact: true }).click();
    await second.locator('[data-equipment-search]').fill("Насосс");
    await second.getByRole("button", { name: "Выбрать все показанные", exact: true }).click();
    await second.locator('[data-equipment-search]').fill("");
    await second.locator('[data-select-equipment="hose"]').check();
    await second.getByRole("button", { name: "Перенести в раздел", exact: true }).click();
    await second.getByLabel("В какой раздел перенести?", { exact: true }).selectOption("target");
    await second.screenshot({ path: path.join(root, "output", "equipment-bulk-move.png") });
    await second.getByRole("button", { name: "Перенести", exact: true }).click();
    await second.waitForTimeout(1000);
    const afterMove = (await editor.request("/api/state")).body.state.equipment;
    for (const before of beforeMove) {
      const after = afterMove.find((item) => item.id === before.id);
      assert.equal(after.group, before.id === "hose" || before.id === separate.id ? "target" : "g");
      const { group: g1, updatedAt: u1, ...oldFields } = before;
      const { group: g2, updatedAt: u2, ...newFields } = after;
      assert.deepEqual(newFields, oldFields);
    }
    assert.equal(await second.locator('[data-equipment-group="target"]').getAttribute("aria-selected"), "true");
    const viewerContext = await browser.newContext();
    const [viewerName, viewerValue] = viewer.cookie.split("=");
    await viewerContext.addCookies([{ name: viewerName, value: viewerValue, url: origin }]);
    const viewerPage = await viewerContext.newPage(); await viewerPage.goto(origin);
    await viewerPage.locator('[data-view="work"]:visible').click();
    assert.equal(await viewerPage.locator('[data-select-equipment-mode]').count(), 0);
    await viewerContext.close();
  });
});

