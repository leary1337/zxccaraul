import http from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL || "";
const stateId = process.env.APP_STATE_ID || "main";
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;

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

async function ensureDatabase() {
  if (!pool) return;
  await pool.query(`
    create table if not exists app_state (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
}

async function readAppState() {
  if (!pool) return null;
  const result = await pool.query("select data from app_state where id = $1", [stateId]);
  return result.rows[0]?.data || null;
}

async function saveAppState(data) {
  if (!pool) return null;
  const result = await pool.query(`
    insert into app_state (id, data, updated_at)
    values ($1, $2::jsonb, now())
    on conflict (id) do update set data = excluded.data, updated_at = now()
    returning updated_at
  `, [stateId, JSON.stringify(data)]);
  return result.rows[0]?.updated_at || null;
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

function namesText(items = []) {
  return items.length ? items.map((item) => escapeHtml(personName(item))).join(", ") : "Не назначено";
}

function personName(person) {
  return typeof person === "string" ? person : person?.name || "Не назначено";
}

function personPosition(person) {
  return typeof person === "string" ? "" : person?.position || "";
}

function sectionHeight(section) {
  return 118 + Math.max(1, section.kind === "absent" ? section.items.length : section.people.length) * (section.kind === "absent" ? 82 : 76);
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
            <span class="badge">${escapeHtml(item.status || "")}</span>
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
  const blocks = Array.isArray(data.blocks)
    ? data.blocks.map((block) => ({
      title: block.title || "Блок",
      people: Array.isArray(block.people) ? block.people : []
    }))
    : [];
  const absent = Array.isArray(data.absent) ? data.absent : [];
  const sections = [
    ...blocks.map((block, index) => ({ kind: "people", title: block.title, people: block.people, tone: index % 4 })),
    ...(absent.length ? [{ kind: "absent", items: absent, tone: blocks.length % 4 }] : [])
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
        radial-gradient(circle at 101% 10%, rgba(70, 190, 255, .28), transparent 34%),
        linear-gradient(145deg, #14100d 0%, #21120e 39%, #111a20 73%, #0b0d10 100%);
      border: 1px solid rgba(255, 213, 155, .22);
    }
    .card::before,
    .card::after {
      content: "";
      position: absolute;
      pointer-events: none;
      inset: auto;
      z-index: 0;
    }
    .card::before {
      left: 0;
      right: 0;
      bottom: 0;
      height: 220px;
      background:
        linear-gradient(118deg, rgba(201, 54, 14, .88) 0 18%, rgba(255, 124, 24, .74) 18% 33%, transparent 33%),
        linear-gradient(102deg, transparent 0 34%, rgba(255, 206, 89, .48) 34% 47%, transparent 47%),
        linear-gradient(76deg, transparent 0 58%, rgba(173, 235, 255, .58) 58% 72%, rgba(53, 137, 181, .54) 72% 100%);
      clip-path: polygon(0 38%, 17% 18%, 38% 44%, 58% 25%, 79% 48%, 100% 20%, 100% 100%, 0 100%);
      opacity: .74;
    }
    .card::after {
      right: 0;
      bottom: 0;
      width: 660px;
      height: 250px;
      background:
        linear-gradient(132deg, transparent 0 32%, rgba(212, 246, 255, .52) 32% 43%, rgba(61, 166, 214, .6) 43% 62%, transparent 62%),
        linear-gradient(96deg, transparent 0 46%, rgba(255, 244, 209, .24) 46% 56%, transparent 56%);
      clip-path: polygon(0 44%, 26% 30%, 50% 50%, 75% 26%, 100% 44%, 100% 100%, 0 100%);
      opacity: .9;
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
    .truck-mark {
      position: relative;
      width: 168px;
      height: 72px;
      margin-right: 8px;
      filter: drop-shadow(0 12px 20px rgba(0, 0, 0, .34));
    }
    .truck-body,
    .truck-cab,
    .truck-ladder,
    .truck-light,
    .truck-window,
    .truck-wheel {
      position: absolute;
      display: block;
    }
    .truck-body {
      left: 10px;
      top: 30px;
      width: 98px;
      height: 30px;
      border-radius: 5px 3px 3px 5px;
      background: linear-gradient(180deg, #ff4a27, #bf2519);
      border: 2px solid rgba(255, 225, 188, .4);
    }
    .truck-body::before {
      content: "";
      position: absolute;
      left: 10px;
      top: 11px;
      width: 68px;
      height: 4px;
      background: rgba(255, 232, 169, .9);
    }
    .truck-cab {
      left: 104px;
      top: 20px;
      width: 48px;
      height: 40px;
      clip-path: polygon(0 30%, 18% 0, 100% 0, 100% 100%, 0 100%);
      border-radius: 4px;
      background: linear-gradient(180deg, #ff6b35, #cf2e1f);
      border: 2px solid rgba(255, 225, 188, .42);
    }
    .truck-window {
      left: 119px;
      top: 27px;
      width: 22px;
      height: 14px;
      clip-path: polygon(0 100%, 18% 0, 100% 0, 100% 100%);
      background: #aee9ff;
    }
    .truck-ladder {
      left: 16px;
      top: 14px;
      width: 104px;
      height: 8px;
      border-top: 3px solid #ffd36b;
      border-bottom: 3px solid #ffd36b;
      transform: rotate(-5deg);
    }
    .truck-ladder::before {
      content: "";
      position: absolute;
      left: 14px;
      right: 14px;
      top: -4px;
      height: 10px;
      background: repeating-linear-gradient(90deg, transparent 0 13px, #ffd36b 13px 17px);
    }
    .truck-light {
      left: 66px;
      top: 24px;
      width: 18px;
      height: 8px;
      border-radius: 9px 9px 2px 2px;
      background: #7adfff;
    }
    .truck-wheel {
      top: 52px;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: #100d0b;
      border: 5px solid #39434a;
    }
    .truck-wheel.one { left: 28px; }
    .truck-wheel.two { left: 112px; }
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
  </style>
</head>
<body>
  <main class="card">
    <div class="topline">
      <h1>${escapeHtml(title)}</h1>
      <div class="header-side">
        <div class="truck-mark" aria-hidden="true">
          <span class="truck-ladder"></span>
          <span class="truck-body"></span>
          <span class="truck-cab"></span>
          <span class="truck-window"></span>
          <span class="truck-light"></span>
          <span class="truck-wheel one"></span>
          <span class="truck-wheel two"></span>
        </div>
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

async function handleApi(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};

    if (req.url === "/api/state") {
      if (req.method === "GET") {
        sendJson(res, 200, { state: await readAppState(), database: Boolean(pool) });
        return;
      }

      if (req.method === "PUT" || req.method === "POST") {
        if (!pool) {
          sendJson(res, 503, { error: "DATABASE_URL is not configured" });
          return;
        }
        const savedAt = await saveAppState(payload.state || payload);
        sendJson(res, 200, { ok: true, savedAt });
        return;
      }

      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    if (req.url === "/api/roster-card/html") {
      sendJson(res, 200, { html: renderDutyRosterVkCard(payload) });
      return;
    }

    if (req.url === "/api/roster-card/png") {
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
      console.log(pool ? "Postgres подключен: состояние сохраняется в БД" : "DATABASE_URL не задан: серверное сохранение отключено");
    });
  })
  .catch((error) => {
    console.error("Не удалось подготовить Postgres:", error);
    process.exit(1);
  });
