import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { achievementCategoryList } from "../public/achievements.js";
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

  await t.test("achievement permissions and simultaneous participation entries preserve every award", async () => {
    const original = (await owner.request("/api/state")).body.state;
    const entry = (id) => ({ id, date: "2026-11-05", title: "Работы", type: "work", points: 1, comment: "", participants: [{ employeeId: "award-driver", name: "Тестовый И.И." }] });
    const a = structuredClone(original), b = structuredClone(original);
    a.achievements = [entry("award-editor")]; b.achievements = [entry("award-owner")];
    assert.equal((await editor.request("/api/state", "PUT", { baseState: original, state: a })).status, 200);
    assert.equal((await owner.request("/api/state", "PUT", { baseState: original, state: b })).status, 200);
    const saved = (await viewer.request("/api/state")).body.state;
    assert.equal(saved.achievements.length, 2);
    const illegal = structuredClone(saved); illegal.achievements[0].points = 100;
    assert.equal((await viewer.request("/api/state", "PUT", { baseState: saved, state: illegal })).status, 403);
    const rules = { ...saved, achievementRules: { competition: 4, prize: 3, work: 2, special: 1 } };
    assert.equal((await editor.request("/api/state", "PUT", { baseState: saved, state: rules })).status, 403);
    assert.equal((await owner.request("/api/state", "PUT", { baseState: saved, state: rules })).status, 200);
    const current = (await owner.request("/api/state")).body.state;
    assert.equal(current.achievements[0].points, 1);
    const invalid = structuredClone(current); invalid.achievements[0].points = -1;
    assert.equal((await editor.request("/api/state", "PUT", { baseState: current, state: invalid })).status, 403);
    const configured = structuredClone(current);
    configured.achievementCategories = [...achievementCategoryList(current), { id: "outreach", name: "Профилактика", points: 4, prizeBonus: 0, requireComment: true, archived: false }];
    assert.equal((await editor.request("/api/state", "PUT", { baseState: current, state: configured })).status, 403);
    assert.equal((await owner.request("/api/state", "PUT", { baseState: current, state: configured })).status, 200);
    let customBase = (await owner.request("/api/state")).body.state;
    const custom = { ...entry("custom-award"), type: "outreach", typeName: "Профилактика", points: 4, commentRequired: true, comment: "" };
    const attempted = structuredClone(customBase); attempted.achievements.push(custom);
    assert.equal((await editor.request("/api/state", "PUT", { baseState: customBase, state: attempted })).status, 403);
    custom.comment = "Занятие с детьми";
    assert.equal((await editor.request("/api/state", "PUT", { baseState: customBase, state: attempted })).status, 200);
    customBase = (await owner.request("/api/state")).body.state;
    const archived = structuredClone(customBase); archived.achievementCategories.find((item) => item.id === "outreach").archived = true;
    assert.equal((await owner.request("/api/state", "PUT", { baseState: customBase, state: archived })).status, 200);
    const archivedBase = (await owner.request("/api/state")).body.state;
    const newArchived = structuredClone(archivedBase); newArchived.achievements.push({ ...custom, id: "cannot-add-archived" });
    assert.equal((await editor.request("/api/state", "PUT", { baseState: archivedBase, state: newArchived })).status, 403);
    assert.equal(archivedBase.achievements.find((item) => item.id === custom.id).points, 4);
    assert.equal((await owner.request("/api/state", "PUT", { baseState: archivedBase, state: { ...original, achievements: [], achievementRules: { competition: 3, prize: 2, work: 1, special: 1 }, achievementCategories: achievementCategoryList(original) } })).status, 200);
  });

  await t.test("split UTF-8 request chunks preserve Russian roster text", async () => {
    const original = (await owner.request("/api/state")).body.state;
    const edited = structuredClone(original);
    edited.rosters["2026-09-15"] = { date: "2026-09-15", blocks: [{ id: "reserve-text", title: "Резервный водитель", members: ["test-driver"] }], comment: "Заправка техники 🚒" };
    const body = Buffer.from(JSON.stringify({ baseState: original, state: edited }));
    const splitAt = body.indexOf(Buffer.from("водитель")) + 1;
    const result = await new Promise((resolve, reject) => {
      const req = http.request(origin + "/api/state", { method: "PUT", headers: { cookie: editor.cookie, "content-type": "application/json" } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      req.on("error", reject);
      req.write(body.subarray(0, splitAt), () => setTimeout(() => req.end(body.subarray(splitAt)), 20));
    });
    assert.equal(result.status, 200);
    const saved = (await owner.request("/api/state")).body.state;
    assert.deepEqual(saved.rosters["2026-09-15"], edited.rosters["2026-09-15"]);
    assert.equal((await owner.request("/api/state", "PUT", { baseState: saved, state: original })).status, 200);
  });

  await t.test("reserve roster history is shared across editors and survives a stale owner save", async () => {
    const original = (await owner.request("/api/state")).body.state;
    const staleOwnerState = structuredClone(original);
    const edited = structuredClone(original);
    const date = "2026-09-29";
    edited.rosters[date] = {
      id: `roster-${date}`, date, comment: "Смена, заполненная редактором",
      blocks: [{ id: "reserve-history", title: "Резервный водитель", members: ["test-driver"] }],
      substitutions: {}, updatedAt: "2026-09-28T12:00:00.000Z"
    };
    assert.equal((await editor.request("/api/state", "PUT", { baseState: original, state: edited })).status, 200);
    for (const account of [owner, viewer]) {
      assert.deepEqual((await account.request("/api/state")).body.state.rosters[date], edited.rosters[date]);
    }
    staleOwnerState.equipment[0].comment = "Изменение после возвращения";
    assert.equal((await owner.request("/api/state", "PUT", { baseState: original, state: staleOwnerState })).status, 200);
    const shared = (await owner.request("/api/state")).body.state;
    assert.deepEqual(shared.rosters[date], edited.rosters[date]);
    assert.deepEqual(JSON.parse(await readFile(storePath, "utf8")).states[guardId].rosters[date], edited.rosters[date]);
    // Restore this isolated fixture so subsequent browser checks start with the original data.
    assert.equal((await owner.request("/api/state", "PUT", { baseState: shared, state: original })).status, 200);
  });

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

    // History filled by an editor remains visible to the owner, including damaged legacy headings.
    const historyBase = (await editor.request("/api/state")).body.state;
    const historyState = structuredClone(historyBase);
    historyState.employees = [
      { id: "history-driver-1", lastName: "Первый", firstName: "Иван", middleName: "Иванович", shortName: "Первый И.И.", position: "Водитель", isActive: true },
      { id: "history-driver-2", lastName: "Второй", firstName: "Пётр", middleName: "Петрович", shortName: "Второй П.П.", position: "Водитель", isActive: true }
    ];
    historyState.templateBlocks = [{ title: "Резервный водитель" }];
    historyState.rosters = {
      "2026-09-15": { date: "2026-09-15", blocks: [{ id: "legacy-1", title: "Резервный водит��ль", members: ["history-driver-1"] }] },
      "2026-10-01": { date: "2026-10-01", blocks: [{ id: "legacy-2", title: "��езервный водитель", members: ["history-driver-2"] }] }
    };
    assert.equal((await editor.request("/api/state", "PUT", { baseState: historyBase, state: historyState })).status, 200);
    const historyContext = await browser.newContext({ viewport: { width: 703, height: 779 } });
    const [historyCookieName, historyCookieValue] = owner.cookie.split("=");
    await historyContext.addCookies([{ name: historyCookieName, value: historyCookieValue, url: origin }]);
    await historyContext.addInitScript(() => localStorage.setItem("caraul-ui-v1", JSON.stringify({ view: "roster", selectedDate: "2030-01-10" })));
    const historyPage = await historyContext.newPage();
    await historyPage.goto(origin);
    await historyPage.locator('[data-pick-assignment]').first().click();
    assert.match(await historyPage.locator('[data-select-employee="history-driver-1"]').innerText(), /Последний резерв: 17\.09\.2026/);
    assert.match(await historyPage.locator('[data-select-employee="history-driver-2"]').innerText(), /Последний резерв: 03\.10\.2026/);
    await historyPage.screenshot({ path: path.join(root, "output", "reserve-history-fixed.png") });
    await historyContext.close();

    const carryBase = (await owner.request("/api/state")).body.state;
    const carryState = structuredClone(carryBase);
    const sourceDate = "2030-01-10", targetDate = "2030-01-18";
    carryState.rosters[sourceDate] = { id: "carry-source", date: sourceDate, comment: "Старая заметка", substitutions: { guest: { name: "Гость", kind: "additional" } }, blocks: [
      { id: "carry-ac", title: "АЦ", members: ["history-driver-1", "history-driver-2", "guest"] },
      { id: "carry-reserve", title: "Резервный водитель", members: ["history-driver-1"] }
    ] };
    carryState.rosters["2030-01-22"] = { date: "2030-01-22", comment: "Уже заполнено", blocks: [{ id: "future-unique", title: "Отдельный блок будущей смены", members: ["history-driver-2"] }] };
    carryState.absences = [{ id: "target-absence", employeeId: "history-driver-2", absenceType: "VACATION", dateFrom: targetDate, dateTo: "2030-01-20" }];
    carryState.rosterCommentTemplates = [{ id: "target-template", text: "Заправка техники", weekday: new Date(2030, 0, 18).getDay() }];
    assert.equal((await owner.request("/api/state", "PUT", { baseState: carryBase, state: carryState })).status, 200);
    const carryContext = await browser.newContext({ viewport: { width: 400, height: 800 } });
    await carryContext.addCookies([{ name: historyCookieName, value: historyCookieValue, url: origin }]);
    await carryContext.addInitScript(() => localStorage.setItem("caraul-ui-v1", JSON.stringify({ view: "roster", selectedDate: "2030-01-18" })));
    const carryPage = await carryContext.newPage(); await carryPage.goto(origin);
    await carryPage.locator('[data-reset-roster-assignments]:enabled').waitFor({ state: "attached" });
    await carryPage.locator('[data-roster-actions] > summary').click();
    await carryPage.waitForTimeout(700);
    const copied = (await owner.request("/api/state")).body.state.rosters[targetDate];
    assert.deepEqual(copied.blocks.map((block) => block.members), [["history-driver-1"], []]);
    assert.equal(copied.copiedFromDate, sourceDate);
    assert.equal(copied.comment, "Заправка техники");
    await carryPage.screenshot({ path: path.join(root, "output", "roster-carry-forward.png") });
    carryPage.once("dialog", (dialog) => dialog.accept());
    await carryPage.locator('[data-reset-roster-assignments]').click();
    await carryPage.waitForTimeout(700);
    let resetState = (await owner.request("/api/state")).body.state;
    assert.deepEqual(resetState.rosters[targetDate].blocks.map((block) => block.members), [[], []]);
    assert.equal(resetState.rosters[targetDate].comment, "Заправка техники");
    assert.deepEqual(resetState.rosters[sourceDate], carryState.rosters[sourceDate]);
    assert.deepEqual(resetState.absences, carryState.absences);
    await carryPage.reload();
    await carryPage.locator('[data-reset-roster-assignments]:disabled').waitFor({ state: "attached" });
    await carryPage.locator('[data-roster-actions] > summary').click();
    await carryPage.locator('[data-copy-previous-roster]').click();
    await carryPage.locator('[data-reset-roster-assignments]:enabled').waitFor({ state: "attached" });
    await carryPage.waitForTimeout(700);
    resetState = (await owner.request("/api/state")).body.state;
    assert.deepEqual(resetState.rosters[targetDate].blocks.map((block) => block.members), [["history-driver-1"], []]);
    assert.equal(resetState.rosters[targetDate].comment, "Заправка техники");
    await carryPage.route("**/api/roster-card/png", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=" }) }));
    await carryPage.getByRole("button", { name: "Сгенерировать PNG", exact: true }).click();
    await carryPage.waitForTimeout(700);
    const afterPng = (await owner.request("/api/state")).body.state;
    assert.deepEqual(afterPng.rosters["2030-01-22"], carryState.rosters["2030-01-22"]);
    await carryPage.locator('[data-close-modal]').first().click();
    assert.equal(await carryPage.locator('[data-add-block]').isVisible(), false);
    await carryPage.locator('[data-roster-actions] > summary').click();
    await carryPage.locator('[data-roster-schedule]').click();
    await carryPage.locator('[name="enabled"]').check();
    await carryPage.locator('[name="anchorDate"]').fill(targetDate);
    await carryPage.getByRole("button", { name: "Сохранить", exact: true }).click();
    await carryPage.waitForTimeout(700);
    const scheduled = (await editor.request("/api/state")).body.state;
    assert.deepEqual(scheduled.rosterSchedule, { enabled: true, anchorDate: targetDate });
    const illegal = structuredClone(scheduled); illegal.rosterSchedule.enabled = false;
    assert.equal((await viewer.request("/api/state", "PUT", { baseState: scheduled, state: illegal })).status, 403);
    const invalid = structuredClone(scheduled); invalid.rosterSchedule.anchorDate = "2030-02-31";
    assert.equal((await owner.request("/api/state", "PUT", { baseState: scheduled, state: invalid })).status, 403);
    await carryPage.locator('[data-open-calendar]').click();
    assert.equal(await carryPage.locator('[data-select-date="2030-01-19"]').isDisabled(), true);
    assert.equal(await carryPage.locator('[data-select-date="2030-01-22"]').isEnabled(), true);
    await carryPage.screenshot({ path: path.join(root, "output", "roster-schedule-calendar.png") });
    await carryPage.locator('[data-close-sheet]').last().click();
    await carryPage.getByRole("button", { name: "Следующая смена", exact: true }).click();
    assert.equal(await carryPage.locator('[data-open-calendar]').innerText(), "22 января 2030");
    await carryPage.getByRole("button", { name: "Предыдущая смена", exact: true }).click();
    assert.equal(await carryPage.locator('[data-open-calendar]').innerText(), "18 января 2030");
    await carryPage.reload();
    await carryPage.getByRole("button", { name: "Следующая смена", exact: true }).waitFor();
    await carryPage.locator('[data-roster-actions] > summary').click();
    await carryPage.screenshot({ path: path.join(root, "output", "roster-actions-menu.png") });
    await carryPage.locator('[data-roster-schedule]').click();
    await carryPage.locator('[name="enabled"]').uncheck();
    await carryPage.getByRole("button", { name: "Сохранить", exact: true }).click();
    await carryPage.locator('[data-open-calendar]').click();
    assert.equal(await carryPage.locator('[data-select-date="2030-01-19"]').isEnabled(), true);
    await carryContext.close();

    const awardContext = await browser.newContext({ viewport: { width: 400, height: 800 } });
    await awardContext.addCookies([{ name: historyCookieName, value: historyCookieValue, url: origin }]);
    await awardContext.addInitScript(() => {
      if (!localStorage.getItem("caraul-ui-v1")) localStorage.setItem("caraul-ui-v1", JSON.stringify({ view: "stats", stats: { section: "achievements", rewardYear: 2026 } }));
    });
    const awardPage = await awardContext.newPage(); await awardPage.goto(origin);
    await awardPage.locator('[data-achievement-add]').click();
    await awardPage.getByLabel("Дата", { exact: true }).fill("2026-11-05");
    await awardPage.getByLabel("Мероприятие или выполненная работа", { exact: true }).fill("Соревнования по ГДЗС");
    await awardPage.getByLabel("Дополнительное поощрение", { exact: true }).check();
    assert.equal(await awardPage.getByLabel("Баллы каждому участнику", { exact: true }).inputValue(), "5");
    await awardPage.locator('[name="participant"][value="history-driver-1"]').check();
    await awardPage.locator('[name="participant"][value="history-driver-2"]').check();
    await awardPage.getByRole("button", { name: "Сохранить", exact: true }).click();
    await awardPage.waitForTimeout(700);
    let awarded = (await editor.request("/api/state")).body.state;
    const competition = awarded.achievements.find((entry) => entry.title === "Соревнования по ГДЗС");
    assert.equal(competition.points, 5); assert.equal(competition.participants.length, 2);
    await awardPage.locator(`[data-achievement-edit="${competition.id}"]`).click();
    await awardPage.getByLabel("Баллы каждому участнику", { exact: true }).fill("8");
    await awardPage.getByLabel("Пояснение", { exact: true }).fill("Победа в соревнованиях");
    await awardPage.getByRole("button", { name: "Сохранить", exact: true }).click();
    await awardPage.waitForTimeout(700);
    await awardPage.locator('[data-achievement-rules]').click();
    await awardPage.locator('[data-category-id="competition"] [name="categoryPoints"]').fill("9");
    await awardPage.getByRole("button", { name: "Сохранить", exact: true }).click();
    await awardPage.waitForTimeout(700);
    awarded = (await owner.request("/api/state")).body.state;
    assert.equal(awarded.achievements.find((entry) => entry.id === competition.id).points, 8);
    await awardPage.locator('[data-achievement-add]').click();
    await awardPage.getByLabel("Дата", { exact: true }).fill("2026-11-06");
    await awardPage.getByLabel("Мероприятие или выполненная работа", { exact: true }).fill("Подготовка техники");
    await awardPage.getByLabel("Вид участия", { exact: true }).selectOption("work");
    await awardPage.locator('[name="participant"][value="history-driver-2"]').check();
    await awardPage.getByRole("button", { name: "Сохранить", exact: true }).click();
    await awardPage.waitForTimeout(700);
    assert.equal(await awardPage.locator('[data-achievement-person]').first().getAttribute("data-achievement-person"), "history-driver-2");
    assert.match(await awardPage.locator('[data-achievement-person="history-driver-2"] > summary').innerText(), /9 б\./);
    await awardPage.locator('[data-achievement-person="history-driver-2"] > summary').click();
    assert.match(await awardPage.locator('[data-achievement-person="history-driver-2"]').innerText(), /Подготовка техники/);
    await awardPage.screenshot({ path: path.join(root, "output", "achievements-statistics.png") });
    await awardPage.locator('[data-achievement-filter]').selectOption("work");
    assert.match(await awardPage.locator('[data-achievement-person="history-driver-2"] > summary').innerText(), /1 б\./);
    await awardPage.reload();
    await awardPage.locator('[data-achievement-filter]').waitFor();
    assert.equal(await awardPage.locator('[data-achievement-filter]').inputValue(), "work");
    await awardPage.locator('[data-achievement-filter]').selectOption("");
    const deleteButton = awardPage.locator(`[data-achievement-delete="${competition.id}"]`);
    awardPage.once("dialog", (dialog) => dialog.accept()); await deleteButton.click();
    await awardPage.waitForTimeout(700);
    assert.match(await awardPage.locator('[data-achievement-person="history-driver-2"] > summary').innerText(), /1 б\./);
    assert.match(await awardPage.locator('[data-achievement-person="history-driver-1"] > summary').innerText(), /0 б\./);
    await awardPage.locator('[data-achievement-rules]').click();
    await awardPage.locator('[data-category-add]').click();
    let customRow = awardPage.locator('[data-category-row]').last();
    await customRow.locator('[name="categoryName"]').fill("Занятия со школьниками");
    await customRow.locator('[name="categoryPoints"]').fill("4");
    await customRow.locator('[name="categoryBonus"]').fill("1");
    await customRow.locator('[name="categoryComment"]').check();
    const customId = await customRow.getAttribute("data-category-id");
    await awardPage.getByRole("button", { name: "Сохранить", exact: true }).click();
    await awardPage.waitForTimeout(700);
    await awardPage.locator('[data-achievement-add]').click();
    await awardPage.getByLabel("Дата", { exact: true }).fill("2026-11-07");
    await awardPage.getByLabel("Мероприятие или выполненная работа", { exact: true }).fill("Урок безопасности");
    await awardPage.getByLabel("Вид участия", { exact: true }).selectOption(customId);
    await awardPage.getByLabel("Дополнительное поощрение", { exact: true }).check();
    assert.equal(await awardPage.getByLabel("Баллы каждому участнику", { exact: true }).inputValue(), "5");
    assert.equal(await awardPage.locator('[name="comment"]').getAttribute("required"), "");
    await awardPage.locator('[name="comment"]').fill("Провели занятие с детьми");
    await awardPage.locator('[name="participant"][value="history-driver-1"]').check();
    await awardPage.getByRole("button", { name: "Сохранить", exact: true }).click();
    await awardPage.waitForTimeout(700);
    await awardPage.locator('[data-achievement-rules]').click();
    customRow = awardPage.locator(`[data-category-id="${customId}"]`);
    await customRow.locator('[name="categoryName"]').fill("Профилактические занятия");
    await customRow.locator('[name="categoryPoints"]').fill("7");
    await customRow.locator('[data-toggle-category]').click();
    await awardPage.screenshot({ path: path.join(root, "output", "achievement-custom-types.png") });
    await awardPage.getByRole("button", { name: "Сохранить", exact: true }).click();
    await awardPage.waitForTimeout(700);
    await awardPage.locator('[data-achievement-filter]').selectOption(customId);
    assert.match(await awardPage.locator('.achievement-journal').innerText(), /Профилактические занятия/);
    assert.match(await awardPage.locator('[data-achievement-person="history-driver-1"] > summary').innerText(), /5 б\./);
    const categoryState = (await editor.request("/api/state")).body.state;
    assert.equal(categoryState.achievements.find((item) => item.type === customId).typeName, "Занятия со школьниками");
    await awardPage.locator('[data-achievement-add]').click();
    assert.equal(await awardPage.locator(`[name="type"] option[value="${customId}"]`).count(), 0);
    await awardPage.locator('[data-close-modal]').first().click();
    await awardPage.locator('[data-achievement-rules]').click();
    await awardPage.locator(`[data-category-id="${customId}"] [data-toggle-category]`).click();
    await awardPage.getByRole("button", { name: "Сохранить", exact: true }).click();
    await awardPage.waitForTimeout(700);
    await awardPage.locator('[data-achievement-add]').click();
    await awardPage.getByLabel("Вид участия", { exact: true }).selectOption(customId);
    assert.equal(await awardPage.getByLabel("Баллы каждому участнику", { exact: true }).inputValue(), "7");
    await awardContext.close();

    // A read-only member can inspect the exact dates behind the totals, clipped to the chosen period.
    const absenceBase = (await owner.request("/api/state")).body.state;
    const absenceState = structuredClone(absenceBase);
    absenceState.absences = [
      { id: "off-boundary", employeeId: "history-driver-1", absenceType: "DAY_OFF", dateFrom: "2026-10-31", dateTo: "2026-11-02" },
      { id: "off-day", employeeId: "history-driver-1", absenceType: "DAY_OFF", dateFrom: "2026-11-10", dateTo: "2026-11-10" },
      { id: "sick-period", employeeId: "history-driver-1", absenceType: "SICK_LEAVE", dateFrom: "2026-11-15", dateTo: "2026-11-17" },
      { id: "outside-period", employeeId: "history-driver-1", absenceType: "DAY_OFF", dateFrom: "2026-12-01", dateTo: "2026-12-01" },
      { id: "other-person", employeeId: "history-driver-2", absenceType: "DAY_OFF", dateFrom: "2026-11-03", dateTo: "2026-11-03" }
    ];
    assert.equal((await owner.request("/api/state", "PUT", { baseState: absenceBase, state: absenceState })).status, 200);
    const absenceContext = await browser.newContext({ viewport: { width: 474, height: 612 } });
    await absenceContext.addCookies([{ name: viewerName, value: viewerValue, url: origin }]);
    await absenceContext.addInitScript(() => localStorage.setItem("caraul-ui-v1", JSON.stringify({ view: "stats", stats: { section: "absences", from: "2026-11-01", to: "2026-11-30" } })));
    const absencePage = await absenceContext.newPage(); await absencePage.goto(origin);
    const dayOff = absencePage.locator('[data-stat-employee="history-driver-1"][data-stat-absence="dayOff"]:visible');
    assert.equal(await dayOff.locator("strong").innerText(), "3");
    await dayOff.click();
    const detail = absencePage.locator('[data-stat-absence-sheet]');
    assert.equal(await detail.locator('.stat-absence-total strong').innerText(), "3");
    const dates = await detail.locator('.stat-absence-dates').innerText();
    assert.match(dates, /01\.11\.2026 — 02\.11\.2026/);
    assert.match(dates, /10\.11\.2026/);
    assert.doesNotMatch(dates, /31\.10|01\.12|03\.11|15\.11/);
    await absencePage.screenshot({ path: path.join(root, "output", "statistics-absence-dates.png") });
    await detail.getByRole("button", { name: "Закрыть", exact: true }).click();
    await absencePage.locator('[data-stat-employee="history-driver-1"][data-stat-absence="sickLeave"]:visible').click();
    assert.match(await detail.locator('.stat-absence-dates').innerText(), /15\.11\.2026 — 17\.11\.2026/);
    assert.equal(await detail.locator('.stat-absence-total strong').innerText(), "3");
    await detail.getByRole("button", { name: "Закрыть", exact: true }).click();
    await absencePage.locator('[data-stat-employee="history-driver-2"][data-stat-absence="sickLeave"]:visible').click();
    assert.match(await detail.innerText(), /За выбранный период больничных нет/);
    await detail.getByRole("button", { name: "Закрыть", exact: true }).click();
    await absencePage.setViewportSize({ width: 1200, height: 900 });
    await absencePage.locator('.stat-table-link[data-stat-employee="history-driver-1"][data-stat-absence="dayOff"]:visible').click();
    assert.equal(await detail.locator('.stat-absence-dates > div').count(), 2);
    assert.deepEqual((await owner.request("/api/state")).body.state.absences, absenceState.absences);
    await absenceContext.close();
  });
});

