const STORAGE_KEY = "caraul-state-v2";
const AUTH_KEY = "caraul-auth-v1";

const views = [
  ["roster", "▦", "Раскладка"],
  ["stats", "▤", "Статистика"],
  ["employees", "☷", "Сотрудники"]
];

const absenceLabels = {
  DAY_OFF: "Отгул",
  SICK_LEAVE: "Больничный",
  VACATION: "Отпуск",
  BUSINESS_TRIP: "Командировка"
};

const absenceColors = {
  DAY_OFF: "green",
  SICK_LEAVE: "blue",
  VACATION: "violet",
  BUSINESS_TRIP: "yellow"
};

const monthNames = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь"
];

const shortMonthNames = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря"
];

const app = document.querySelector("#app");
let state = loadState();
let authenticated = localStorage.getItem(AUTH_KEY) === "ok";
let remoteStateLoaded = false;
let persistTimer = 0;
let ui = {
  view: "roster",
  selectedDate: isoDate(addDays(new Date(), 1)),
  sheet: null,
  modal: null,
  toast: "",
  stats: {
    from: `${new Date().getFullYear()}-01-01`,
    to: `${new Date().getFullYear()}-12-31`,
    employeeId: "",
    absenceType: "",
    onlyWithAbsences: false,
    sortKey: "name",
    sortDir: "desc",
    columns: ["dayOff", "sickLeave"]
  },
  employeeSearch: "",
  sending: false,
  renderedPng: "",
  pngStatus: ""
};

function makeShortName(lastName, firstName, middleName) {
  return `${lastName} ${firstName?.[0] || ""}.${middleName?.[0] || ""}.`;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (Array.isArray(saved?.employees)) return normalizeState(saved);
  } catch {
    // Keep the default state if localStorage was manually edited.
  }
  return {
    appTitle: "Караул",
    employees: [],
    absences: [],
    templateBlocks: [],
    rosters: {}
  };
}

function normalizeState(nextState) {
  nextState.appTitle = String(nextState.appTitle || "Караул").trim() || "Караул";
  nextState.employees = nextState.employees.map((employee) => ({
    position: "",
    additionalProfession: "",
    comment: "",
    isActive: true,
    ...employee
  }));
  nextState.templateBlocks = normalizeTemplateBlocks(nextState.templateBlocks);
  return nextState;
}

function normalizeTemplateBlocks(blocks = []) {
  return Array.isArray(blocks)
    ? blocks.map((block) => ({ title: String(block.title || "").trim() })).filter((block) => block.title)
    : [];
}

function normalizeRoster(roster) {
  if (!Array.isArray(roster.blocks)) {
    const blocks = [];
    const addLegacyBlock = (title, members = []) => {
      const cleanMembers = Array.isArray(members) ? members.filter(Boolean) : [];
      if (cleanMembers.length) blocks.push({ id: createId("block"), title, members: cleanMembers });
    };
    addLegacyBlock("Диспетчер", roster.units?.dispatcher);
    addLegacyBlock("1-й ход", roster.firstShift);
    addLegacyBlock("2-й ход", roster.secondShift);
    addLegacyBlock("АКП", roster.units?.akp);
    (roster.units?.vehicles || []).forEach((vehicle) => addLegacyBlock(vehicle.label || "Машина", vehicle.members));
    addLegacyBlock(reserveDriverLabel(roster.date), roster.units?.reserve);
    roster.blocks = blocks;
  }
  roster.blocks = roster.blocks.map((block) => ({
    id: block.id || createId("block"),
    title: String(block.title || "Новый блок").trim() || "Новый блок",
    members: Array.isArray(block.members) ? block.members.filter(Boolean) : []
  }));
  delete roster.firstShift;
  delete roster.secondShift;
  delete roster.units;
  delete roster.drivers;
  return roster;
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (!remoteStateLoaded) return;
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(saveStateToServer, 450);
}

async function loadStateFromServer() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("state api unavailable");
    const result = await response.json();
    remoteStateLoaded = true;
    if (Array.isArray(result.state?.employees)) {
      state = normalizeState(result.state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      normalizeStatsDates();
      render();
    } else {
      persist();
    }
  } catch {
    remoteStateLoaded = false;
  }
}

async function saveStateToServer() {
  try {
    await fetch("/api/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state })
    });
  } catch {
    // Local storage remains the offline fallback if the database is unavailable.
  }
}

function render() {
  document.title = state.appTitle;
  if (!authenticated) {
    renderLogin();
    return;
  }

  app.innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <div class="brand-title">
            <strong>${escapeHtml(state.appTitle)}</strong>
            <button class="brand-edit" data-edit-app-title type="button" aria-label="Изменить название">✎</button>
          </div>
          <span>${viewSubtitle()}</span>
        </div>
        <nav class="desktop-nav" aria-label="Разделы">${renderNavItems()}</nav>
      </header>
      <main class="main">${renderCurrentView()}</main>
      <nav class="bottom-nav" aria-label="Разделы">${renderNavItems()}</nav>
      ${ui.sheet ? renderSheet() : ""}
      ${ui.modal ? renderModal() : ""}
      ${ui.toast ? `<div class="toast">${escapeHtml(ui.toast)}</div>` : ""}
    </div>
  `;
  bindEvents();
}

function renderLogin() {
  document.title = state.appTitle;
  const mark = Array.from(state.appTitle.trim())[0] || "К";
  app.innerHTML = `
    <main class="login-shell">
      <form class="login-panel" data-login-form>
        <div class="login-mark">${escapeHtml(mark.toUpperCase())}</div>
        <h1>${escapeHtml(state.appTitle)}</h1>
        <p class="muted">Административный вход для ежедневной раскладки.</p>
        <div class="field-group">
          <label for="pin">PIN</label>
          <input id="pin" class="field" name="pin" inputmode="numeric" autocomplete="current-password" placeholder="1234" />
        </div>
        <button class="btn" type="submit" style="width:100%">Войти</button>
        ${ui.toast ? `<p class="small" style="color:var(--danger);margin:12px 0 0">${escapeHtml(ui.toast)}</p>` : ""}
      </form>
    </main>
  `;
  document.querySelector("[data-login-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    const pin = new FormData(event.currentTarget).get("pin");
    if (String(pin || "").trim() !== "1234") {
      showToast("Неверный PIN. Для демо используйте 1234.");
      return;
    }
    authenticated = true;
    localStorage.setItem(AUTH_KEY, "ok");
    render();
  });
}

function viewSubtitle() {
  if (ui.view === "roster") return formatLongDate(ui.selectedDate);
  if (ui.view === "stats") return "Отсутствия и итоги";
  if (ui.view === "employees") return "Состав и роли";
  return "Ежедневная раскладка";
}

function renderNavItems() {
  return views.map(([view, icon, label]) => `
    <button class="nav-item ${ui.view === view ? "active" : ""}" data-view="${view}" type="button">
      <span>${icon}</span>
      <span>${label}</span>
    </button>
  `).join("");
}

function renderCurrentView() {
  if (ui.view === "stats") return renderStatsView();
  if (ui.view === "employees") return renderEmployeesView();
  return renderRosterView();
}

function getRoster(date = ui.selectedDate) {
  if (state.rosters[date]) return normalizeRoster(state.rosters[date]);
  const now = new Date().toISOString();
  const blocks = templateBlocksForDate(date);
  state.rosters[date] = {
    id: `roster-${date}`,
    date,
    blocks,
    status: "draft",
    version: 1,
    sentVersion: 0,
    sentToVkAt: "",
    createdAt: now,
    updatedAt: now
  };
  if (blocks.length) persist();
  return normalizeRoster(state.rosters[date]);
}

function lastRosterTemplate(targetDate) {
  const candidates = Object.values(state.rosters || {})
    .filter((roster) => roster?.date !== targetDate)
    .map((roster) => normalizeRoster(roster))
    .filter((roster) => roster.blocks.length)
    .sort((a, b) => {
      const updated = String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      if (updated) return updated;
      return String(b.date || "").localeCompare(String(a.date || ""));
    });

  const source = candidates[0];
  if (!source) return [];
  return instantiateTemplateBlocks(currentRosterTemplate(source));
}

function templateBlocksForDate(targetDate) {
  const template = normalizeTemplateBlocks(state.templateBlocks);
  return template.length ? instantiateTemplateBlocks(template) : lastRosterTemplate(targetDate);
}

function currentRosterTemplate(roster) {
  return normalizeRoster(roster).blocks.map((block) => ({ title: block.title }));
}

function instantiateTemplateBlocks(template, existingBlocks = []) {
  const memberBuckets = new Map();
  existingBlocks.forEach((block) => {
    const key = block.title;
    if (!memberBuckets.has(key)) memberBuckets.set(key, []);
    memberBuckets.get(key).push(Array.isArray(block.members) ? block.members.filter(Boolean) : []);
  });

  return normalizeTemplateBlocks(template).map((block) => {
    const bucket = memberBuckets.get(block.title) || [];
    return {
      id: createId("block"),
      title: block.title,
      members: bucket.length ? bucket.shift() : []
    };
  });
}

function applyCurrentTemplateToFutureDates() {
  const source = getRoster();
  const template = currentRosterTemplate(source);
  if (!template.length) return 0;

  const now = new Date().toISOString();
  state.templateBlocks = normalizeTemplateBlocks(template);
  source.updatedAt = now;

  let changed = 0;
  Object.entries(state.rosters || {}).forEach(([date, roster]) => {
    if (date <= ui.selectedDate) return;
    normalizeRoster(roster);
    const nextBlocks = instantiateTemplateBlocks(template, roster.blocks);
    if (JSON.stringify(roster.blocks) === JSON.stringify(nextBlocks)) return;
    roster.blocks = nextBlocks;
    roster.updatedAt = now;
    changed += 1;
  });
  persist();
  return changed;
}

function renderRosterView() {
  const roster = getRoster();
  return `
    <div class="page-title">
      <div>
        <h1>Фото раскладки</h1>
        <div class="muted small">${roster.blocks.length ? `${roster.blocks.length} блок.` : "Создайте первый блок"}</div>
      </div>
      <button class="ghost-btn" data-today type="button">Сегодня</button>
    </div>

    <div class="datebar">
      <button class="icon-btn" data-date-step="-1" type="button" aria-label="Предыдущий день">‹</button>
      <button class="date-display" data-open-calendar type="button">${formatLongDate(ui.selectedDate)}</button>
      <button class="icon-btn" data-date-step="1" type="button" aria-label="Следующий день">›</button>
    </div>

    <div class="toolbar">
      <button class="btn" data-add-block type="button">Добавить блок</button>
    </div>

    <section class="dashboard-grid">
      ${roster.blocks.map((block) => renderCustomBlockPanel(block)).join("") || renderEmptyBlocksPanel()}
      ${renderOthersPanel(roster)}
    </section>

    <div class="bottom-cta">
      <div>
        <strong>PNG строится по созданным блокам</strong>
        <div class="muted small">Повторный выбор сотрудников разрешён в любом блоке.</div>
      </div>
      <button class="btn" data-generate-preview type="button" ${roster.blocks.length ? "" : "disabled"}>Сгенерировать PNG</button>
    </div>
  `;
}

function renderCustomBlockPanel(block) {
  const selected = block.members.filter(Boolean);
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>${escapeHtml(block.title)} ${selected.length ? "✓" : ""}</h2>
          <div class="muted small">Сотрудников можно выбирать повторно</div>
        </div>
        <div class="block-actions">
          <span class="chip yellow">${selected.length}</span>
          <button class="ghost-btn" data-edit-block="${escapeAttr(block.id)}" type="button">Изменить</button>
          <button class="danger-btn" data-delete-block="${escapeAttr(block.id)}" type="button">Удалить</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="slot-list">
          ${selected.map((employeeId, index) => renderAssignmentSlot(block.id, index, employeeId)).join("")}
          ${renderAssignmentSlot(block.id, selected.length, "")}
        </div>
      </div>
    </section>
  `;
}

function renderEmptyBlocksPanel() {
  return `
    <section class="panel">
      <div class="panel-body">
        <div class="empty-state">Блоков пока нет. Нажмите «Добавить блок» и задайте своё название.</div>
      </div>
    </section>
  `;
}

function renderAssignmentSlot(blockId, index, employeeId) {
  const employee = findEmployee(employeeId);
  const block = getRoster().blocks.find((item) => item.id === blockId);
  return `
    <button class="slot ${employee ? "" : "empty"}" data-pick-assignment="${escapeAttr(blockId)}" data-assignment-title="${escapeAttr(block?.title || "Блок")}" data-position="${index}" type="button">
      <span class="slot-index">${index + 1}</span>
      <span class="slot-name">${employee ? escapeHtml(employee.shortName) : "+ Выбрать сотрудника"}</span>
      <span class="slot-meta">${employee ? "Изменить" : ""}</span>
    </button>
  `;
}

function renderOthersPanel(roster) {
  const activeEmployees = state.employees.filter((employee) => employee.isActive);
  return `
    <section class="panel wide">
      <div class="panel-head">
        <div>
          <h2>Отсутствующие сотрудники</h2>
          <div class="muted small">Укажите отгул, больничный, отпуск или командировку</div>
        </div>
        <span class="chip violet">${activeEmployees.length}</span>
      </div>
      <div class="panel-body">
        <div class="other-list">
          ${activeEmployees.map((employee) => {
            const absence = getAbsenceForDate(employee.id, ui.selectedDate);
            return `
              <button class="other-row" data-status-employee="${employee.id}" type="button">
                <span>
                  <span class="row-title">${escapeHtml(employee.shortName)}</span>
                  <span class="row-subtitle">${absence ? absencePeriodText(absence) : "Статус не указан"}</span>
                </span>
                <span class="chip ${absence ? absenceColors[absence.absenceType] : ""}">${absence ? absenceLabels[absence.absenceType] : "Указать"}</span>
              </button>
            `;
          }).join("") || `<div class="empty-state">Все активные сотрудники назначены.</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderStatsView() {
  const rows = calculateStats();
  const selectedEmployee = ui.stats.employeeId ? rows.find((row) => row.employee.id === ui.stats.employeeId) : null;
  const statColumns = [
    ["dayOff", "Отгулы"],
    ["sickLeave", "Больничные"]
  ];
  return `
    <div class="page-title">
      <div>
        <h1>Статистика</h1>
        <div class="muted small">${statsPeriodLabel()}</div>
      </div>
    </div>

    <section class="panel" style="margin-bottom:12px">
      <div class="panel-body">
        <div class="filters">
          <div class="datebar range-datebar wide">
            <button class="date-display" data-open-stats-range type="button">${statsPeriodLabel()}</button>
          </div>
          <input class="field wide" data-stat-search placeholder="Поиск по фамилии" value="${escapeAttr(ui.stats.search || "")}" />
          <select class="field" data-stat-field="employeeId">
            <option value="">Все сотрудники</option>
            ${state.employees.map((employee) => `<option value="${employee.id}" ${ui.stats.employeeId === employee.id ? "selected" : ""}>${escapeHtml(employee.shortName)}</option>`).join("")}
          </select>
          <button class="ghost-btn wide" data-toggle-only-absences type="button">${ui.stats.onlyWithAbsences ? "✓ " : ""}Только с отсутствиями</button>
        </div>
      </div>
    </section>

    ${selectedEmployee ? renderEmployeeStatsCard(selectedEmployee) : ""}

    <div class="stats-list">
      ${rows.map((row) => renderStatPersonCard(row, statColumns)).join("") || `<div class="empty-state">Нет данных за выбранный период</div>`}
    </div>

    <div class="stat-table-wrap desktop-stat-table">
      <table>
        <thead>
          <tr>
            ${renderSortTh("name", "Сотрудник")}
            ${statColumns.map(([key, label]) => renderSortTh(key, label)).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td><button class="ghost-btn" data-stat-employee="${row.employee.id}" type="button">${escapeHtml(row.employee.shortName)}</button></td>
              ${statColumns.map(([key]) => `<td>${row[key]}</td>`).join("")}
            </tr>
          `).join("") || `<tr><td colspan="${statColumns.length + 1}">Нет данных за выбранный период</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function renderStatPersonCard(row, columns) {
  return `
    <button class="stat-person-card" data-stat-employee="${row.employee.id}" type="button">
      <span class="stat-person-head">
        <span>
          <strong>${escapeHtml(row.employee.shortName)}</strong>
          <small class="role-line">${employeeRoleHtml(row.employee)}</small>
        </span>
      </span>
      <span class="stat-metrics">
        ${columns.map(([key, label]) => `
          <span class="stat-metric">
            <strong>${row[key]}</strong>
            <small>${label}</small>
          </span>
        `).join("")}
      </span>
    </button>
  `;
}

function renderSortTh(key, label) {
  const marker = ui.stats.sortKey === key ? (ui.stats.sortDir === "asc" ? " ↑" : " ↓") : "";
  return `<th><button class="ghost-btn" data-sort="${key}" type="button">${label}${marker}</button></th>`;
}

function renderEmployeeStatsCard(row) {
  const events = state.absences
    .filter((absence) => absence.employeeId === row.employee.id)
    .filter((absence) => absence.absenceType === "DAY_OFF" || absence.absenceType === "SICK_LEAVE")
    .sort((a, b) => b.dateFrom.localeCompare(a.dateFrom));
  const byMonth = calculateMonthlyStats(row.employee.id);
  return `
    <section class="panel" style="margin-bottom:12px">
      <div class="panel-head">
        <div>
          <h2>${escapeHtml(row.employee.shortName)}</h2>
          <div class="muted small">${statsPeriodLabel()}</div>
        </div>
        <button class="ghost-btn" data-clear-stat-employee type="button">Все</button>
      </div>
      <div class="panel-body">
        <div class="stat-cards">
          <div class="metric"><strong>${row.dayOff}</strong><span>Отгулы</span></div>
          <div class="metric"><strong>${row.sickLeave}</strong><span>Больничные</span></div>
        </div>
        <h3>По месяцам</h3>
        <div class="stat-table-wrap" style="margin-bottom:12px">
          <table>
            <thead><tr><th>Месяц</th><th>Отгулы</th><th>Больничные</th></tr></thead>
            <tbody>${byMonth.map((month) => `<tr><td>${monthNames[month.month]}</td><td>${month.dayOff}</td><td>${month.sickLeave}</td></tr>`).join("")}</tbody>
          </table>
        </div>
        <h3>События</h3>
        ${events.map((event) => `<div class="absence-row"><div><strong>${periodShort(event.dateFrom, event.dateTo)}</strong><div class="muted small">${absenceLabels[event.absenceType]}${event.comment ? ` · ${escapeHtml(event.comment)}` : ""}</div></div></div>`).join("") || `<div class="empty-state">Событий отсутствия нет.</div>`}
      </div>
    </section>
  `;
}

function renderEmployeesView() {
  const query = ui.employeeSearch.toLowerCase();
  const rows = state.employees
    .filter((employee) => !query || employeeSearchText(employee).includes(query))
    .sort((a, b) => a.lastName.localeCompare(b.lastName, "ru"));
  return `
    <div class="page-title">
      <h1>Сотрудники</h1>
      <button class="btn" data-add-employee type="button">Добавить</button>
    </div>
    <div class="toolbar">
      <input class="search" data-employee-search placeholder="Поиск по фамилии" value="${escapeAttr(ui.employeeSearch)}" />
    </div>
    <section class="panel">
      <div class="panel-body">
        ${rows.map((employee) => `
          <div class="employee-row">
            <div>
              <div class="row-title">${escapeHtml(employee.shortName)} ${employee.isActive ? "" : `<span class="chip">Архив</span>`}</div>
              <div class="row-subtitle role-line">${employeeRoleHtml(employee)}</div>
            </div>
            <button class="ghost-btn" data-edit-employee="${employee.id}" type="button">Изменить</button>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderSheet() {
  if (ui.sheet.type === "calendar") return renderCalendarSheet();
  if (ui.sheet.type === "statsRange") return renderStatsRangeSheet();
  if (ui.sheet.type === "employeePicker") return renderEmployeePickerSheet();
  if (ui.sheet.type === "statusPicker") return renderStatusPickerSheet();
  return "";
}

function renderCalendarSheet() {
  const monthDate = parseIsoDate(ui.sheet.month || ui.selectedDate);
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leading = (firstDay.getDay() + 6) % 7;
  const today = isoDate(new Date());
  const cells = [];
  for (let index = 0; index < leading; index += 1) cells.push("");
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(isoDate(new Date(year, month, day)));

  return `
    <div class="sheet-backdrop" data-close-sheet>
      <section class="sheet" data-stop>
        <div class="sheet-head">
          <div>
            <h2>Выберите дату</h2>
            <div class="muted small">${monthNames[month]} ${year}</div>
          </div>
          <button class="icon-btn" data-close-sheet type="button">×</button>
        </div>
        <div class="sheet-body">
          <div class="calendar-nav">
            <button class="icon-btn" data-calendar-month="-1" type="button" aria-label="Предыдущий месяц">‹</button>
            <strong>${monthNames[month]} ${year}</strong>
            <button class="icon-btn" data-calendar-month="1" type="button" aria-label="Следующий месяц">›</button>
          </div>
          <div class="calendar-weekdays">
            ${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => `<span>${day}</span>`).join("")}
          </div>
          <div class="calendar-grid">
            ${cells.map((date) => date ? `
              <button class="calendar-day ${date === ui.selectedDate ? "selected" : ""} ${date === today ? "today" : ""}" data-select-date="${date}" type="button">
                ${parseIsoDate(date).getDate()}
              </button>
            ` : `<span class="calendar-empty"></span>`).join("")}
          </div>
          <div class="actions" style="margin-top:14px">
            <button class="ghost-btn" data-calendar-today type="button">Сегодня</button>
            <button class="ghost-btn" data-calendar-tomorrow type="button">Завтра</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderStatsRangeSheet() {
  const monthDate = parseIsoDate(ui.sheet.month || ui.stats.from || ui.selectedDate);
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leading = (firstDay.getDay() + 6) % 7;
  const today = isoDate(new Date());
  const from = ui.sheet.draftFrom || ui.stats.from;
  const to = ui.sheet.draftTo || "";
  const cells = [];
  for (let index = 0; index < leading; index += 1) cells.push("");
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(isoDate(new Date(year, month, day)));

  return `
    <div class="sheet-backdrop" data-close-sheet>
      <section class="sheet" data-stop>
        <div class="sheet-head">
          <div>
            <h2>Диапазон статистики</h2>
            <div class="muted small">${to ? `${formatShortDate(from)} — ${formatShortDate(to)}` : `Начало: ${formatShortDate(from)}`}</div>
          </div>
          <button class="icon-btn" data-close-sheet type="button">×</button>
        </div>
        <div class="sheet-body">
          <div class="calendar-nav">
            <button class="icon-btn" data-calendar-month="-1" type="button" aria-label="Предыдущий месяц">‹</button>
            <strong>${monthNames[month]} ${year}</strong>
            <button class="icon-btn" data-calendar-month="1" type="button" aria-label="Следующий месяц">›</button>
          </div>
          <div class="calendar-weekdays">
            ${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => `<span>${day}</span>`).join("")}
          </div>
          <div class="calendar-grid">
            ${cells.map((date) => {
              if (!date) return `<span class="calendar-empty"></span>`;
              const inRange = from && to && date > from && date < to;
              const isEdge = date === from || date === to;
              return `
                <button class="calendar-day ${date === today ? "today" : ""} ${isEdge ? "selected" : ""} ${inRange ? "in-range" : ""}" data-select-range-date="${date}" type="button">
                  ${parseIsoDate(date).getDate()}
                </button>
              `;
            }).join("")}
          </div>
          <div class="muted small" style="margin-top:12px">Выберите первую и последнюю дату периода.</div>
        </div>
      </section>
    </div>
  `;
}

function renderEmployeePickerSheet() {
  const { assignmentType, position, query = "" } = ui.sheet;
  const roster = getRoster();
  const currentId = getAssignment(roster, assignmentType, position);
  const rows = state.employees
    .filter((employee) => employee.isActive)
    .filter((employee) => !query || employeeSearchText(employee).includes(query.toLowerCase()))
    .sort((a, b) => {
      const aSelected = allEmployeeAssignments(roster, a.id).length ? 1 : 0;
      const bSelected = allEmployeeAssignments(roster, b.id).length ? 1 : 0;
      if (aSelected !== bSelected) return bSelected - aSelected;
      return a.lastName.localeCompare(b.lastName, "ru");
    });

  return `
    <div class="sheet-backdrop" data-close-sheet>
      <section class="sheet" data-stop>
        <div class="sheet-head">
          <div>
            <h2>Выберите сотрудника</h2>
            <div class="muted small">${escapeHtml(ui.sheet.title || assignmentTitle(assignmentType))}</div>
          </div>
          <button class="icon-btn" data-close-sheet type="button">×</button>
        </div>
        <div class="sheet-body">
          <input class="search" data-picker-search placeholder="Поиск по фамилии" value="${escapeAttr(query)}" />
          ${currentId ? `<button class="danger-btn" data-clear-assignment type="button" style="width:100%;margin-top:10px">Очистить назначение</button>` : ""}
          <div class="picker-list">
            ${rows.map((employee) => {
              const selectedIn = allEmployeeAssignments(roster, employee.id);
              const absence = getAbsenceForDate(employee.id, ui.selectedDate);
              const isCurrentSlot = selectedIn.some((item) => item.assignmentType === assignmentType && item.position === position);
              const marker = selectedIn.length
                ? selectedIn.map((item) => item.assignmentType === assignmentType && item.position === position ? "Выбран здесь" : assignmentTitle(item.assignmentType)).join(", ")
                : absence ? absenceLabels[absence.absenceType] : "";
              const className = selectedIn.length ? "selected" : absence ? "warn" : "";
              return `
                <button class="picker-option ${className}" data-select-employee="${employee.id}" type="button">
                  <span>
                    <span class="row-title">${escapeHtml(employee.shortName)}</span>
                    <span class="row-subtitle role-line">${employeeRoleHtml(employee)}</span>
                  </span>
                  ${marker ? `<span class="chip">${marker}</span>` : ""}
                </button>
              `;
            }).join("")}
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderStatusPickerSheet() {
  const employee = findEmployee(ui.sheet.employeeId);
  const active = getAbsenceForDate(employee.id, ui.selectedDate);
  return `
    <div class="sheet-backdrop" data-close-sheet>
      <section class="sheet" data-stop>
        <div class="sheet-head">
          <div>
            <h2>Статус: ${escapeHtml(employee.shortName)}</h2>
            <div class="muted small">${formatLongDate(ui.selectedDate)}</div>
          </div>
          <button class="icon-btn" data-close-sheet type="button">×</button>
        </div>
        <div class="sheet-body">
          <div class="status-grid">
            ${Object.entries(absenceLabels).map(([key, label]) => `<button class="status-btn ${active?.absenceType === key ? "active" : ""}" data-set-status="${key}" type="button">${label}</button>`).join("")}
          </div>
          <div class="actions">
            <button class="danger-btn" data-clear-status type="button">Очистить статус</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderModal() {
  if (ui.modal.type === "preview") return renderPreviewModal();
  if (ui.modal.type === "titleForm") return renderTitleFormModal();
  if (ui.modal.type === "blockForm") return renderBlockFormModal();
  if (ui.modal.type === "employeeForm") return renderEmployeeFormModal();
  return "";
}

function renderPreviewModal() {
  const roster = getRoster();
  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2>Готовое фото</h2>
            <div class="muted small">${formatLongDate(roster.date)}</div>
          </div>
          <button class="icon-btn" data-close-modal type="button">×</button>
        </div>
        <div class="modal-body">
          ${ui.renderedPng ? `<img class="preview-image" src="${ui.renderedPng}" alt="PNG раскладки" />` : `<div class="empty-state">${escapeHtml(ui.pngStatus || "Генерируем PNG...")}</div>`}
        </div>
      </section>
    </div>
  `;
}

function renderBlockFormModal() {
  const block = ui.modal.blockId ? getRoster().blocks.find((item) => item.id === ui.modal.blockId) : null;
  return `
    <div class="modal-backdrop">
      <form class="modal" data-block-form>
        <div class="modal-head">
          <h2>${block ? "Изменить блок" : "Новый блок"}</h2>
          <button class="icon-btn" data-close-modal type="button">×</button>
        </div>
        <div class="modal-body">
          <div class="field-group">
            <label>Название блока</label>
            <input class="field" name="title" required value="${escapeAttr(block?.title || "")}" placeholder="Например: 1-й ход, АКП, Резерв" />
          </div>
          <div class="actions">
            <button class="btn" type="submit">${block ? "Сохранить" : "Создать"}</button>
          </div>
        </div>
      </form>
    </div>
  `;
}

function renderTitleFormModal() {
  return `
    <div class="modal-backdrop">
      <form class="modal" data-title-form>
        <div class="modal-head">
          <h2>Название</h2>
          <button class="icon-btn" data-close-modal type="button">×</button>
        </div>
        <div class="modal-body">
          <div class="field-group">
            <label>Название приложения и PNG</label>
            <input class="field" name="appTitle" required value="${escapeAttr(state.appTitle)}" />
          </div>
          <div class="actions">
            <button class="btn" type="submit">Сохранить</button>
          </div>
        </div>
      </form>
    </div>
  `;
}

function renderEmployeeFormModal() {
  const employee = ui.modal.employeeId ? findEmployee(ui.modal.employeeId) : null;
  const fallback = { lastName: "", firstName: "", middleName: "", position: "", additionalProfession: "", comment: "", isActive: true };
  const data = employee || fallback;
  return `
    <div class="modal-backdrop">
      <form class="modal" data-employee-form>
        <div class="modal-head">
          <h2>${employee ? "Сотрудник" : "Новый сотрудник"}</h2>
          <button class="icon-btn" data-close-modal type="button">×</button>
        </div>
        <div class="modal-body">
          <div class="field-group"><label>Фамилия</label><input class="field" name="lastName" required value="${escapeAttr(data.lastName)}" /></div>
          <div class="field-group"><label>Имя</label><input class="field" name="firstName" required value="${escapeAttr(data.firstName)}" /></div>
          <div class="field-group"><label>Отчество</label><input class="field" name="middleName" value="${escapeAttr(data.middleName)}" /></div>
          <div class="field-group"><label>Должность</label><input class="field" name="position" value="${escapeAttr(data.position || "")}" placeholder="Например: пожарный, водитель" /></div>
          <div class="field-group"><label>Доп. профессия</label><input class="field" name="additionalProfession" value="${escapeAttr(data.additionalProfession || "")}" placeholder="Например: ГДЗС, электрик, стропальщик" /></div>
          <div class="status-grid" style="margin-bottom:12px">
            <label class="status-btn"><input type="checkbox" name="isActive" ${data.isActive ? "checked" : ""} /> Активен</label>
          </div>
          <div class="field-group"><label>Комментарий</label><textarea class="field" name="comment">${escapeHtml(data.comment || "")}</textarea></div>
          <div class="actions">
            <button class="btn" type="submit">Сохранить</button>
            ${employee?.isActive ? `<button class="danger-btn" data-archive-employee="${employee.id}" type="button">Архивировать</button>` : ""}
          </div>
        </div>
      </form>
    </div>
  `;
}

function bindEvents() {
  document.querySelector("[data-edit-app-title]")?.addEventListener("click", () => {
    ui.modal = { type: "titleForm" };
    render();
  });

  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    ui.view = button.dataset.view;
    ui.sheet = null;
    ui.modal = null;
    render();
  }));

  bindRosterEvents();
  bindStatsEvents();
  bindEmployeeEvents();
  bindSheetEvents();
  bindModalEvents();
}

function bindRosterEvents() {
  document.querySelectorAll("[data-date-step]").forEach((button) => button.addEventListener("click", () => {
    ui.selectedDate = isoDate(addDays(parseIsoDate(ui.selectedDate), Number(button.dataset.dateStep)));
    render();
  }));
  document.querySelector("[data-today]")?.addEventListener("click", () => {
    ui.selectedDate = isoDate(new Date());
    render();
  });
  document.querySelector("[data-open-calendar]")?.addEventListener("click", () => {
    ui.sheet = { type: "calendar", month: ui.selectedDate };
    render();
  });
  document.querySelectorAll("[data-pick-assignment]").forEach((button) => button.addEventListener("click", () => {
    ui.sheet = {
      type: "employeePicker",
      assignmentType: button.dataset.pickAssignment,
      position: Number(button.dataset.position || 0),
      title: button.dataset.assignmentTitle || assignmentTitle(button.dataset.pickAssignment),
      query: ""
    };
    render();
  }));
  document.querySelector("[data-add-block]")?.addEventListener("click", () => {
    ui.modal = { type: "blockForm" };
    render();
  });
  document.querySelectorAll("[data-edit-block]").forEach((button) => button.addEventListener("click", () => {
    ui.modal = { type: "blockForm", blockId: button.dataset.editBlock };
    render();
  }));
  document.querySelectorAll("[data-delete-block]").forEach((button) => button.addEventListener("click", () => {
    deleteBlock(button.dataset.deleteBlock);
  }));
  document.querySelectorAll("[data-status-employee]").forEach((button) => button.addEventListener("click", () => {
    ui.sheet = { type: "statusPicker", employeeId: button.dataset.statusEmployee };
    render();
  }));
  document.querySelectorAll("[data-generate-preview]").forEach((button) => button.addEventListener("click", openGeneratedPreview));
}

function bindStatsEvents() {
  document.querySelector("[data-open-stats-range]")?.addEventListener("click", () => {
    normalizeStatsDates();
    ui.sheet = { type: "statsRange", month: statsRangeCalendarMonth(), draftFrom: ui.stats.from, draftTo: ui.stats.to };
    render();
  });
  document.querySelectorAll("[data-stat-field]").forEach((input) => input.addEventListener("change", (event) => {
    const key = event.target.dataset.statField;
    ui.stats[key] = event.target.value;
    normalizeStatsDates();
    render();
  }));
  document.querySelector("[data-stat-search]")?.addEventListener("input", (event) => {
    ui.stats.search = event.target.value;
    render();
  });
  document.querySelector("[data-toggle-only-absences]")?.addEventListener("click", () => {
    ui.stats.onlyWithAbsences = !ui.stats.onlyWithAbsences;
    render();
  });
  document.querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => {
    cycleSort(button.dataset.sort);
    render();
  }));
  document.querySelectorAll("[data-stat-employee]").forEach((button) => button.addEventListener("click", () => {
    ui.stats.employeeId = button.dataset.statEmployee;
    render();
  }));
  document.querySelector("[data-clear-stat-employee]")?.addEventListener("click", () => {
    ui.stats.employeeId = "";
    render();
  });
}

function bindEmployeeEvents() {
  document.querySelector("[data-employee-search]")?.addEventListener("input", (event) => {
    ui.employeeSearch = event.target.value;
    render();
  });
  document.querySelector("[data-add-employee]")?.addEventListener("click", () => {
    ui.modal = { type: "employeeForm" };
    render();
  });
  document.querySelectorAll("[data-edit-employee]").forEach((button) => button.addEventListener("click", () => {
    ui.modal = { type: "employeeForm", employeeId: button.dataset.editEmployee };
    render();
  }));
}

function bindSheetEvents() {
  document.querySelectorAll("[data-close-sheet]").forEach((node) => node.addEventListener("click", () => {
    ui.sheet = null;
    render();
  }));
  document.querySelectorAll("[data-stop]").forEach((node) => node.addEventListener("click", (event) => event.stopPropagation()));
  document.querySelector("[data-picker-search]")?.addEventListener("input", (event) => {
    ui.sheet.query = event.target.value;
    render();
  });
  document.querySelector("[data-clear-assignment]")?.addEventListener("click", () => {
    const { assignmentType, position } = ui.sheet;
    updateRoster((roster) => clearAssignment(roster, assignmentType, position));
    ui.sheet = null;
    render();
  });
  document.querySelectorAll("[data-select-employee]").forEach((button) => button.addEventListener("click", () => {
    attemptAssign(button.dataset.selectEmployee);
  }));
  document.querySelectorAll("[data-set-status]").forEach((button) => button.addEventListener("click", () => {
    setAbsenceStatus(button.dataset.setStatus);
  }));
  document.querySelector("[data-clear-status]")?.addEventListener("click", () => {
    clearAbsenceStatus(ui.sheet.employeeId, ui.selectedDate);
    ui.sheet = null;
    render();
  });
  document.querySelectorAll("[data-calendar-month]").forEach((button) => button.addEventListener("click", () => {
    const current = parseIsoDate(ui.sheet.month || ui.selectedDate);
    ui.sheet.month = isoDate(new Date(current.getFullYear(), current.getMonth() + Number(button.dataset.calendarMonth), 1));
    render();
  }));
  document.querySelectorAll("[data-select-date]").forEach((button) => button.addEventListener("click", () => {
    ui.selectedDate = button.dataset.selectDate;
    ui.sheet = null;
    render();
  }));
  document.querySelectorAll("[data-select-range-date]").forEach((button) => button.addEventListener("click", () => {
    selectStatsRangeDate(button.dataset.selectRangeDate);
  }));
  document.querySelector("[data-calendar-today]")?.addEventListener("click", () => {
    ui.selectedDate = isoDate(new Date());
    ui.sheet = null;
    render();
  });
  document.querySelector("[data-calendar-tomorrow]")?.addEventListener("click", () => {
    ui.selectedDate = isoDate(addDays(new Date(), 1));
    ui.sheet = null;
    render();
  });
}

function selectStatsRangeDate(date) {
  if (!ui.sheet.draftFrom || ui.sheet.draftTo) {
    ui.sheet.draftFrom = date;
    ui.sheet.draftTo = "";
    render();
    return;
  }

  const from = ui.sheet.draftFrom <= date ? ui.sheet.draftFrom : date;
  const to = ui.sheet.draftFrom <= date ? date : ui.sheet.draftFrom;
  ui.stats.from = from;
  ui.stats.to = to;
  ui.sheet = null;
  render();
}

function bindModalEvents() {
  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => {
    ui.modal = null;
    ui.sending = false;
    render();
  }));
  document.querySelector("[data-generate-png]")?.addEventListener("click", generatePng);
  document.querySelector("[data-title-form]")?.addEventListener("submit", saveTitleFromForm);
  document.querySelector("[data-block-form]")?.addEventListener("submit", saveBlockFromForm);
  document.querySelector("[data-employee-form]")?.addEventListener("submit", saveEmployeeFromForm);
  document.querySelector("[data-archive-employee]")?.addEventListener("click", (event) => {
    const employee = findEmployee(event.target.dataset.archiveEmployee);
    employee.isActive = false;
    employee.updatedAt = new Date().toISOString();
    persist();
    ui.modal = null;
    render();
  });
}

function attemptAssign(employeeId) {
  const { assignmentType, position } = ui.sheet;
  if (!findEmployee(employeeId)) return;
  assignEmployee(employeeId, assignmentType, position, false);
  ui.sheet = null;
  render();
}

function assignEmployee(employeeId, assignmentType, position) {
  updateRoster((roster) => {
    setAssignment(roster, assignmentType, position, employeeId);
  });
}

function setAbsenceStatus(absenceType) {
  const employeeId = ui.sheet.employeeId;
  const active = getAbsenceForDate(employeeId, ui.selectedDate);

  if (active) {
    active.absenceType = absenceType;
    active.dateFrom = ui.selectedDate;
    active.dateTo = ui.selectedDate;
    active.updatedAt = new Date().toISOString();
  } else {
    state.absences.push({
      id: createId("absence"),
      employeeId,
      absenceType,
      dateFrom: ui.selectedDate,
      dateTo: ui.selectedDate,
      comment: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
  persist();
  ui.sheet = null;
  render();
}

function clearAbsenceStatus(employeeId, date) {
  state.absences = state.absences.filter((absence) => !(absence.employeeId === employeeId && dateInRange(date, absence.dateFrom, absence.dateTo)));
  persist();
}

function updateRoster(mutator) {
  const roster = getRoster();
  const before = JSON.stringify(roster.blocks);
  mutator(roster);
  normalizeRoster(roster);
  const after = JSON.stringify(roster.blocks);
  if (before !== after) {
    roster.updatedAt = new Date().toISOString();
  }
  persist();
}

function saveBlockFromForm(event) {
  event.preventDefault();
  const title = String(new FormData(event.currentTarget).get("title") || "").trim();
  if (!title) return;
  updateRoster((roster) => {
    if (ui.modal.blockId) {
      const block = roster.blocks.find((item) => item.id === ui.modal.blockId);
      if (block) block.title = title;
    } else {
      roster.blocks.push({ id: createId("block"), title, members: [] });
    }
  });
  ui.modal = null;
  render();
}

function deleteBlock(blockId) {
  const roster = getRoster();
  const block = roster.blocks.find((item) => item.id === blockId);
  if (!block) return;
  if (block.members.length && !window.confirm(`Удалить блок «${block.title}» вместе с выбранными сотрудниками?`)) return;
  updateRoster((current) => {
    current.blocks = current.blocks.filter((item) => item.id !== blockId);
  });
  render();
}

async function openGeneratedPreview() {
  ui.modal = { type: "preview" };
  ui.renderedPng = "";
  ui.pngStatus = "Генерируем PNG...";
  render();
  await generatePng();
}

function saveTitleFromForm(event) {
  event.preventDefault();
  const title = String(new FormData(event.currentTarget).get("appTitle") || "").trim();
  if (!title) return;
  state.appTitle = title;
  persist();
  ui.modal = null;
  render();
}

function rosterData(roster) {
  const personData = (id) => {
    const employee = findEmployee(id);
    return employee ? { name: employee.shortName, position: employee.position || "" } : null;
  };
  normalizeRoster(roster);
  const absent = state.employees
    .filter((employee) => employee.isActive)
    .map((employee) => ({ employee, absence: getAbsenceForDate(employee.id, roster.date) }))
    .filter((item) => item.absence)
    .sort((a, b) => a.employee.lastName.localeCompare(b.employee.lastName, "ru"))
    .map((item) => ({
      name: item.employee.shortName,
      position: item.employee.position || "",
      status: absenceLabels[item.absence.absenceType]
    }));
  return {
    title: state.appTitle,
    date: roster.date,
    dateText: formatLongDate(roster.date),
    blocks: roster.blocks.map((block) => ({
      title: block.title,
      people: block.members.map(personData).filter(Boolean)
    })),
    absent
  };
}

async function generatePng() {
  applyCurrentTemplateToFutureDates();
  ui.pngStatus = "Генерируем изображение...";
  render();
  const data = rosterData(getRoster());
  try {
    const response = await fetch("/api/roster-card/png", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Не удалось создать PNG");
    ui.renderedPng = result.dataUrl;
    ui.pngStatus = "";
  } catch (error) {
    ui.renderedPng = generateClientPng(data);
    ui.pngStatus = "PNG подготовлен в браузере.";
  }
  render();
}

function generateClientPng(data) {
  const sections = data.blocks.map((block, index) => ({
    type: "people",
    title: block.title.toUpperCase(),
    color: ["#ffbf47", "#ff5a2c", "#78dfff", "#ffd36e"][index % 4],
    people: block.people
  }));
  if (data.absent?.length) {
    sections.push({
      type: "rows",
      title: "ОТСУТСТВУЮЩИЕ СОТРУДНИКИ",
      color: "#9ee8ff",
      rows: data.absent.map((item) => [
        personName(item),
        item.status,
        item.position || ""
      ])
    });
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  const measureCtx = canvas.getContext("2d");
  const contentX = 96;
  const contentRight = 1504;
  const columnGap = 30;
  const columnWidth = (contentRight - contentX - columnGap) / 2;
  const titleWidth = contentRight - contentX - 420;
  measureCtx.font = "800 82px Arial, sans-serif";
  const titleLines = wrapCanvasLines(measureCtx, data.title || "Караул", titleWidth);
  const titleBlockHeight = titleLines.length * 86;
  const headerBlockHeight = Math.max(titleBlockHeight, 170);
  const measuredSections = sections.map((section) => measureCanvasSection(measureCtx, section, columnWidth));
  const contentStartY = 184 + headerBlockHeight;
  const columnYs = [contentStartY, contentStartY];
  const placements = sections.map((section, index) => {
    const column = columnYs[0] <= columnYs[1] ? 0 : 1;
    const placement = {
      section,
      x: column === 0 ? contentX : contentX + columnWidth + columnGap,
      y: columnYs[column],
      width: columnWidth
    };
    columnYs[column] += measuredSections[index] + 30;
    return placement;
  });
  canvas.height = Math.max(620, Math.max(...columnYs) + 60);
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "top";
  const bg = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  bg.addColorStop(0, "#14100d");
  bg.addColorStop(.42, "#21120e");
  bg.addColorStop(.74, "#111a20");
  bg.addColorStop(1, "#0b0d10");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawCanvasSharpBands(ctx);
  ctx.strokeStyle = "rgba(255, 213, 155, .22)";
  ctx.lineWidth = 2;
  ctx.strokeRect(48, 42, canvas.width - 96, canvas.height - 84);

  let y = 86;
  ctx.fillStyle = "#fff7ed";
  ctx.shadowColor = "rgba(255, 88, 24, .34)";
  ctx.shadowBlur = 24;
  ctx.font = "800 82px Arial, sans-serif";
  titleLines.forEach((line, index) => ctx.fillText(line, contentX, y + index * 86));
  ctx.shadowBlur = 0;
  drawCanvasFireTruck(ctx, contentRight - 176, y - 18);
  drawCanvasDate(ctx, data.dateText, contentRight - 338, y + 74, 338, 78);
  ctx.textAlign = "left";
  y += headerBlockHeight + 30;
  const divider = ctx.createLinearGradient(contentX, y, contentRight, y);
  divider.addColorStop(0, "rgba(255, 194, 92, .75)");
  divider.addColorStop(.55, "rgba(239, 71, 39, .55)");
  divider.addColorStop(1, "rgba(103, 213, 255, .55)");
  ctx.strokeStyle = divider;
  ctx.lineWidth = 5;
  drawCanvasLine(ctx, contentX, y, contentRight, y);
  y += 58;

  placements.forEach(({ section, x: sectionX, y: sectionY, width }) => {
    if (section.type === "people") {
      drawPeopleSection(ctx, section.title, section.people, sectionX, sectionY, section.color, width);
    } else {
      drawRowsSection(ctx, section.title, section.rows, sectionX, sectionY, section.color, width);
    }
  });

  ctx.textAlign = "left";
  return canvas.toDataURL("image/png");
}

function measureCanvasSection(ctx, section, width = 908) {
  const headerHeight = measureCanvasHeader(ctx, section.title, width);
  if (section.type === "people") {
    const people = section.people.length ? section.people : [{ name: "Не назначено", position: "" }];
    return headerHeight + people.reduce((sum, person) => {
      return sum + measureCanvasPersonBlock(ctx, person, width) + 24;
    }, 0) + 36;
  }
  return headerHeight + section.rows.reduce((sum, [label, value, position]) => {
    ctx.font = "800 34px Arial, sans-serif";
    const labelLines = wrapCanvasLines(ctx, position ? `${label} (${position})` : label, width - 210);
    ctx.font = "800 34px Arial, sans-serif";
    const valueLines = wrapCanvasLines(ctx, value || "Не назначено", 180);
    return sum + Math.max(labelLines.length * 42, valueLines.length * 42) + 30;
  }, 0) + 36;
}

function measureCanvasHeader(ctx, title, width = 908) {
  ctx.font = "800 34px Arial, sans-serif";
  return 96 + Math.max(0, wrapCanvasLines(ctx, title, width).length - 1) * 42;
}

function drawSectionHeader(ctx, title, x, y, color, width = 908) {
  const strip = ctx.createLinearGradient(x, y, x + width, y);
  strip.addColorStop(0, color);
  strip.addColorStop(.55, color === "#78dfff" ? "#2f86bd" : "#f04425");
  strip.addColorStop(1, "#75d5ff");
  ctx.fillStyle = strip;
  fillCanvasRoundRect(ctx, x, y, width, 12, 8);
  ctx.fillStyle = "#fff1dd";
  ctx.font = "800 34px Arial, sans-serif";
  const lines = wrapCanvasLines(ctx, title, width);
  lines.forEach((line, index) => ctx.fillText(line, x, y + 46 + index * 42));
  return y + 96 + Math.max(0, lines.length - 1) * 42;
}

function drawPeopleSection(ctx, title, people, x, y, color, width = 908) {
  const top = y;
  const height = measureCanvasSection(ctx, { type: "people", title, people }, width);
  drawCanvasPanel(ctx, x, top, width, height);
  y = drawSectionHeader(ctx, title, x, y, color, width);
  const persons = people.length ? people : [{ name: "Не назначено", position: "" }];
  persons.forEach((person, index) => {
    const personHeight = measureCanvasPersonBlock(ctx, person, width);
    const numberGradient = ctx.createLinearGradient(x + 2, y + 2, x + 46, y + 46);
    numberGradient.addColorStop(0, "#ffba45");
    numberGradient.addColorStop(1, "#ef4727");
    ctx.fillStyle = numberGradient;
    ctx.beginPath();
    ctx.arc(x + 24, y + 24, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a0e0a";
    ctx.font = "800 22px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(index + 1), x + 24, y + 12);
    ctx.textAlign = "left";
    drawCanvasPersonText(ctx, person, x + 62, y, width - 62);
    y += personHeight;
  });
  return y + 32;
}

function measureCanvasPersonBlock(ctx, person, width) {
  const textWidth = width - 62;
  const name = personName(person);
  const position = personPosition(person);
  ctx.font = "700 34px Arial, sans-serif";
  const nameLines = wrapCanvasLines(ctx, name, textWidth);
  if (!position) return Math.max(82, nameLines.length * 44 + 24);

  const positionText = `(${position})`;
  ctx.font = "650 24px Arial, sans-serif";
  const firstLineNameWidth = nameLines.length === 1 ? measureCanvasText(ctx, name, "700 34px Arial, sans-serif") : textWidth;
  const positionFitsFirstLine = nameLines.length === 1 && firstLineNameWidth + 28 + ctx.measureText(positionText).width <= textWidth;
  if (positionFitsFirstLine) return Math.max(82, 68);

  const positionLines = wrapCanvasLines(ctx, positionText, textWidth);
  return Math.max(82, nameLines.length * 42 + positionLines.length * 30 + 18);
}

function drawCanvasPersonText(ctx, person, x, y, width) {
  const name = personName(person);
  const position = personPosition(person);
  ctx.fillStyle = "#fff8ef";
  ctx.font = "700 34px Arial, sans-serif";
  const nameLines = wrapCanvasLines(ctx, name, width);
  nameLines.forEach((line, lineIndex) => ctx.fillText(line, x, y + lineIndex * 42));

  if (!position) return;

  const positionText = `(${position})`;
  ctx.font = "650 24px Arial, sans-serif";
  ctx.fillStyle = "#acd8ec";
  const nameWidth = nameLines.length === 1 ? measureCanvasText(ctx, name, "700 34px Arial, sans-serif") : width;
  if (nameLines.length === 1 && nameWidth + 28 + ctx.measureText(positionText).width <= width) {
    ctx.fillText(positionText, x + nameWidth + 28, y + 7);
    return;
  }

  const positionY = y + nameLines.length * 42 + 2;
  wrapCanvasLines(ctx, positionText, width).forEach((line, lineIndex) => ctx.fillText(line, x, positionY + lineIndex * 30));
}

function drawRowsSection(ctx, title, rows, x, y, color, width = 908) {
  const top = y;
  const height = measureCanvasSection(ctx, { type: "rows", title, rows }, width);
  drawCanvasPanel(ctx, x, top, width, height);
  y = drawSectionHeader(ctx, title, x, y, color, width);
  rows.forEach(([label, value, position]) => {
    ctx.fillStyle = "#fff8ef";
    ctx.font = "800 34px Arial, sans-serif";
    const labelLines = wrapCanvasLines(ctx, position ? `${label} (${position})` : label, width - 210);
    labelLines.forEach((line, index) => ctx.fillText(line, x, y + index * 42));
    let rowHeight = labelLines.length * 42;
    ctx.fillStyle = "#dff6ff";
    ctx.font = "800 34px Arial, sans-serif";
    ctx.textAlign = "right";
    const valueLines = wrapCanvasLines(ctx, value || "Не назначено", 180);
    valueLines.forEach((line, index) => ctx.fillText(line, x + width, y + index * 42));
    ctx.textAlign = "left";
    rowHeight = Math.max(rowHeight, valueLines.length * 42);
    y += rowHeight + 30;
  });
  return y + 34;
}

function drawCanvasPanel(ctx, x, y, width, height) {
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, .22)";
  ctx.shadowBlur = 36;
  ctx.shadowOffsetY = 18;
  const panel = ctx.createLinearGradient(x, y, x + width, y + height);
  panel.addColorStop(0, "rgba(35, 27, 22, .94)");
  panel.addColorStop(1, "rgba(15, 24, 29, .88)");
  ctx.fillStyle = panel;
  fillCanvasRoundRect(ctx, x, y, width, height, 8);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255, 233, 204, .18)";
  ctx.lineWidth = 2;
  strokeCanvasRoundRect(ctx, x, y, width, height, 8);
  ctx.restore();
}

function drawCanvasDate(ctx, text, x, y, width, height) {
  ctx.save();
  const dateFill = ctx.createLinearGradient(x, y, x + width, y + height);
  dateFill.addColorStop(0, "rgba(17, 31, 38, .9)");
  dateFill.addColorStop(1, "rgba(41, 24, 17, .82)");
  ctx.fillStyle = dateFill;
  fillCanvasRoundRect(ctx, x, y, width, height, 8);
  ctx.strokeStyle = "rgba(149, 220, 255, .45)";
  ctx.lineWidth = 2;
  strokeCanvasRoundRect(ctx, x, y, width, height, 8);
  ctx.fillStyle = "#f7fbff";
  ctx.font = "700 34px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(text || "", x + width / 2, y + 22);
  ctx.restore();
}

function drawCanvasSharpBands(ctx) {
  const { width, height } = ctx.canvas;
  ctx.save();
  ctx.fillStyle = "rgba(201, 54, 14, .88)";
  fillCanvasPolygon(ctx, [[0, height - 136], [270, height - 186], [620, height - 95], [0, height]]);
  ctx.fillStyle = "rgba(255, 124, 24, .74)";
  fillCanvasPolygon(ctx, [[250, height - 180], [620, height - 92], [890, height], [165, height]]);
  ctx.fillStyle = "rgba(255, 206, 89, .48)";
  fillCanvasPolygon(ctx, [[555, height - 108], [890, height - 170], [1120, height], [760, height]]);
  ctx.fillStyle = "rgba(212, 246, 255, .52)";
  fillCanvasPolygon(ctx, [[880, height - 168], [1120, height - 94], [1430, height], [1045, height]]);
  ctx.fillStyle = "rgba(53, 137, 181, .58)";
  fillCanvasPolygon(ctx, [[1080, height - 92], [1320, height - 170], [width, height - 116], [width, height], [1260, height]]);
  ctx.fillStyle = "rgba(255, 244, 209, .22)";
  fillCanvasPolygon(ctx, [[980, height - 138], [1124, height - 98], [1068, height - 78], [925, height - 116]]);
  ctx.restore();
}

function drawCanvasFireTruck(ctx, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.shadowColor = "rgba(0, 0, 0, .34)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 10;
  ctx.strokeStyle = "#ffd36b";
  ctx.lineWidth = 5;
  drawCanvasLine(ctx, 18, 20, 120, 12);
  drawCanvasLine(ctx, 18, 28, 120, 20);
  ctx.lineWidth = 3;
  for (let rung = 32; rung <= 102; rung += 18) {
    drawCanvasLine(ctx, rung, 18, rung + 2, 25);
  }
  ctx.shadowBlur = 0;
  const body = ctx.createLinearGradient(10, 30, 10, 62);
  body.addColorStop(0, "#ff4a27");
  body.addColorStop(1, "#bf2519");
  ctx.fillStyle = body;
  fillCanvasRoundRect(ctx, 10, 30, 98, 32, 5);
  ctx.strokeStyle = "rgba(255, 225, 188, .42)";
  ctx.lineWidth = 2;
  strokeCanvasRoundRect(ctx, 10, 30, 98, 32, 5);
  ctx.fillStyle = "rgba(255, 232, 169, .9)";
  ctx.fillRect(20, 43, 68, 4);
  const cab = ctx.createLinearGradient(104, 20, 104, 62);
  cab.addColorStop(0, "#ff6b35");
  cab.addColorStop(1, "#cf2e1f");
  ctx.fillStyle = cab;
  fillCanvasPolygon(ctx, [[104, 32], [113, 20], [152, 20], [152, 62], [104, 62]]);
  ctx.strokeStyle = "rgba(255, 225, 188, .42)";
  ctx.stroke();
  ctx.fillStyle = "#aee9ff";
  fillCanvasPolygon(ctx, [[119, 41], [124, 27], [141, 27], [141, 41]]);
  ctx.fillStyle = "#7adfff";
  fillCanvasRoundRect(ctx, 66, 24, 18, 8, 4);
  drawCanvasWheel(ctx, 40, 64);
  drawCanvasWheel(ctx, 124, 64);
  ctx.restore();
}

function drawCanvasWheel(ctx, x, y) {
  ctx.fillStyle = "#100d0b";
  ctx.beginPath();
  ctx.arc(x, y, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#39434a";
  ctx.lineWidth = 5;
  ctx.stroke();
}

function measureCanvasText(ctx, text, font) {
  const previousFont = ctx.font;
  ctx.font = font;
  const width = ctx.measureText(text).width;
  ctx.font = previousFont;
  return width;
}

function drawCanvasGlow(ctx, x, y, radius, inner, outer) {
  const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
  glow.addColorStop(0, inner);
  glow.addColorStop(1, outer);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function drawCanvasLine(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function fillCanvasRoundRect(ctx, x, y, width, height, radius) {
  roundedCanvasPath(ctx, x, y, width, height, radius);
  ctx.fill();
}

function strokeCanvasRoundRect(ctx, x, y, width, height, radius) {
  roundedCanvasPath(ctx, x, y, width, height, radius);
  ctx.stroke();
}

function fillCanvasPolygon(ctx, points) {
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
}

function roundedCanvasPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function wrapCanvasLines(ctx, text, maxWidth) {
  const words = String(text).split(" ");
  const lines = [];
  let line = "";
  words.forEach((word) => {
    if (ctx.measureText(word).width > maxWidth) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(...breakCanvasWord(ctx, word, maxWidth));
      return;
    }
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  });
  if (line) lines.push(line);
  return lines.length ? lines : [" "];
}

function breakCanvasWord(ctx, word, maxWidth) {
  const chars = Array.from(String(word));
  const parts = [];
  let part = "";
  chars.forEach((char) => {
    const test = `${part}${char}`;
    if (part && ctx.measureText(test).width > maxWidth) {
      parts.push(part);
      part = char;
    } else {
      part = test;
    }
  });
  if (part) parts.push(part);
  return parts;
}

function calculateStats() {
  const period = statsPeriod();
  const search = (ui.stats.search || "").toLowerCase();
  let rows = state.employees.map((employee) => {
    const totals = { dayOff: 0, sickLeave: 0 };
    state.absences
      .filter((absence) => absence.employeeId === employee.id)
      .filter((absence) => absence.absenceType === "DAY_OFF" || absence.absenceType === "SICK_LEAVE")
      .forEach((absence) => {
        const days = overlapDays(absence.dateFrom, absence.dateTo, period.from, period.to);
        if (absence.absenceType === "DAY_OFF") totals.dayOff += days;
        if (absence.absenceType === "SICK_LEAVE") totals.sickLeave += days;
      });
    return { employee, ...totals, total: totals.dayOff + totals.sickLeave };
  });

  rows = rows.filter((row) => !search || employeeSearchText(row.employee).includes(search));
  rows = rows.filter((row) => !ui.stats.employeeId || row.employee.id === ui.stats.employeeId);
  rows = rows.filter((row) => !ui.stats.onlyWithAbsences || row.total > 0);

  if (ui.stats.sortKey) {
    const dir = ui.stats.sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      if (ui.stats.sortKey === "name") return dir * a.employee.lastName.localeCompare(b.employee.lastName, "ru");
      return dir * (a[ui.stats.sortKey] - b[ui.stats.sortKey]);
    });
  }
  return rows;
}

function calculateMonthlyStats(employeeId) {
  const year = parseIsoDate(ui.stats.from || isoDate(new Date())).getFullYear();
  return Array.from({ length: 12 }, (_, month) => {
    const from = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const to = isoDate(new Date(year, month + 1, 0));
    const totals = { month, dayOff: 0, sickLeave: 0 };
    state.absences.filter((absence) => absence.employeeId === employeeId).forEach((absence) => {
      const days = overlapDays(absence.dateFrom, absence.dateTo, from, to);
      if (absence.absenceType === "DAY_OFF") totals.dayOff += days;
      if (absence.absenceType === "SICK_LEAVE") totals.sickLeave += days;
    });
    return totals;
  });
}

function cycleSort(key) {
  if (ui.stats.sortKey !== key) {
    ui.stats.sortKey = key;
    ui.stats.sortDir = "desc";
  } else if (ui.stats.sortDir === "desc") {
    ui.stats.sortDir = "asc";
  } else {
    ui.stats.sortKey = "";
    ui.stats.sortDir = "";
  }
}

function normalizeStatsDates() {
  const year = new Date().getFullYear();
  if (!ui.stats.from) ui.stats.from = `${year}-01-01`;
  if (!ui.stats.to) ui.stats.to = `${year}-12-31`;
  if (ui.stats.from > ui.stats.to) {
    const from = ui.stats.from;
    ui.stats.from = ui.stats.to;
    ui.stats.to = from;
  }
}

function statsPeriod() {
  normalizeStatsDates();
  return { from: ui.stats.from, to: ui.stats.to };
}

function statsPeriodLabel() {
  const period = statsPeriod();
  return `${formatShortDate(period.from)} — ${formatShortDate(period.to)}`;
}

function statsRangeCalendarMonth() {
  if (ui.selectedDate >= ui.stats.from && ui.selectedDate <= ui.stats.to) return ui.selectedDate;
  return ui.stats.from;
}

function saveEmployeeFromForm(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const employee = ui.modal.employeeId ? findEmployee(ui.modal.employeeId) : { id: createId("employee"), createdAt: new Date().toISOString() };
  employee.lastName = String(form.get("lastName") || "").trim();
  employee.firstName = String(form.get("firstName") || "").trim();
  employee.middleName = String(form.get("middleName") || "").trim();
  employee.position = String(form.get("position") || "").trim();
  employee.additionalProfession = String(form.get("additionalProfession") || "").trim();
  employee.shortName = makeShortName(employee.lastName, employee.firstName, employee.middleName);
  employee.canDriveAkp = form.has("canDriveAkp");
  employee.canDriveCar4 = form.has("canDriveCar4");
  employee.canBeReserveDriver = form.has("canBeReserveDriver");
  employee.isActive = form.has("isActive");
  employee.comment = String(form.get("comment") || "");
  employee.updatedAt = new Date().toISOString();
  if (!ui.modal.employeeId) state.employees.push(employee);
  persist();
  ui.modal = null;
  render();
}

function allAssignments(roster) {
  normalizeRoster(roster);
  const items = [];
  roster.blocks.forEach((block) => {
    block.members.forEach((employeeId, position) => employeeId && items.push({ employeeId, assignmentType: block.id, position }));
  });
  return items;
}

function findEmployeeAssignment(roster, employeeId) {
  return allAssignments(roster).find((item) => item.employeeId === employeeId);
}

function allEmployeeAssignments(roster, employeeId) {
  return allAssignments(roster).filter((item) => item.employeeId === employeeId);
}

function getAssignment(roster, assignmentType, position) {
  normalizeRoster(roster);
  return roster.blocks.find((block) => block.id === assignmentType)?.members[position] || "";
}

function setAssignment(roster, assignmentType, position, employeeId) {
  normalizeRoster(roster);
  const block = roster.blocks.find((item) => item.id === assignmentType);
  if (!block) return;
  block.members = block.members.filter(Boolean);
  if (employeeId) block.members[position] = employeeId;
}

function clearAssignment(roster, assignmentType, position) {
  normalizeRoster(roster);
  const block = roster.blocks.find((item) => item.id === assignmentType);
  if (block) block.members = block.members.filter(Boolean).filter((_, index) => index !== position);
}

function removeEmployeeFromRoster(roster, employeeId) {
  normalizeRoster(roster);
  roster.blocks.forEach((block) => {
    block.members = block.members.filter((id) => id && id !== employeeId);
  });
}

function assignmentTitle(assignmentType) {
  return getRoster().blocks.find((block) => block.id === assignmentType)?.title || "Блок";
}

function formatNames(names) {
  return names?.length ? names.map(personName).join(", ") : "не назначено";
}

function employeeRoleHtml(employee) {
  const position = employee.position || "Должность не указана";
  const additional = employee.additionalProfession || "";
  return `
    <span>${escapeHtml(position)}</span>
    ${additional ? `<span class="role-extra">${escapeHtml(additional)}</span>` : ""}
  `;
}

function employeeSearchText(employee) {
  return `${employee.lastName} ${employee.firstName} ${employee.middleName} ${employee.shortName} ${employee.position || ""} ${employee.additionalProfession || ""}`.toLowerCase();
}

function personName(person) {
  return typeof person === "string" ? person : person?.name || "Не назначено";
}

function personPosition(person) {
  return typeof person === "string" ? "" : person?.position || "";
}

function personDisplayName(person) {
  const position = personPosition(person);
  return `${personName(person)}${position ? ` (${position})` : ""}`;
}

function createId(prefix) {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function reserveDriverLabel(date) {
  return `Резервный водитель на ${formatDayMonth(isoDate(addDays(parseIsoDate(date), 2)))}`;
}

function formatDayMonth(value) {
  const date = parseIsoDate(value);
  return `${date.getDate()} ${shortMonthNames[date.getMonth()]}`;
}

function findEmployee(id) {
  return state.employees.find((employee) => employee.id === id);
}

function getAbsenceForDate(employeeId, date) {
  if (!employeeId) return null;
  return state.absences.find((absence) => absence.employeeId === employeeId && dateInRange(date, absence.dateFrom, absence.dateTo));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isoDate(date) {
  const normalized = new Date(date);
  return `${normalized.getFullYear()}-${String(normalized.getMonth() + 1).padStart(2, "0")}-${String(normalized.getDate()).padStart(2, "0")}`;
}

function parseIsoDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatLongDate(value) {
  const date = parseIsoDate(value);
  return `${date.getDate()} ${shortMonthNames[date.getMonth()]} ${date.getFullYear()}`;
}

function formatShortDate(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

function absencePeriodText(absence) {
  if (absence.dateFrom === absence.dateTo) return `${absenceLabels[absence.absenceType]} на день`;
  return `${absenceLabels[absence.absenceType]} до ${formatShortDate(absence.dateTo)}`;
}

function periodShort(from, to) {
  return from === to ? formatShortDate(from) : `${formatShortDate(from)} — ${formatShortDate(to)}`;
}

function dateInRange(date, from, to) {
  return date >= from && date <= to;
}

function overlapDays(fromA, toA, fromB, toB) {
  const start = parseIsoDate(fromA > fromB ? fromA : fromB);
  const end = parseIsoDate(toA < toB ? toA : toB);
  if (end < start) return 0;
  return Math.floor((end - start) / 86_400_000) + 1;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value = "") {
  return escapeHtml(value);
}

function showToast(message) {
  ui.toast = message;
  render();
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    ui.toast = "";
    render();
  }, 2600);
}

window.addEventListener("beforeunload", persist);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

normalizeStatsDates();
render();
loadStateFromServer();
