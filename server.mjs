import http from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const cardBackgroundDir = path.join(publicDir, "card-backgrounds");
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL || "";
const stateId = process.env.APP_STATE_ID || "main";
const authStoreFile = path.resolve(process.env.AUTH_STORE_FILE || path.join(__dirname, ".data", "auth-store.json"));
const scrypt = promisify(scryptCallback);
const sessionCookieName = "caraul_session";
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const permissionCatalog = {
  "roster.view": "Раскладка: просмотр",
  "roster.edit": "Раскладка: изменение",
  "stats.view": "Статистика: просмотр",
  "employees.view": "Сотрудники: просмотр",
  "employees.edit": "Сотрудники: изменение",
  "work.view": "Работа: просмотр",
  "work.edit": "Работа: изменение",
  "members.manage": "Участники: управление",
  "roles.manage": "Роли: управление",
  "guard.manage": "Караул: настройки"
};
const allPermissions = Object.keys(permissionCatalog);
let authStore = emptyAuthStore();

function emptyAuthStore() {
  return { version: 1, users: [], guards: [], roles: [], memberships: [], invites: [], states: {} };
}

function readSecret(filePath) {
  if (!filePath) return "";
  return readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
}

function createDatabasePool() {
  if (databaseUrl) return new pg.Pool({ connectionString: databaseUrl });

  const databaseHost = process.env.POSTGRES_HOST || "";
  if (!databaseHost) return null;

  const databasePort = Number(process.env.POSTGRES_PORT || 5432);
  const databaseName = process.env.POSTGRES_DB || "";
  const databaseUser = process.env.POSTGRES_USER || "";
  const databasePassword = process.env.POSTGRES_PASSWORD
    || readSecret(process.env.POSTGRES_PASSWORD_FILE || "");

  if (!Number.isInteger(databasePort) || databasePort < 1 || databasePort > 65535) {
    throw new Error("POSTGRES_PORT должен быть целым числом от 1 до 65535");
  }
  if (!databaseName || !databaseUser || !databasePassword) {
    throw new Error("Для подключения к Postgres нужны POSTGRES_DB, POSTGRES_USER и POSTGRES_PASSWORD(_FILE)");
  }

  return new pg.Pool({
    host: databaseHost,
    port: databasePort,
    database: databaseName,
    user: databaseUser,
    password: databasePassword
  });
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT должен быть целым числом от 1 до 65535");
}

const pool = createDatabasePool();
const cardBackgrounds = [
  "depot-night.png",
  "ops-map.png",
  "truck-equipment.png",
  "fire-water.png",
  "tactical-sheet.png",
  "truck-smoke.png"
];
const cardBackgroundCache = new Map();
const absenceSortOrder = {
  VACATION: 0,
  DAY_OFF: 1
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

async function handleHealth(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (req.url === "/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (!pool) {
    sendJson(res, 200, { status: "ok", database: "disabled", storage: "file" });
    return;
  }

  try {
    await pool.query("select 1");
    sendJson(res, 200, { status: "ok", database: "ok" });
  } catch (error) {
    console.error("Проверка готовности Postgres завершилась ошибкой:", error);
    sendJson(res, 503, { status: "unavailable", database: "error" });
  }
}

async function ensureDatabase() {
  if (!pool) {
    await loadAuthStore();
    return;
  }
  await pool.query(`
    create table if not exists app_state (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    create table if not exists app_auth (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
  await loadAuthStore();
}

async function readAppState(guardId) {
  if (!pool) return authStore.states?.[guardId] || null;
  const result = await pool.query("select data from app_state where id = $1", [guardId]);
  return result.rows[0]?.data || null;
}

async function saveAppState(guardId, data) {
  if (!pool) {
    authStore.states ||= {};
    authStore.states[guardId] = data;
    await persistAuthStore();
    return new Date().toISOString();
  }
  const result = await pool.query(`
    insert into app_state (id, data, updated_at)
    values ($1, $2::jsonb, now())
    on conflict (id) do update set data = excluded.data, updated_at = now()
    returning updated_at
  `, [guardId, JSON.stringify(data)]);
  return result.rows[0]?.updated_at || null;
}

function normalizeAuthStore(value) {
  const clean = value && typeof value === "object" ? value : {};
  return {
    version: 1,
    users: Array.isArray(clean.users) ? clean.users : [],
    guards: Array.isArray(clean.guards) ? clean.guards : [],
    roles: Array.isArray(clean.roles) ? clean.roles : [],
    memberships: Array.isArray(clean.memberships) ? clean.memberships : [],
    invites: Array.isArray(clean.invites) ? clean.invites : [],
    states: clean.states && typeof clean.states === "object" && !Array.isArray(clean.states) ? clean.states : {}
  };
}

async function loadAuthStore() {
  if (pool) {
    const result = await pool.query("select data from app_auth where id = 'main'");
    authStore = normalizeAuthStore(result.rows[0]?.data);
    return;
  }
  try {
    authStore = normalizeAuthStore(JSON.parse(await readFile(authStoreFile, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    authStore = emptyAuthStore();
  }
}

async function persistAuthStore() {
  if (pool) {
    await pool.query(`
      insert into app_auth (id, data, updated_at)
      values ('main', $1::jsonb, now())
      on conflict (id) do update set data = excluded.data, updated_at = now()
    `, [JSON.stringify(authStore)]);
    return;
  }
  await mkdir(path.dirname(authStoreFile), { recursive: true });
  const temporaryFile = `${authStoreFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(authStore, null, 2), { mode: 0o600 });
  await rename(temporaryFile, authStoreFile);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy();
        reject(new Error("Payload is too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function randomCardBackgroundDataUrl() {
  const fileName = cardBackgrounds[Math.floor(Math.random() * cardBackgrounds.length)];
  const filePath = path.join(cardBackgroundDir, fileName);
  if (!cardBackgroundCache.has(fileName)) {
    const image = readFileSync(filePath);
    cardBackgroundCache.set(fileName, `data:image/png;base64,${image.toString("base64")}`);
  }
  return cardBackgroundCache.get(fileName);
}

function listItems(items = []) {
  const people = items.length ? items : [{ name: "Не назначено", position: "" }];
  return people.map((person, index) => `
    <li>
      <span>${index + 1}</span>
      <div class="person-line">
        <strong>${escapeHtml(personName(person))}</strong>
        ${personPosition(person) ? `<small>(${escapeHtml(personPosition(person))})</small>` : ""}
      </div>
    </li>
  `).join("");
}

function personName(person) {
  return typeof person === "string" ? person : person?.name || "Не назначено";
}

function personPosition(person) {
  return typeof person === "string" ? "" : person?.position || "";
}

function isDriverPosition(position) {
  return String(position || "").toLowerCase().includes("водител");
}

function compareRosterPeople(a, b) {
  const rtpDiff = Number(hasRtpProfession(b?.additionalProfession)) - Number(hasRtpProfession(a?.additionalProfession));
  if (rtpDiff) return rtpDiff;
  const driverDiff = Number(isDriverPosition(personPosition(a))) - Number(isDriverPosition(personPosition(b)));
  if (driverDiff) return driverDiff;
  return String(a?.lastName || personName(a)).localeCompare(String(b?.lastName || personName(b)), "ru");
}

function createId(prefix) {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function normalizedLogin(value) {
  return String(value || "").trim().toLocaleLowerCase("ru");
}

function validLogin(value) {
  return /^[\p{L}\p{N}._-]{3,40}$/u.test(String(value || ""));
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const result = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${Buffer.from(result).toString("hex")}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, saltHex, hashHex] = String(encoded || "").split("$");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, "hex"), expected.length));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function safeUser(user) {
  return user ? { id: user.id, login: user.login, createdAt: user.createdAt } : null;
}

function rolePermissions(role) {
  if (role?.system === "owner") return [...allPermissions];
  return Array.isArray(role?.permissions) ? role.permissions.filter((permission) => Object.hasOwn(permissionCatalog, permission)) : [];
}

function createGuardForUser(userId, name) {
  const now = new Date().toISOString();
  const guard = { id: createId("guard"), name: String(name || "Мой караул").trim().slice(0, 80) || "Мой караул", ownerUserId: userId, createdAt: now };
  const roles = [
    { id: createId("role"), guardId: guard.id, name: "Главный администратор", system: "owner", permissions: [...allPermissions], createdAt: now },
    { id: createId("role"), guardId: guard.id, name: "Администратор", system: "admin", permissions: [...allPermissions], createdAt: now },
    { id: createId("role"), guardId: guard.id, name: "Редактор", system: "editor", permissions: ["roster.view", "roster.edit", "stats.view", "employees.view", "employees.edit", "work.view", "work.edit"], createdAt: now },
    { id: createId("role"), guardId: guard.id, name: "Наблюдатель", system: "viewer", permissions: ["roster.view", "stats.view", "employees.view", "work.view"], createdAt: now }
  ];
  authStore.guards.push(guard);
  authStore.roles.push(...roles);
  authStore.memberships.push({ id: createId("member"), guardId: guard.id, userId, roleId: roles[0].id, createdAt: now });
  return guard;
}

function membershipsForUser(userId) {
  return authStore.memberships.filter((membership) => membership.userId === userId && authStore.guards.some((guard) => guard.id === membership.guardId));
}

function sessionContext(session) {
  const user = authStore.users.find((item) => item.id === session?.userId);
  if (!user) return null;
  const memberships = membershipsForUser(user.id);
  const membership = memberships.find((item) => item.guardId === session.guardId) || memberships[0];
  if (!membership) return { user, guards: [], membership: null, guard: null, role: null, permissions: [] };
  session.guardId = membership.guardId;
  const guard = authStore.guards.find((item) => item.id === membership.guardId);
  const role = authStore.roles.find((item) => item.id === membership.roleId && item.guardId === membership.guardId);
  return {
    user,
    membership,
    guard,
    role,
    permissions: rolePermissions(role),
    guards: memberships.map((item) => {
      const itemGuard = authStore.guards.find((guardEntry) => guardEntry.id === item.guardId);
      const itemRole = authStore.roles.find((roleEntry) => roleEntry.id === item.roleId);
      return itemGuard ? { id: itemGuard.id, name: itemGuard.name, roleName: itemRole?.name || "Без роли" } : null;
    }).filter(Boolean)
  };
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function getSession(req) {
  const token = parseCookies(req)[sessionCookieName];
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + sessionLifetimeMs;
  return { token, session, context: sessionContext(session) };
}

function setSessionCookie(req, res, token, maxAge = Math.floor(sessionLifetimeMs / 1000)) {
  const secure = req.headers["x-forwarded-proto"] === "https";
  res.setHeader("set-cookie", `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
}

function startSession(req, res, userId, guardId) {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { userId, guardId, expiresAt: Date.now() + sessionLifetimeMs });
  setSessionCookie(req, res, token);
  return sessions.get(token);
}

function endSession(req, res) {
  const active = getSession(req);
  if (active) sessions.delete(active.token);
  setSessionCookie(req, res, "", 0);
}

function hasPermission(context, permission) {
  return Boolean(context?.permissions.includes(permission));
}

function sessionPayload(context) {
  return {
    user: safeUser(context.user),
    guard: context.guard ? { id: context.guard.id, name: context.guard.name, ownerUserId: context.guard.ownerUserId } : null,
    role: context.role ? { id: context.role.id, name: context.role.name, system: context.role.system || "" } : null,
    permissions: context.permissions,
    guards: context.guards,
    canImportLegacy: Boolean(context.guard && authStore.guards.length === 1 && context.guard.ownerUserId === context.user.id),
    permissionCatalog
  };
}

function requireAccountSession(req, res) {
  const active = getSession(req);
  if (!active?.context?.user) {
    sendJson(res, 401, { error: "Требуется вход в систему" });
    return null;
  }
  return active;
}

function requireSession(req, res, permission = "") {
  const active = requireAccountSession(req, res);
  if (!active) return null;
  if (!active.context.guard) {
    sendJson(res, 409, { error: "Сначала создайте караул или примите приглашение" });
    return null;
  }
  if (permission && !hasPermission(active.context, permission)) {
    sendJson(res, 403, { error: "Недостаточно прав" });
    return null;
  }
  return active;
}

function cleanPermissions(value) {
  const permissions = new Set((Array.isArray(value) ? value : []).filter((permission) => Object.hasOwn(permissionCatalog, permission)));
  if (permissions.has("roster.edit")) permissions.add("roster.view");
  if (permissions.has("employees.edit")) permissions.add("employees.view");
  if (permissions.has("work.edit")) permissions.add("work.view");
  return [...permissions];
}

function inviteTokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function loginAttemptKey(req, login) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return `${forwarded || req.socket.remoteAddress || "local"}:${normalizedLogin(login)}`;
}

function loginAttempt(req, login) {
  const key = loginAttemptKey(req, login);
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= Date.now()) return { key, count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  return { key, ...current };
}

function hasRtpProfession(profession) {
  return /(^|[^\p{L}\p{N}])ртп(?=$|[^\p{L}\p{N}])/iu.test(String(profession || ""));
}

function compareAbsentItems(a, b) {
  const orderA = absenceSortOrder[a?.absenceType] ?? 2;
  const orderB = absenceSortOrder[b?.absenceType] ?? 2;
  if (orderA !== orderB) return orderA - orderB;
  return String(a?.lastName || personName(a)).localeCompare(String(b?.lastName || personName(b)), "ru");
}

function sectionHeight(section) {
  if (section.kind === "comment") return 170 + Math.ceil(String(section.text || "").length / 42) * 42;
  return 118 + Math.max(1, section.kind === "absent" ? section.items.length : section.people.length) * (section.kind === "absent" ? 82 : 76)
    + (section.kind === "absent" ? section.items.filter((item) => item.absenceType === "VACATION" && item.vacationPeriod).length * 34 : 0);
}

function distributeSections(sections) {
  const columns = [[], []];
  const heights = [0, 0];
  sections.forEach((section) => {
    const column = heights[0] <= heights[1] ? 0 : 1;
    columns[column].push(section);
    heights[column] += sectionHeight(section) + (columns[column].length > 1 ? 28 : 0);
  });
  return { columns, heights };
}

function renderSection(section) {
  if (section.kind === "comment") {
    return `
      <section class="tone-${section.tone} comment-section">
        <h2>Комментарий</h2>
        <p>${escapeHtml(section.text)}</p>
      </section>
    `;
  }
  if (section.kind === "absent") {
    return `
      <section class="tone-${section.tone}">
        <h2>Отсутствующие сотрудники</h2>
        ${section.items.map((item) => `
          <div class="absence-row">
            <div class="absence-person">
              <strong>${escapeHtml(personName(item))}</strong>
              ${personPosition(item) ? `<small>(${escapeHtml(personPosition(item))})</small>` : ""}
            </div>
            <div class="absence-status">
              <span class="badge">${escapeHtml(item.status || "")}</span>
              ${item.absenceType === "VACATION" && item.vacationPeriod ? `<small class="vacation-period">${escapeHtml(item.vacationPeriod)}</small>` : ""}
            </div>
          </div>
        `).join("")}
      </section>
    `;
  }
  return `
    <section class="tone-${section.tone}">
      <h2>${escapeHtml(section.title)}</h2>
      <ol>${listItems(section.people)}</ol>
    </section>
  `;
}

function renderDutyRosterVkCard(data) {
  const title = String(data.title || "Караул").trim() || "Караул";
  const background = randomCardBackgroundDataUrl();
  const blocks = Array.isArray(data.blocks)
    ? data.blocks.map((block) => ({
      title: block.title || "Блок",
      people: Array.isArray(block.people) ? [...block.people].sort(compareRosterPeople) : []
    })).filter((block) => block.people.length)
    : [];
  const absent = Array.isArray(data.absent) ? [...data.absent].sort(compareAbsentItems) : [];
  const comment = String(data.comment || "").trim();
  const sections = [
    ...blocks.map((block, index) => ({ kind: "people", title: block.title, people: block.people, tone: index % 4 })),
    ...(absent.length ? [{ kind: "absent", items: absent, tone: blocks.length % 4 }] : []),
    ...(comment ? [{ kind: "comment", text: comment, tone: (blocks.length + (absent.length ? 1 : 0)) % 4 }] : [])
  ];
  const { columns, heights } = distributeSections(sections);
  const cardHeight = Math.max(620, 280 + Math.max(...heights, 0));
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { box-sizing: border-box; }
    body {
      width: 1600px;
      min-height: ${cardHeight}px;
      margin: 0;
      background: #0d0b09;
      color: #fff4e6;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    }
	    .card {
	      position: relative;
	      overflow: hidden;
	      width: 1600px;
	      min-height: ${cardHeight}px;
	      padding: 64px 72px;
	      background:
	        radial-gradient(ellipse at center, rgba(0, 0, 0, .12), rgba(0, 0, 0, .3) 100%),
	        linear-gradient(180deg, rgba(0, 0, 0, .1), rgba(0, 0, 0, .18)),
	        url("${background}");
	      background-size: 100% 100%;
	      background-position: center;
	      background-repeat: no-repeat;
	      border: 1px solid rgba(255, 213, 155, .22);
	    }
	    .card::before {
	      content: "";
	      position: absolute;
	      pointer-events: none;
	      inset: 0;
	      z-index: 0;
	      background:
	        radial-gradient(ellipse at center, rgba(0, 0, 0, .08), rgba(0, 0, 0, .26) 78%),
	        linear-gradient(180deg, rgba(0, 0, 0, .04), rgba(0, 0, 0, .12));
	    }
    .topline {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 40px;
      padding-bottom: 34px;
      border-bottom: 3px solid rgba(255, 224, 176, .3);
      box-shadow: 0 1px 0 rgba(96, 210, 255, .22);
    }
	    .header-side {
	      display: grid;
	      justify-items: end;
	      gap: 12px;
	      flex: 0 0 340px;
	    }
    h1 {
      flex: 1 1 auto;
      min-width: 0;
      max-width: 1040px;
      margin: 0;
      font-size: 88px;
      line-height: .92;
      letter-spacing: 0;
      font-weight: 850;
      overflow-wrap: anywhere;
      color: #fff7ed;
      text-shadow: 0 4px 24px rgba(255, 88, 24, .34), 0 1px 0 rgba(255, 255, 255, .16);
    }
    .date {
      width: 340px;
      padding: 18px 24px;
      border: 1px solid rgba(149, 220, 255, .45);
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(17, 31, 38, .88), rgba(41, 24, 17, .78));
      color: #f7fbff;
      text-align: center;
      font-size: 32px;
      font-weight: 750;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06), 0 18px 52px rgba(0, 0, 0, .24);
    }
    .grid {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 28px;
      margin-top: 38px;
      align-items: start;
    }
    .column {
      display: grid;
      gap: 28px;
      align-content: start;
    }
    section {
      position: relative;
      overflow: hidden;
      padding: 34px 28px 28px;
      border-radius: 8px;
      border: 1px solid rgba(255, 233, 204, .17);
      background:
        linear-gradient(145deg, rgba(35, 27, 22, .9), rgba(15, 24, 29, .82));
      box-shadow: 0 24px 58px rgba(0, 0, 0, .22), inset 0 1px 0 rgba(255, 255, 255, .08);
    }
    section::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 12px;
      background: linear-gradient(90deg, #ffbf47, #f04425 52%, #75d5ff);
    }
    .tone-1::before { background: linear-gradient(90deg, #ff5a2c, #ffc857 48%, #63d0ff); }
    .tone-2::before { background: linear-gradient(90deg, #78dfff, #2f86bd 48%, #ff7a2f); }
    .tone-3::before { background: linear-gradient(90deg, #ffd36e, #b94b2d 50%, #9ee8ff); }
    h2 {
      margin: 0 0 22px;
      color: #fff1dd;
      font-size: 34px;
      line-height: 1.1;
      letter-spacing: 0;
      text-transform: uppercase;
      text-shadow: 0 2px 16px rgba(255, 103, 31, .18);
    }
    ol, ul { margin: 0; padding: 0; list-style: none; }
    li {
      display: flex;
      align-items: flex-start;
      gap: 18px;
      min-height: 62px;
      padding: 12px 0;
      border-bottom: 1px solid rgba(255, 239, 220, .12);
      font-size: 32px;
      font-weight: 720;
    }
    li:last-child { border-bottom: 0; }
    li span {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: linear-gradient(145deg, #ffba45, #ef4727);
      color: #1a0e0a;
      font-size: 24px;
      font-weight: 800;
      flex: 0 0 auto;
      box-shadow: 0 0 18px rgba(240, 76, 34, .28);
    }
    li strong {
      display: block;
      min-width: 0;
      color: #fff8ef;
      font-size: 32px;
      line-height: 1.12;
      overflow-wrap: anywhere;
    }
    li small {
      display: inline;
      flex: 1 1 240px;
      min-width: 180px;
      max-width: 360px;
      color: #acd8ec;
      font-size: 20px;
      line-height: 1.15;
      font-weight: 650;
      text-align: left;
      overflow-wrap: anywhere;
    }
    .person-line {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: flex-start;
      gap: 6px 18px;
      width: 100%;
      min-width: 0;
    }
    .absence-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 28px;
      padding: 18px 0;
      border-bottom: 1px solid rgba(255, 239, 220, .12);
      font-size: 31px;
    }
    .absence-row:last-child { border-bottom: 0; }
    .absence-person {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: flex-start;
      gap: 6px 14px;
      flex: 1 1 auto;
      min-width: 0;
    }
    .absence-person strong {
      min-width: 0;
      color: #fff8ef;
      font-size: 33px;
      overflow-wrap: anywhere;
    }
    .absence-person small {
      flex: 1 1 220px;
      min-width: 180px;
      max-width: 340px;
      color: #acd8ec;
      font-size: 20px;
      line-height: 1.15;
      font-weight: 650;
      text-align: left;
      overflow-wrap: anywhere;
    }
    .absence-status {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    .vacation-period {
      color: #dff6ff;
      font-size: 20px;
      white-space: nowrap;
    }
    .badge {
      align-self: center;
      padding: 10px 16px;
      border-radius: 8px;
      background: rgba(153, 223, 255, .16);
      border: 1px solid rgba(167, 229, 255, .24);
      color: #dff6ff;
      font-weight: 760;
      white-space: nowrap;
    }
    .comment-section p {
      margin: 0;
      color: #fff8ef;
      font-size: 32px;
      line-height: 1.3;
      font-weight: 700;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="topline">
	      <h1>${escapeHtml(title)}</h1>
	      <div class="header-side">
	        <div class="date">${escapeHtml(data.dateText || data.date || "")}</div>
	      </div>
    </div>
    <div class="grid">
      <div class="column">${columns[0].map(renderSection).join("")}</div>
      <div class="column">${columns[1].map(renderSection).join("")}</div>
    </div>
  </main>
</body>
</html>`;
}

function accessPayload(context) {
  const canSeeRoles = hasPermission(context, "roles.manage") || hasPermission(context, "members.manage");
  const canSeeMembers = hasPermission(context, "members.manage");
  const allRoles = authStore.roles.filter((role) => role.guardId === context.guard.id).map((role) => ({
    id: role.id,
    name: role.name,
    system: role.system || "",
    permissions: rolePermissions(role)
  }));
  const members = canSeeMembers ? authStore.memberships.filter((membership) => membership.guardId === context.guard.id).map((membership) => {
    const user = authStore.users.find((item) => item.id === membership.userId);
    const role = allRoles.find((item) => item.id === membership.roleId);
    return user ? { id: membership.id, user: safeUser(user), roleId: membership.roleId, roleName: role?.name || "Без роли", isOwner: user.id === context.guard.ownerUserId } : null;
  }).filter(Boolean).sort((a, b) => a.user.login.localeCompare(b.user.login, "ru")) : [];
  const now = Date.now();
  const invites = canSeeMembers ? authStore.invites.filter((invite) => invite.guardId === context.guard.id && !invite.usedAt && Date.parse(invite.expiresAt) > now).map((invite) => ({
    id: invite.id,
    roleId: invite.roleId,
    roleName: allRoles.find((role) => role.id === invite.roleId)?.name || "Без роли",
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt
  })) : [];
  return { ...sessionPayload(context), roles: canSeeRoles ? allRoles : [], members, invites };
}

async function handleAccountApi(req, res, url, payload) {
  if (url.pathname === "/api/auth/register" && req.method === "POST") {
    const login = String(payload.login || "").trim();
    const loginKey = normalizedLogin(login);
    const password = String(payload.password || "");
    if (!validLogin(login)) return sendJson(res, 400, { error: "Логин должен содержать от 3 до 40 букв, цифр или символов . _ -" }), true;
    if (password.length < 6 || password.length > 128) return sendJson(res, 400, { error: "Пароль должен содержать от 6 до 128 символов" }), true;
    if (password !== String(payload.passwordRepeat || "")) return sendJson(res, 400, { error: "Пароли не совпадают" }), true;
    if (authStore.users.some((user) => user.loginKey === loginKey)) return sendJson(res, 409, { error: "Этот логин уже занят" }), true;
    const now = new Date().toISOString();
    const user = { id: createId("user"), login, loginKey, passwordHash: await hashPassword(password), createdAt: now };
    authStore.users.push(user);
    await persistAuthStore();
    const session = startSession(req, res, user.id, "");
    sendJson(res, 201, sessionPayload(sessionContext(session)));
    return true;
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const attempt = loginAttempt(req, payload.login);
    if (attempt.count >= 10) {
      res.setHeader("retry-after", String(Math.max(1, Math.ceil((attempt.resetAt - Date.now()) / 1000))));
      sendJson(res, 429, { error: "Слишком много попыток входа. Попробуйте позже" });
      return true;
    }
    const user = authStore.users.find((item) => item.loginKey === normalizedLogin(payload.login));
    if (!user || !await verifyPassword(String(payload.password || ""), user.passwordHash)) {
      loginAttempts.set(attempt.key, { count: attempt.count + 1, resetAt: attempt.resetAt });
      sendJson(res, 401, { error: "Неверный логин или пароль" });
      return true;
    }
    loginAttempts.delete(attempt.key);
    const membership = membershipsForUser(user.id)[0];
    const session = startSession(req, res, user.id, membership?.guardId || "");
    sendJson(res, 200, sessionPayload(sessionContext(session)));
    return true;
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    endSession(req, res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === "/api/auth/session" && req.method === "GET") {
    const active = getSession(req);
    if (!active?.context?.user) sendJson(res, 401, { error: "Требуется вход в систему" });
    else sendJson(res, 200, sessionPayload(active.context));
    return true;
  }

  if (url.pathname === "/api/guards" && req.method === "POST") {
    const active = requireAccountSession(req, res);
    if (!active) return true;
    const name = String(payload.name || "").trim();
    if (!name || name.length > 80) return sendJson(res, 400, { error: "Укажите название караула до 80 символов" }), true;
    const isFirstGuard = authStore.guards.length === 0;
    const guard = createGuardForUser(active.context.user.id, name);
    if (isFirstGuard) {
      const legacyState = await readAppState(stateId);
      if (legacyState) await saveAppState(guard.id, legacyState);
    }
    active.session.guardId = guard.id;
    await persistAuthStore();
    sendJson(res, 201, sessionPayload(sessionContext(active.session)));
    return true;
  }

  if (url.pathname === "/api/guards/select" && req.method === "POST") {
    const active = requireAccountSession(req, res);
    if (!active) return true;
    const membership = membershipsForUser(active.context.user.id).find((item) => item.guardId === payload.guardId);
    if (!membership) return sendJson(res, 404, { error: "Караул не найден" }), true;
    active.session.guardId = membership.guardId;
    sendJson(res, 200, sessionPayload(sessionContext(active.session)));
    return true;
  }

  if (url.pathname === "/api/guards/current" && req.method === "PUT") {
    const active = requireSession(req, res, "guard.manage");
    if (!active) return true;
    const name = String(payload.name || "").trim();
    if (!name || name.length > 80) return sendJson(res, 400, { error: "Укажите название караула до 80 символов" }), true;
    active.context.guard.name = name;
    await persistAuthStore();
    sendJson(res, 200, sessionPayload(sessionContext(active.session)));
    return true;
  }

  if (url.pathname === "/api/access" && req.method === "GET") {
    const active = requireSession(req, res);
    if (!active) return true;
    sendJson(res, 200, accessPayload(active.context));
    return true;
  }

  if (url.pathname === "/api/roles" && req.method === "POST") {
    const active = requireSession(req, res, "roles.manage");
    if (!active) return true;
    const name = String(payload.name || "").trim();
    if (!name || name.length > 60) return sendJson(res, 400, { error: "Укажите название роли до 60 символов" }), true;
    if (authStore.roles.some((role) => role.guardId === active.context.guard.id && role.name.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru"))) return sendJson(res, 409, { error: "Роль с таким названием уже существует" }), true;
    const role = { id: createId("role"), guardId: active.context.guard.id, name, system: "", permissions: cleanPermissions(payload.permissions), createdAt: new Date().toISOString() };
    authStore.roles.push(role);
    await persistAuthStore();
    sendJson(res, 201, accessPayload(sessionContext(active.session)));
    return true;
  }

  const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
  if (roleMatch && req.method === "PUT") {
    const active = requireSession(req, res, "roles.manage");
    if (!active) return true;
    const role = authStore.roles.find((item) => item.id === roleMatch[1] && item.guardId === active.context.guard.id);
    if (!role) return sendJson(res, 404, { error: "Роль не найдена" }), true;
    if (role.system === "owner") return sendJson(res, 400, { error: "Права главного администратора нельзя изменить" }), true;
    const name = String(payload.name || "").trim();
    if (!name || name.length > 60) return sendJson(res, 400, { error: "Укажите название роли до 60 символов" }), true;
    if (authStore.roles.some((item) => item.guardId === active.context.guard.id && item.id !== role.id && item.name.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru"))) return sendJson(res, 409, { error: "Роль с таким названием уже существует" }), true;
    role.name = name;
    role.permissions = cleanPermissions(payload.permissions);
    await persistAuthStore();
    sendJson(res, 200, accessPayload(sessionContext(active.session)));
    return true;
  }

  if (roleMatch && req.method === "DELETE") {
    const active = requireSession(req, res, "roles.manage");
    if (!active) return true;
    const role = authStore.roles.find((item) => item.id === roleMatch[1] && item.guardId === active.context.guard.id);
    if (!role) return sendJson(res, 404, { error: "Роль не найдена" }), true;
    if (role.system) return sendJson(res, 400, { error: "Системную роль удалить нельзя" }), true;
    if (authStore.memberships.some((item) => item.roleId === role.id)) return sendJson(res, 409, { error: "Сначала назначьте участникам другую роль" }), true;
    authStore.roles = authStore.roles.filter((item) => item.id !== role.id);
    await persistAuthStore();
    sendJson(res, 200, accessPayload(sessionContext(active.session)));
    return true;
  }

  if (url.pathname === "/api/members" && req.method === "POST") {
    const active = requireSession(req, res, "members.manage");
    if (!active) return true;
    const user = authStore.users.find((item) => item.loginKey === normalizedLogin(payload.login));
    const role = authStore.roles.find((item) => item.id === payload.roleId && item.guardId === active.context.guard.id);
    if (!user) return sendJson(res, 404, { error: "Пользователь с таким логином не найден" }), true;
    if (!role || role.system === "owner") return sendJson(res, 400, { error: "Выберите доступную роль" }), true;
    if (authStore.memberships.some((item) => item.guardId === active.context.guard.id && item.userId === user.id)) return sendJson(res, 409, { error: "Пользователь уже состоит в этом карауле" }), true;
    authStore.memberships.push({ id: createId("member"), guardId: active.context.guard.id, userId: user.id, roleId: role.id, createdAt: new Date().toISOString() });
    await persistAuthStore();
    sendJson(res, 201, accessPayload(sessionContext(active.session)));
    return true;
  }

  const memberMatch = url.pathname.match(/^\/api\/members\/([^/]+)$/);
  if (memberMatch && (req.method === "PUT" || req.method === "DELETE")) {
    const active = requireSession(req, res, "members.manage");
    if (!active) return true;
    const membership = authStore.memberships.find((item) => item.id === memberMatch[1] && item.guardId === active.context.guard.id);
    if (!membership) return sendJson(res, 404, { error: "Участник не найден" }), true;
    if (membership.userId === active.context.guard.ownerUserId) return sendJson(res, 400, { error: "Главного администратора нельзя удалить или переназначить" }), true;
    if (req.method === "DELETE") authStore.memberships = authStore.memberships.filter((item) => item.id !== membership.id);
    else {
      const role = authStore.roles.find((item) => item.id === payload.roleId && item.guardId === active.context.guard.id && item.system !== "owner");
      if (!role) return sendJson(res, 400, { error: "Выберите доступную роль" }), true;
      membership.roleId = role.id;
    }
    await persistAuthStore();
    sendJson(res, 200, accessPayload(sessionContext(active.session)));
    return true;
  }

  if (url.pathname === "/api/invites" && req.method === "POST") {
    const active = requireSession(req, res, "members.manage");
    if (!active) return true;
    const role = authStore.roles.find((item) => item.id === payload.roleId && item.guardId === active.context.guard.id && item.system !== "owner");
    if (!role) return sendJson(res, 400, { error: "Выберите доступную роль" }), true;
    const token = randomBytes(24).toString("base64url");
    const invite = { id: createId("invite"), guardId: active.context.guard.id, roleId: role.id, tokenHash: inviteTokenHash(token), createdBy: active.context.user.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), usedAt: "" };
    authStore.invites.push(invite);
    await persistAuthStore();
    const protocol = req.headers["x-forwarded-proto"] || "http";
    sendJson(res, 201, { ...accessPayload(sessionContext(active.session)), inviteUrl: `${protocol}://${req.headers.host}/?invite=${encodeURIComponent(token)}` });
    return true;
  }

  if (url.pathname === "/api/invites/accept" && req.method === "POST") {
    const active = requireAccountSession(req, res);
    if (!active) return true;
    const invite = authStore.invites.find((item) => !item.usedAt && item.tokenHash === inviteTokenHash(String(payload.token || "")) && Date.parse(item.expiresAt) > Date.now());
    if (!invite) return sendJson(res, 404, { error: "Приглашение недействительно или истекло" }), true;
    let membership = authStore.memberships.find((item) => item.guardId === invite.guardId && item.userId === active.context.user.id);
    if (!membership) {
      membership = { id: createId("member"), guardId: invite.guardId, userId: active.context.user.id, roleId: invite.roleId, createdAt: new Date().toISOString() };
      authStore.memberships.push(membership);
    }
    invite.usedAt = new Date().toISOString();
    invite.usedBy = active.context.user.id;
    active.session.guardId = invite.guardId;
    await persistAuthStore();
    sendJson(res, 200, sessionPayload(sessionContext(active.session)));
    return true;
  }

  const inviteMatch = url.pathname.match(/^\/api\/invites\/([^/]+)$/);
  if (inviteMatch && req.method === "DELETE") {
    const active = requireSession(req, res, "members.manage");
    if (!active) return true;
    const invite = authStore.invites.find((item) => item.id === inviteMatch[1] && item.guardId === active.context.guard.id && !item.usedAt);
    if (!invite) return sendJson(res, 404, { error: "Приглашение не найдено" }), true;
    authStore.invites = authStore.invites.filter((item) => item.id !== invite.id);
    await persistAuthStore();
    sendJson(res, 200, accessPayload(sessionContext(active.session)));
    return true;
  }

  return false;
}

function projectAppState(value, context) {
  if (!value || typeof value !== "object") return null;
  const projected = {
    appTitle: value.appTitle || context.guard.name || "Караул",
    employees: [],
    equipment: [],
    equipmentGroups: {},
    absences: [],
    templateBlocks: [],
    rosters: {}
  };
  if (["employees.view", "roster.view", "stats.view"].some((permission) => hasPermission(context, permission))) projected.employees = value.employees || [];
  if (["roster.view", "stats.view"].some((permission) => hasPermission(context, permission))) projected.absences = value.absences || [];
  if (hasPermission(context, "roster.view")) {
    projected.templateBlocks = value.templateBlocks || [];
    projected.rosters = value.rosters || {};
  }
  if (hasPermission(context, "work.view")) {
    projected.equipment = value.equipment || [];
    projected.equipmentGroups = value.equipmentGroups || {};
  }
  return projected;
}

function mergeAuthorizedState(previousValue, submittedValue, context) {
  const previous = previousValue && typeof previousValue === "object" ? previousValue : {};
  const submitted = submittedValue && typeof submittedValue === "object" ? submittedValue : {};
  const visiblePrevious = projectAppState(previous, context) || {};
  const merged = { ...previous };
  const sections = [
    { keys: ["appTitle"], edit: "guard.manage", view: true },
    { keys: ["employees"], edit: "employees.edit", view: ["employees.view", "roster.view", "stats.view"].some((permission) => hasPermission(context, permission)) },
    { keys: ["equipment", "equipmentGroups"], edit: "work.edit", view: hasPermission(context, "work.view") },
    { keys: ["absences"], edit: "roster.edit", view: hasPermission(context, "roster.view") || hasPermission(context, "stats.view") },
    { keys: ["templateBlocks", "rosters"], edit: "roster.edit", view: hasPermission(context, "roster.view") }
  ];
  for (const section of sections) {
    for (const key of section.keys) {
      if (hasPermission(context, section.edit)) {
        if (Object.hasOwn(submitted, key)) merged[key] = submitted[key];
      } else if (section.view && JSON.stringify(submitted[key]) !== JSON.stringify(visiblePrevious[key])) {
        return { error: `Недостаточно прав: ${permissionCatalog[section.edit]}` };
      }
    }
  }
  return { state: merged };
}

async function handleApi(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (await handleAccountApi(req, res, url, payload)) return;

    if (url.pathname === "/api/state") {
      const active = requireSession(req, res);
      if (!active) return;
      if (req.method === "GET") {
        sendJson(res, 200, { state: projectAppState(await readAppState(active.context.guard.id), active.context), database: Boolean(pool) });
        return;
      }

      if (req.method === "PUT" || req.method === "POST") {
        const nextState = payload.state || payload;
        const previousState = await readAppState(active.context.guard.id);
        const merged = mergeAuthorizedState(previousState, nextState, active.context);
        if (merged.error) return sendJson(res, 403, { error: merged.error });
        const savedAt = await saveAppState(active.context.guard.id, merged.state);
        sendJson(res, 200, { ok: true, savedAt });
        return;
      }

      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    if (url.pathname === "/api/roster-card/html") {
      if (!requireSession(req, res, "roster.view")) return;
      sendJson(res, 200, { html: renderDutyRosterVkCard(payload) });
      return;
    }

    if (url.pathname === "/api/roster-card/png") {
      if (!requireSession(req, res, "roster.view")) return;
      try {
        const { chromium } = await import("playwright");
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1600, height: 620 }, deviceScaleFactor: 1 });
        await page.setContent(renderDutyRosterVkCard(payload), { waitUntil: "networkidle" });
        const image = await page.screenshot({ type: "png", fullPage: true });
        await browser.close();
        sendJson(res, 200, {
          mime: "image/png",
          dataUrl: `data:image/png;base64,${image.toString("base64")}`
        });
      } catch (error) {
        sendJson(res, 501, {
          error: "Playwright is not installed yet. Run npm install when the network is available.",
          detail: String(error?.message || error)
        });
      }
      return;
    }

    sendJson(res, 404, { error: "Unknown API route" });
  } catch (error) {
    sendJson(res, 400, { error: String(error?.message || error) });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz" || req.url === "/readyz") {
    await handleHealth(req, res);
    return;
  }

  if (req.url?.startsWith("/api/")) {
    await handleApi(req, res);
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, normalized);

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const statCache = ext === ".html" || ext === ".js" || ext === ".css" ? "no-store" : "public, max-age=3600";
  res.writeHead(200, {
    "content-type": mimeTypes[ext] || "application/octet-stream",
    "cache-control": statCache
  });
  createReadStream(filePath).pipe(res);
});

ensureDatabase()
  .then(() => {
    server.listen(port, host, () => {
      console.log(`Караул доступен: http://localhost:${port}`);
      console.log(`Для телефона в той же Wi-Fi сети откройте: http://<ip-этого-Mac>:${port}`);
      console.log(pool ? "Postgres подключен: аккаунты и караулы сохраняются в БД" : `Postgres не задан: аккаунты и караулы сохраняются в ${authStoreFile}`);
    });
  })
  .catch((error) => {
    console.error("Не удалось подготовить Postgres:", error);
    process.exit(1);
  });

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Получен ${signal}: завершаем HTTP-сервер и подключения к Postgres`);

  const forceExitTimer = setTimeout(() => {
    console.error("Graceful shutdown не завершился за 20 секунд; процесс будет остановлен принудительно");
    process.exit(1);
  }, 20_000);
  forceExitTimer.unref();

  server.close(async (serverError) => {
    try {
      if (pool) await pool.end();
    } catch (poolError) {
      console.error("Не удалось корректно закрыть пул Postgres во время shutdown:", poolError);
      process.exitCode = 1;
    }

    if (serverError) {
      console.error("Не удалось корректно закрыть HTTP-сервер:", serverError);
      process.exitCode = 1;
    }

    clearTimeout(forceExitTimer);
    process.exit(process.exitCode || 0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (pool) {
  pool.on("error", (error) => {
    console.error("Фоновое подключение пула Postgres завершилось ошибкой; следующие запросы попробуют переподключиться:", error);
  });
}
