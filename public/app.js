const STORAGE_KEY = "caraul-state-v2";
const AUTH_KEY = "caraul-auth-v1";
const UI_STORAGE_KEY = "caraul-ui-v1";

const views = [
  ["roster", "▦", "Раскладка"],
  ["stats", "▤", "Статистика"],
  ["employees", "☷", "Сотрудники"],
  ["work", "⚒", "Работа"]
];

const equipmentConditions = {
  READY: { label: "Исправно", color: "green" },
  MAINTENANCE: { label: "На обслуживании", color: "yellow" },
  FAULTY: { label: "Неисправно", color: "orange" }
};

const defaultEquipmentGroups = {
  GASI: "ГАСИ",
  PTV: "ПТВ",
  RHBZ: "РХБЗ",
  MOTOR_PUMPS: "Мотопомпы",
  CHAINSAWS: "Бензопилы"
};

function equipmentGroup(item) {
  return Object.hasOwn(equipmentGroups, item.group) ? item.group : "PTV";
}

const absenceLabels = {
  DAY_OFF: "Отгул",
  SICK_LEAVE: "Больничный",
  VACATION: "Отпуск",
  BUSINESS_TRIP: "Командировка",
  SUBSTITUTE: "Подмена"
};

const vacationLabels = {
  MATERNITY: "Декретный отпуск",
  ANNUAL: "Основной отпуск",
  VETERAN: "Ветеранский отпуск",
  DONOR: "Донорский отпуск",
  GOLDEN: "«Золотой» отпуск",
  STUDY: "Учебный отпуск"
};

function absenceStatusLabel(absence) {
  return (absence.absenceType === "VACATION" && vacationLabels[absence.vacationType])
    || absenceLabels[absence.absenceType];
}

function employeeVacationPeriods(employee) {
  if (Array.isArray(employee?.vacationPeriods)) return employee.vacationPeriods;
  return employee?.vacationDateFrom && employee?.vacationDateTo
    ? [{ dateFrom: employee.vacationDateFrom, dateTo: employee.vacationDateTo }]
    : [];
}

function formatVacationPeriod(period) {
  return `с ${formatShortDate(period.dateFrom)} по ${formatShortDate(period.dateTo)}`;
}

function vacationPeriodText(employee, date) {
  const period = employeeVacationPeriods(employee).find((item) => dateInRange(date, item.dateFrom, item.dateTo));
  return period ? formatVacationPeriod(period) : "";
}

const absenceColors = {
  DAY_OFF: "green",
  SICK_LEAVE: "blue",
  VACATION: "violet",
  BUSINESS_TRIP: "yellow",
  SUBSTITUTE: "orange"
};

const absenceSortOrder = {
  VACATION: 0,
  DAY_OFF: 1
};

const employeePositionSortOrder = {
  rds: 0,
  pnk: 1,
  ko: 2,
  firefighter: 3,
  driver: 4,
  other: 5
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
let equipmentGroups = state.equipmentGroups;
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
    absenceType: "",
    onlyWithAbsences: false,
    sortKey: "name",
    sortDir: "desc",
    columns: ["dayOff", "sickLeave"]
  },
  employeeSearch: "",
  equipmentSearch: "",
  equipmentCondition: "",
  equipmentSort: "asc",
  equipmentGroup: "PTV",
  sending: false,
  renderedPng: "",
  pngStatus: ""
};
let savedUiScroll = { view: "", group: "", top: 0, left: 0 };
let uiScrollTimer = 0;
restoreUiState();

function restoreUiState() {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_STORAGE_KEY) || "null");
    if (!saved || typeof saved !== "object") return;
    const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && isoDate(parseIsoDate(value)) === value;
    if (views.some(([view]) => view === saved.view)) ui.view = saved.view;
    if (validDate(saved.selectedDate)) ui.selectedDate = saved.selectedDate;
    for (const key of ["employeeSearch", "equipmentSearch"]) {
      if (typeof saved[key] === "string") ui[key] = saved[key];
    }
    if (Object.hasOwn(equipmentGroups, saved.equipmentGroup)) ui.equipmentGroup = saved.equipmentGroup;
    if (saved.equipmentCondition === "" || Object.hasOwn(equipmentConditions, saved.equipmentCondition)) ui.equipmentCondition = saved.equipmentCondition;
    if (["asc", "desc"].includes(saved.equipmentSort)) ui.equipmentSort = saved.equipmentSort;
    const stats = saved.stats;
    if (stats && typeof stats === "object") {
      for (const key of ["from", "to"]) if (validDate(stats[key])) ui.stats[key] = stats[key];
      if (typeof stats.search === "string") ui.stats.search = stats.search;
      if (typeof stats.onlyWithAbsences === "boolean") ui.stats.onlyWithAbsences = stats.onlyWithAbsences;
      if (["", "name", "dayOff", "sickLeave", "total"].includes(stats.sortKey)) ui.stats.sortKey = stats.sortKey;
      if (["asc", "desc"].includes(stats.sortDir)) ui.stats.sortDir = stats.sortDir;
      if (stats.absenceType === "" || Object.hasOwn(absenceLabels, stats.absenceType)) ui.stats.absenceType = stats.absenceType;
    }
    if (saved.scroll?.view === ui.view && Number.isFinite(saved.scroll.top) && Number.isFinite(saved.scroll.left)) {
      savedUiScroll = { view: ui.view, group: saved.scroll.group, top: Math.max(0, saved.scroll.top), left: Math.max(0, saved.scroll.left) };
    }
  } catch {
    // An invalid or unavailable UI cache must not block the application.
  }
}

function saveUiState() {
  const main = app.querySelector(".main");
  if (!main) return;
  savedUiScroll = { view: ui.view, group: ui.equipmentGroup, top: main.scrollTop, left: main.scrollLeft };
  try {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({
      view: ui.view,
      selectedDate: ui.selectedDate,
      employeeSearch: ui.employeeSearch,
      equipmentSearch: ui.equipmentSearch,
      equipmentCondition: ui.equipmentCondition,
      equipmentSort: ui.equipmentSort,
      equipmentGroup: ui.equipmentGroup,
      stats: ui.stats,
      scroll: savedUiScroll
    }));
  } catch {
    // Keep the current page usable if browser storage is unavailable.
  }
}

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
    equipment: [],
    equipmentGroups: { ...defaultEquipmentGroups },
    absences: [],
    templateBlocks: [],
    rosters: {}
  };
}

function normalizeState(nextState) {
  const savedGroups = nextState.equipmentGroups;
  const validGroups = savedGroups && typeof savedGroups === "object" && !Array.isArray(savedGroups)
    ? Object.entries(savedGroups).filter(([id, label]) => /^[A-Za-z0-9_-]+$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id) && typeof label === "string" && label.trim())
    : [];
  nextState.equipmentGroups = { ...defaultEquipmentGroups, ...Object.fromEntries(validGroups.map(([id, label]) => [id, label.trim().slice(0, 60)])) };
  nextState.equipment = Array.isArray(nextState.equipment) ? nextState.equipment : [];
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
    ? blocks.map((block) => ({ title: normalizeBlockTitle(String(block.title || "").trim()) })).filter((block) => block.title)
    : [];
}

function normalizeRoster(roster) {
  roster.comment = String(roster.comment || "");
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
    title: normalizeBlockTitle(String(block.title || "Новый блок").trim() || "Новый блок"),
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
      equipmentGroups = state.equipmentGroups;
      if (!Object.hasOwn(equipmentGroups, ui.equipmentGroup)) ui.equipmentGroup = "PTV";
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
  const main = app.querySelector(".main");
  const scrollPosition = main?.dataset.scrollView === ui.view
    ? { top: main.scrollTop, left: main.scrollLeft }
    : !main && savedUiScroll.view === ui.view && (ui.view !== "work" || savedUiScroll.group === ui.equipmentGroup)
      ? savedUiScroll
      : { top: 0, left: 0 };
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
        </div>
        <nav class="desktop-nav" aria-label="Разделы">${renderNavItems()}</nav>
      </header>
      <main class="main" data-scroll-view="${ui.view}">${renderCurrentView()}</main>
      <nav class="bottom-nav" aria-label="Разделы">${renderNavItems()}</nav>
      ${ui.sheet ? renderSheet() : ""}
      ${ui.modal ? renderModal() : ""}
      ${ui.toast ? `<div class="toast">${escapeHtml(ui.toast)}</div>` : ""}
    </div>
  `;
  bindEvents();
  // The scroll container is replaced on every render, including status changes.
  const nextMain = app.querySelector(".main");
  nextMain.scrollTop = scrollPosition.top;
  nextMain.scrollLeft = scrollPosition.left;
  saveUiState();
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

function renderNavItems() {
  return views.map(([view, icon, label]) => `
    <button class="nav-item ${ui.view === view ? "active" : ""}" data-view="${view}" type="button">
      <span>${icon}</span>
      <span>${label}</span>
    </button>
  `).join("");
}

function renderCurrentView() {
  if (ui.view === "work") return renderWorkView();
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
    <div class="page-title roster-page-actions">
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
      ${renderRosterCommentPanel(roster)}
      ${renderOthersPanel(roster)}
    </section>

    <div class="bottom-cta solo">
      <button class="btn" data-generate-preview type="button" ${roster.blocks.length ? "" : "disabled"}>Сгенерировать PNG</button>
    </div>
  `;
}

function renderCustomBlockPanel(block) {
  const selected = block.members.filter(Boolean);
  const title = blockTitleForDate(block.title, ui.selectedDate);
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>${escapeHtml(title)} ${selected.length ? "✓" : ""}</h2>
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

function renderRosterCommentPanel(roster) {
  return `
    <section class="panel wide">
      <div class="panel-head">
        <div>
          <h2>Комментарий</h2>
          <div class="muted small">Короткая заметка для фото раскладки</div>
        </div>
      </div>
      <div class="panel-body">
        <textarea class="field roster-comment" data-roster-comment maxlength="240" placeholder="Например: сбор в 8:30">${escapeHtml(roster.comment || "")}</textarea>
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
    <button class="slot ${employee ? "" : "empty"}" data-pick-assignment="${escapeAttr(blockId)}" data-assignment-title="${escapeAttr(block ? blockTitleForDate(block.title, ui.selectedDate) : "Блок")}" data-position="${index}" type="button">
      <span class="slot-index">${index + 1}</span>
      <span class="slot-name">${employee ? escapeHtml(employee.shortName) : "+ Выбрать сотрудника"}</span>
      <span class="slot-meta">${employee ? "Изменить" : ""}</span>
    </button>
  `;
}

function renderOthersPanel(roster) {
  const assignedEmployeeIds = new Set(allAssignments(roster).map((item) => item.employeeId));
  const activeEmployees = state.employees
    .filter((employee) => employee.isActive)
    .filter((employee) => !assignedEmployeeIds.has(employee.id))
    .sort(compareEmployeesByName);
  return `
    <section class="panel wide">
      <div class="panel-head">
        <div>
          <h2>Отсутствующие</h2>
          <div class="muted small">Укажите отгул, больничный, отпуск, командировку или подмену</div>
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
                <span class="chip ${absence ? absenceColors[absence.absenceType] : ""}">${absence ? absenceStatusLabel(absence) : "Указать"}</span>
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
        <div class="filters stats-filters">
          <div class="datebar range-datebar stats-range">
            <button class="date-display" data-open-stats-range type="button">${statsPeriodLabel()}</button>
          </div>
          <button class="ghost-btn absence-toggle" data-toggle-only-absences type="button">${ui.stats.onlyWithAbsences ? "✓ " : ""}Только с отсутствиями</button>
          <input class="field stat-search" data-stat-search placeholder="Поиск по фамилии" value="${escapeAttr(ui.stats.search || "")}" />
        </div>
      </div>
    </section>

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
              <td>${escapeHtml(row.employee.shortName)}</td>
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
    <article class="stat-person-card">
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
    </article>
  `;
}

function renderSortTh(key, label) {
  const marker = ui.stats.sortKey === key ? (ui.stats.sortDir === "asc" ? "↑" : "↓") : "";
  return `<th><button class="ghost-btn sort-btn" data-sort="${key}" type="button"><span>${label}</span><span class="sort-marker">${marker}</span></button></th>`;
}

function renderEmployeesView() {
  const query = ui.employeeSearch.toLowerCase();
  const rows = state.employees
    .filter((employee) => !query || employeeSearchText(employee).includes(query))
    .sort(compareEmployeesForDirectory);
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
        ${rows.map((employee, index) => `
          <div class="employee-row">
            <span class="employee-number">${index + 1}</span>
            <div>
              <div class="row-title">${escapeHtml(employee.shortName)} ${employee.isActive ? "" : `<span class="chip">Архив</span>`}</div>
              <div class="row-subtitle role-line">${employeeRoleHtml(employee)}</div>
              ${employeeVacationPeriods(employee).map((period) => `<div class="row-subtitle">Отпуск ${formatVacationPeriod(period)}</div>`).join("")}
            </div>
            <button class="ghost-btn" data-edit-employee="${employee.id}" type="button">Изменить</button>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderWorkView() {
  const groupCount = state.equipment.filter((item) => equipmentGroup(item) === ui.equipmentGroup).length;
  return `
    <div class="page-title work-heading">
      <div><h1>Работа</h1><p class="muted">Пожарно-техническое вооружение подразделения</p></div>
      <div class="actions"><button class="ghost-btn" data-manage-equipment-groups type="button">Настроить разделы</button><button class="btn" data-add-equipment type="button">+ Добавить</button></div>
    </div>
    <div class="equipment-tabs" role="tablist" aria-label="Разделы оборудования">${Object.entries(equipmentGroups).map(([key, label]) => `
      <button class="equipment-tab ${ui.equipmentGroup === key ? "active" : ""}" id="equipment-tab-${key}" data-equipment-group="${key}" role="tab" aria-selected="${ui.equipmentGroup === key}" aria-controls="equipment-group-panel" tabindex="${ui.equipmentGroup === key ? 0 : -1}" type="button">${escapeHtml(label)}</button>
    `).join("")}</div>
    <section id="equipment-group-panel" role="tabpanel" aria-labelledby="equipment-tab-${ui.equipmentGroup}">
    <div class="equipment-summary">
      <div class="panel"><span class="muted small">Позиций в разделе «${escapeHtml(equipmentGroups[ui.equipmentGroup])}»</span><strong>${groupCount}</strong></div>
    </div>
    <div class="equipment-filters">
      <div class="field-group"><label for="equipment-search">Поиск по базе</label><input id="equipment-search" class="search" data-equipment-search type="search" placeholder="Название, номер или место хранения" value="${escapeAttr(ui.equipmentSearch)}" /></div>
      <div class="field-group"><label for="equipment-condition-filter">Состояние</label><select id="equipment-condition-filter" class="field" data-equipment-condition><option value="">Все состояния</option>${Object.entries(equipmentConditions).map(([key, value]) => `<option value="${key}" ${ui.equipmentCondition === key ? "selected" : ""}>${value.label}</option>`).join("")}</select></div>
      <div class="field-group"><label for="equipment-sort">По названию</label><select id="equipment-sort" class="field" data-equipment-sort><option value="asc" ${ui.equipmentSort === "asc" ? "selected" : ""}>А–Я</option><option value="desc" ${ui.equipmentSort === "desc" ? "selected" : ""}>Я–А</option></select></div>
    </div>
    <div data-equipment-results>${renderEquipmentResults()}</div>
    </section>
  `;
}

function equipmentInstances(item) {
  const condition = Object.hasOwn(equipmentConditions, item.condition) ? item.condition : "READY";
  if (Array.isArray(item.instances) && item.instances.length) {
    return item.instances.map((instance) => ({
      ...instance,
      condition: Object.hasOwn(equipmentConditions, instance.condition) ? instance.condition : condition
    }));
  }
  const quantity = Number.isSafeInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1;
  return Array.from({ length: quantity }, (_, index) => ({
    inventoryNumber: index === 0 ? item.inventoryNumber || "" : "",
    location: item.location || "",
    condition
  }));
}

function renderEquipmentResults() {
  const query = ui.equipmentSearch.trim().toLocaleLowerCase("ru");
  const groupItems = state.equipment.filter((item) => equipmentGroup(item) === ui.equipmentGroup);
  const items = groupItems.map((item) => {
    const allInstances = equipmentInstances(item);
    const instances = allInstances.map((instance, index) => ({ ...instance, index }))
      .filter((instance) => !ui.equipmentCondition || instance.condition === ui.equipmentCondition)
      .filter((instance) => !query || [item.name, item.category, item.notes, instance.inventoryNumber, instance.location, equipmentConditions[instance.condition].label].join(" ").toLocaleLowerCase("ru").includes(query));
    return { item, instances, total: allInstances.length };
  }).filter(({ instances }) => instances.length)
    .sort((a, b) => (ui.equipmentSort === "desc" ? -1 : 1) * a.item.name.localeCompare(b.item.name, "ru", { numeric: true, sensitivity: "base" }));
  if (!items.length) return `<section class="panel"><div class="empty-state"><h2>${groupItems.length ? "Ничего не найдено" : `В разделе «${escapeHtml(equipmentGroups[ui.equipmentGroup])}» пока нет оборудования`}</h2><p>${groupItems.length ? "Измените запрос или выберите другое состояние." : "Нажмите «Добавить», чтобы внести первую позицию."}</p></div></section>`;
  return `
    <p class="muted small" role="status">Найдено позиций: ${items.length}</p>
    <div class="equipment-list">${items.map(({ item, instances, total }) => {
      return `<article class="panel equipment-card">
        <div class="equipment-card-heading"><h2>${escapeHtml(item.name)}</h2></div>
        <dl class="equipment-details">
          <div><dt>Количество</dt><dd>${total} ${escapeHtml(item.unit || "шт.")}</dd></div>
          <div><dt>Категория</dt><dd>${escapeHtml(item.category || "Не указана")}</dd></div>
        </dl>
        ${instances.length < total ? `<p class="muted small">Показано экземпляров: ${instances.length} из ${total}</p>` : ""}
        <ol class="equipment-instance-list">${instances.map((instance) => `<li>
          <div class="equipment-card-heading"><strong>Экземпляр ${instance.index + 1}</strong><span class="chip ${equipmentConditions[instance.condition].color}">${equipmentConditions[instance.condition].label}</span></div>
          <dl class="equipment-details">
            <div><dt>Инвентарный / заводской номер</dt><dd>${escapeHtml(instance.inventoryNumber || "Не указан")}</dd></div>
            <div><dt>Место хранения</dt><dd>${escapeHtml(instance.location || "Не указано")}</dd></div>
          </dl>
        </li>`).join("")}</ol>
        ${item.notes ? `<p class="equipment-notes">${escapeHtml(item.notes)}</p>` : ""}
        <button class="ghost-btn" data-edit-equipment="${escapeAttr(item.id)}" type="button" aria-label="Изменить: ${escapeAttr(item.name)}">Изменить</button>
      </article>`;
    }).join("")}</div>
  `;
}

function renderEquipmentInstanceFields(instance = {}, index = 0) {
  const fieldId = createId("equipment-instance");
  return `<fieldset class="equipment-instance-fields" data-equipment-instance>
    <legend>Экземпляр <span data-instance-number>${index + 1}</span></legend>
    <div class="field-group"><label for="${fieldId}-number">Инвентарный / заводской номер</label><input id="${fieldId}-number" class="field" name="instanceNumber" maxlength="100" value="${escapeAttr(instance.inventoryNumber || "")}" /></div>
    <div class="field-group"><label for="${fieldId}-location">Место хранения</label><input id="${fieldId}-location" class="field" name="instanceLocation" maxlength="160" value="${escapeAttr(instance.location || "")}" placeholder="Например: склад, стеллаж 2" /></div>
    <div class="field-group"><label for="${fieldId}-condition">Состояние</label><select id="${fieldId}-condition" class="field" name="instanceCondition">${Object.entries(equipmentConditions).map(([key, value]) => `<option value="${key}" ${(instance.condition || "READY") === key ? "selected" : ""}>${value.label}</option>`).join("")}</select></div>
    <button class="danger-btn" data-remove-instance type="button">Удалить экземпляр</button>
  </fieldset>`;
}

function bindEquipmentInstances() {
  const list = document.querySelector("[data-equipment-instances]");
  if (!list) return;
  const updateQuantity = () => {
    const rows = list.querySelectorAll("[data-equipment-instance]");
    document.querySelector("#equipment-quantity").value = rows.length;
    rows.forEach((row, index) => {
      row.querySelector("[data-instance-number]").textContent = index + 1;
      row.querySelector("[data-remove-instance]").disabled = rows.length === 1;
    });
  };
  document.querySelector("[data-add-instance]").addEventListener("click", () => {
    list.insertAdjacentHTML("beforeend", renderEquipmentInstanceFields({}, list.children.length));
    updateQuantity();
    list.lastElementChild.querySelector("input").focus();
  });
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-instance]");
    if (!button || list.children.length <= 1) return;
    button.closest("[data-equipment-instance]").remove();
    updateQuantity();
  });
  updateQuantity();
}

function renderEquipmentFormModal() {
  const item = state.equipment.find((entry) => entry.id === ui.modal.equipmentId);
  const data = item || { quantity: 1, unit: "шт.", condition: "READY" };
  const instances = equipmentInstances(data);
  const group = item ? equipmentGroup(item) : ui.equipmentGroup;
  return `
    <div class="modal-backdrop"><form class="modal" data-equipment-form>
      <div class="modal-head"><h2>${item ? "Карточка оборудования" : "Добавить оборудование"}</h2><button class="icon-btn" data-close-modal type="button" aria-label="Закрыть карточку оборудования">×</button></div>
      <div class="modal-body">
        <div class="field-group"><label for="equipment-group">Раздел</label><select id="equipment-group" class="field" name="group">${Object.entries(equipmentGroups).map(([key, label]) => `<option value="${key}" ${key === group ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></div>
        <div class="field-group"><label for="equipment-name">Наименование</label><input id="equipment-name" class="field" name="name" required maxlength="160" value="${escapeAttr(data.name || "")}" placeholder="Например: пожарный рукав" /></div>
        <div class="field-group"><label for="equipment-category">Категория</label><input id="equipment-category" class="field" name="category" maxlength="100" value="${escapeAttr(data.category || "")}" placeholder="Например: рукавное оборудование" /></div>
        <div class="equipment-form-grid">
          <div class="field-group"><label for="equipment-quantity">Количество</label><input id="equipment-quantity" class="field" name="quantity" type="number" readonly value="${instances.length}" /></div>
          <div class="field-group"><label for="equipment-unit">Единица учёта</label><input id="equipment-unit" class="field" name="unit" required maxlength="20" value="${escapeAttr(data.unit || "шт.")}" placeholder="шт., комплект" /></div>
        </div>
        <p class="muted small">У каждого экземпляра — свой номер, место хранения и состояние. Количество рассчитывается автоматически.</p>
        <div class="equipment-instances" data-equipment-instances>${instances.map(renderEquipmentInstanceFields).join("")}</div>
        <button class="ghost-btn equipment-add-instance" data-add-instance type="button">+ Добавить экземпляр</button>
        <div class="field-group"><label for="equipment-notes">Примечание</label><textarea id="equipment-notes" class="field" name="notes" maxlength="2000" placeholder="Комплектация, особенности, замечания">${escapeHtml(data.notes || "")}</textarea></div>
        <p class="form-error small" data-equipment-error role="alert" hidden></p>
        <div class="actions"><button class="btn" type="submit">Сохранить</button>${item ? `<button class="danger-btn" data-delete-equipment="${escapeAttr(item.id)}" type="button">Удалить</button>` : ""}</div>
      </div>
    </form></div>
  `;
}

function renderEquipmentGroupField(id, label = "") {
  return `<div class="field-group" data-group-row>
    <input type="hidden" name="groupId" value="${escapeAttr(id)}" />
    <label for="group-label-${id}">${label ? "Название раздела" : "Новый раздел"}</label>
    <input id="group-label-${id}" class="field" name="groupLabel" value="${escapeAttr(label)}" required maxlength="60" placeholder="Например: Связь" />
  </div>`;
}

function renderEquipmentGroupsModal() {
  return `<div class="modal-backdrop"><form class="modal" data-equipment-groups-form>
    <div class="modal-head"><h2>Разделы оборудования</h2><button class="icon-btn" data-close-modal type="button" aria-label="Закрыть настройку разделов">×</button></div>
    <div class="modal-body">
      <p class="muted small">Переименуйте разделы или добавьте свои. Оборудование останется в своём разделе.</p>
      <div data-group-fields>${Object.entries(equipmentGroups).map(([id, label]) => renderEquipmentGroupField(id, label)).join("")}</div>
      <p class="form-error small" data-groups-error role="alert" hidden></p>
      <div class="actions"><button class="ghost-btn" data-add-equipment-group type="button">+ Добавить раздел</button><button class="btn" type="submit">Сохранить</button></div>
    </div>
  </form></div>`;
}

function bindEquipmentGroupsForm() {
  const form = document.querySelector("[data-equipment-groups-form]");
  if (!form) return;
  form.querySelector("[data-add-equipment-group]").addEventListener("click", () => {
    const fields = form.querySelector("[data-group-fields]");
    fields.insertAdjacentHTML("beforeend", renderEquipmentGroupField(createId("group")));
    fields.lastElementChild.querySelector('[name="groupLabel"]').focus();
  });
  form.addEventListener("input", () => { form.querySelector("[data-groups-error]").hidden = true; });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const ids = data.getAll("groupId");
    const labels = data.getAll("groupLabel").map((label) => String(label).trim().replace(/\s+/g, " "));
    const uniqueLabels = new Set(labels.map((label) => label.toLocaleLowerCase("ru")));
    if (labels.some((label) => !label) || uniqueLabels.size !== labels.length) {
      const error = form.querySelector("[data-groups-error]");
      error.textContent = "Названия разделов должны быть заполнены и не повторяться.";
      error.hidden = false;
      return;
    }
    state.equipmentGroups = Object.fromEntries(ids.map((id, index) => [id, labels[index]]));
    equipmentGroups = state.equipmentGroups;
    persist();
    ui.modal = null;
    render();
  });
}

function bindWorkEvents() {
  document.querySelector("[data-manage-equipment-groups]")?.addEventListener("click", () => {
    ui.modal = { type: "equipmentGroups" };
    render();
  });
  document.querySelectorAll("[data-equipment-group]").forEach((button) => {
    button.addEventListener("click", () => {
      if (ui.equipmentGroup === button.dataset.equipmentGroup) return;
      ui.equipmentGroup = button.dataset.equipmentGroup;
      ui.equipmentSearch = "";
      ui.equipmentCondition = "";
      render();
      app.querySelector(".main").scrollTop = 0;
      saveUiState();
      document.querySelector(`[data-equipment-group="${ui.equipmentGroup}"]`).focus({ preventScroll: true });
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const groups = Object.keys(equipmentGroups);
      const index = groups.indexOf(button.dataset.equipmentGroup);
      const next = event.key === "Home" ? 0 : event.key === "End" ? groups.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + groups.length) % groups.length;
      document.querySelector(`[data-equipment-group="${groups[next]}"]`).click();
    });
  });
  document.querySelector("[data-add-equipment]")?.addEventListener("click", () => {
    ui.modal = { type: "equipmentForm" };
    render();
  });
  document.querySelector("[data-equipment-search]")?.addEventListener("input", (event) => {
    ui.equipmentSearch = event.target.value;
    document.querySelector("[data-equipment-results]").innerHTML = renderEquipmentResults();
    saveUiState();
  });
  document.querySelector("[data-equipment-condition]")?.addEventListener("change", (event) => {
    ui.equipmentCondition = event.target.value;
    document.querySelector("[data-equipment-results]").innerHTML = renderEquipmentResults();
    saveUiState();
  });
  document.querySelector("[data-equipment-sort]")?.addEventListener("change", (event) => {
    ui.equipmentSort = event.target.value;
    document.querySelector("[data-equipment-results]").innerHTML = renderEquipmentResults();
    saveUiState();
  });
  document.querySelector("[data-equipment-results]")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-edit-equipment]");
    if (!button) return;
    ui.modal = { type: "equipmentForm", equipmentId: button.dataset.editEquipment };
    render();
  });
}

function saveEquipmentFromForm(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const values = Object.fromEntries(["name", "group", "category", "unit", "notes"].map((key) => [key, String(form.get(key) || "").trim()]));
  const locations = form.getAll("instanceLocation");
  const conditions = form.getAll("instanceCondition");
  const instances = form.getAll("instanceNumber").map((inventoryNumber, index) => ({
    inventoryNumber: String(inventoryNumber || "").trim(),
    location: String(locations[index] || "").trim(),
    condition: String(conditions[index] || "")
  }));
  const quantity = instances.length;
  if (!values.name || !values.unit || !Object.hasOwn(equipmentGroups, values.group) || !Number.isSafeInteger(quantity) || quantity < 1 || instances.some((instance) => !Object.hasOwn(equipmentConditions, instance.condition))) {
    const error = event.currentTarget.querySelector("[data-equipment-error]");
    error.textContent = "Укажите название, единицу учёта и добавьте хотя бы один экземпляр с выбранным состоянием.";
    error.hidden = false;
    return;
  }
  const existing = state.equipment.find((item) => item.id === ui.modal.equipmentId);
  const now = new Date().toISOString();
  if (existing) {
    Object.assign(existing, values, { instances, quantity, updatedAt: now });
    delete existing.inventoryNumber;
    delete existing.location;
    delete existing.condition;
  } else state.equipment.push({ id: createId("equipment"), ...values, instances, quantity, createdAt: now, updatedAt: now });
  if (ui.equipmentGroup !== values.group) {
    ui.equipmentGroup = values.group;
    ui.equipmentSearch = "";
    ui.equipmentCondition = "";
  }
  persist();
  ui.modal = null;
  render();
}

function deleteEquipment(id) {
  const item = state.equipment.find((entry) => entry.id === id);
  if (!item || !window.confirm(`Удалить «${item.name}» из базы ПТВ?`)) return;
  state.equipment = state.equipment.filter((entry) => entry.id !== id);
  persist();
  ui.modal = null;
  render();
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
                : absence ? absenceStatusLabel(absence) : "";
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
  const choosingVacation = ui.sheet.choosingVacation;
  return `
    <div class="sheet-backdrop" data-close-sheet>
      <section class="sheet" data-stop>
        <div class="sheet-head">
          <div>
            <h2>${choosingVacation ? "Вид отпуска" : "Статус"}: ${escapeHtml(employee.shortName)}</h2>
            <div class="muted small">${formatLongDate(ui.selectedDate)}</div>
          </div>
          <button class="icon-btn" data-close-sheet type="button">×</button>
        </div>
        <div class="sheet-body">
          ${choosingVacation ? `<button class="ghost-btn vacation-back" data-back-to-status type="button">← Все статусы</button>` : ""}
          <div class="status-grid">
            ${choosingVacation
              ? Object.entries(vacationLabels).map(([key, label]) => `<button class="status-btn ${active?.absenceType === "VACATION" && active.vacationType === key ? "active" : ""}" data-set-vacation="${key}" aria-pressed="${active?.absenceType === "VACATION" && active.vacationType === key}" type="button">${label}</button>`).join("")
              : Object.entries(absenceLabels).map(([key, label]) => `<button class="status-btn ${active?.absenceType === key ? "active" : ""}" data-set-status="${key}" type="button">${label}${key === "VACATION" ? " ›" : ""}</button>`).join("")}
          </div>
          <div class="actions status-actions">
            <button class="danger-btn" data-clear-status type="button">Очистить статус</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderModal() {
  if (ui.modal.type === "equipmentGroups") return renderEquipmentGroupsModal();
  if (ui.modal.type === "equipmentForm") return renderEquipmentFormModal();
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

function renderVacationRangeCalendar({ month: value, from, to }) {
  const monthDate = parseIsoDate(value);
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const leading = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const today = isoDate(new Date());
  return `
    <div class="calendar-nav">
      <button class="icon-btn" data-vacation-month="-1" type="button" aria-label="Предыдущий месяц">‹</button>
      <strong aria-live="polite">${monthNames[month]} ${year}</strong>
      <button class="icon-btn" data-vacation-month="1" type="button" aria-label="Следующий месяц">›</button>
    </div>
    <div class="calendar-weekdays">${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => `<span>${day}</span>`).join("")}</div>
    <div class="calendar-grid">
      ${'<span class="calendar-empty"></span>'.repeat(leading)}
      ${Array.from({ length: days }, (_, index) => {
        const date = isoDate(new Date(year, month, index + 1));
        const edge = date === from || date === to;
        return `<button class="calendar-day ${date === today ? "today" : ""} ${edge ? "selected" : ""} ${from && to && date > from && date < to ? "in-range" : ""}" data-vacation-day="${date}" aria-label="${formatLongDate(date)}" aria-pressed="${edge || Boolean(from && to && date > from && date < to)}" type="button">${index + 1}</button>`;
      }).join("")}
    </div>
    <p class="muted small" aria-live="polite">${from && !to ? `Начало: ${formatShortDate(from)}. Выберите окончание отпуска.` : "Выберите начало и окончание отпуска."}</p>
    <div class="actions">
      <button class="ghost-btn" data-vacation-cancel type="button">Отмена</button>
      <button class="danger-btn" data-vacation-clear type="button">Очистить даты</button>
    </div>
  `;
}

function renderVacationPeriodFields(period = {}) {
  const calendarId = createId("vacation-calendar");
  return `
    <div class="vacation-period-fields" data-vacation-period role="group" aria-label="Период отпуска">
      <input type="hidden" name="vacationDateFrom" value="${escapeAttr(period.dateFrom || "")}" />
      <input type="hidden" name="vacationDateTo" value="${escapeAttr(period.dateTo || "")}" />
      <div class="vacation-period-actions">
        <button class="field vacation-range-trigger" data-vacation-range type="button" aria-expanded="false" aria-controls="${calendarId}">${period.dateFrom && period.dateTo ? `${formatShortDate(period.dateFrom)} — ${formatShortDate(period.dateTo)}` : "Выбрать даты отпуска"}</button>
        <button class="icon-btn" data-remove-vacation type="button" aria-label="Удалить отпуск">×</button>
      </div>
      <div id="${calendarId}" class="vacation-range-calendar" role="group" aria-label="Диапазон отпуска" hidden></div>
    </div>
  `;
}

function bindVacationPeriods() {
  const list = document.querySelector("[data-vacation-periods]");
  if (!list) return;
  list.querySelectorAll("[data-vacation-period]").forEach(bindVacationRangePicker);
  document.querySelector("[data-add-vacation]").addEventListener("click", () => {
    list.insertAdjacentHTML("beforeend", renderVacationPeriodFields());
    bindVacationRangePicker(list.lastElementChild);
    list.lastElementChild.querySelector("[data-vacation-range]").click();
  });
}

function bindVacationRangePicker(root) {
  const trigger = root.querySelector("[data-vacation-range]");
  const calendar = root.querySelector(".vacation-range-calendar");
  const fromInput = root.querySelector('[name="vacationDateFrom"]');
  const toInput = root.querySelector('[name="vacationDateTo"]');
  let draft;
  root.querySelector("[data-remove-vacation]").addEventListener("click", () => {
    root.remove();
    document.querySelector("[data-vacation-error]").hidden = true;
    document.querySelector("[data-add-vacation]").focus({ preventScroll: true });
  });
  const close = () => {
    calendar.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus({ preventScroll: true });
  };
  const commit = (from, to) => {
    fromInput.value = from;
    toInput.value = to;
    trigger.textContent = from && to ? `${formatShortDate(from)} — ${formatShortDate(to)}` : "Выбрать даты отпуска";
    document.querySelector("[data-vacation-error]").hidden = true;
    close();
  };
  trigger.addEventListener("click", () => {
    if (!calendar.hidden) return close();
    draft = { month: fromInput.value || ui.selectedDate, from: fromInput.value, to: toInput.value };
    calendar.innerHTML = renderVacationRangeCalendar(draft);
    calendar.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  });
  calendar.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  calendar.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-vacation-cancel")) return close();
    if (button.hasAttribute("data-vacation-clear")) return commit("", "");
    if (button.dataset.vacationMonth) {
      const current = parseIsoDate(draft.month);
      draft.month = isoDate(new Date(current.getFullYear(), current.getMonth() + Number(button.dataset.vacationMonth), 1));
    } else if (button.dataset.vacationDay) {
      const date = button.dataset.vacationDay;
      if (draft.from && !draft.to) return commit(draft.from < date ? draft.from : date, draft.from < date ? date : draft.from);
      draft.from = date;
      draft.to = "";
    } else return;
    calendar.innerHTML = renderVacationRangeCalendar(draft);
    const selector = button.dataset.vacationMonth
      ? `[data-vacation-month="${button.dataset.vacationMonth}"]`
      : `[data-vacation-day="${button.dataset.vacationDay}"]`;
    calendar.querySelector(selector)?.focus({ preventScroll: true });
  });
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
          <fieldset class="vacation-dates">
            <legend>Отпуска</legend>
            <div class="vacation-periods" data-vacation-periods>${employeeVacationPeriods(data).map(renderVacationPeriodFields).join("")}</div>
            <button class="ghost-btn" data-add-vacation type="button">+ Добавить отпуск</button>
            <p class="muted small">Добавьте периоды отпуска. При статусе «Отпуск» в PNG отображается период, в который попадает дата раскладки.</p>
            <p class="form-error small" data-vacation-error role="alert" hidden></p>
          </fieldset>
          <div class="field-group"><label>Комментарий</label><textarea class="field" name="comment">${escapeHtml(data.comment || "")}</textarea></div>
          <div class="actions">
            <button class="btn" type="submit">Сохранить</button>
            ${employee ? `<button class="danger-btn" data-delete-employee="${employee.id}" type="button">Удалить</button>` : ""}
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
  bindWorkEvents();
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
  document.querySelector("[data-roster-comment]")?.addEventListener("input", (event) => {
    updateRosterComment(event.target.value);
  });
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
    if (button.dataset.setStatus === "VACATION") {
      ui.sheet.choosingVacation = true;
      render();
      return;
    }
    setAbsenceStatus(button.dataset.setStatus);
  }));
  document.querySelectorAll("[data-set-vacation]").forEach((button) => button.addEventListener("click", () => {
    setAbsenceStatus("VACATION", button.dataset.setVacation);
  }));
  document.querySelector("[data-back-to-status]")?.addEventListener("click", () => {
    ui.sheet.choosingVacation = false;
    render();
  });
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
  document.querySelector("[data-equipment-form]")?.addEventListener("submit", saveEquipmentFromForm);
  bindEquipmentInstances();
  bindEquipmentGroupsForm();
  document.querySelector("[data-delete-equipment]")?.addEventListener("click", (event) => deleteEquipment(event.currentTarget.dataset.deleteEquipment));
  bindVacationPeriods();
  document.querySelector("[data-delete-employee]")?.addEventListener("click", (event) => {
    deleteEmployee(event.currentTarget.dataset.deleteEmployee);
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

function setAbsenceStatus(absenceType, vacationType) {
  if (absenceType === "VACATION" && !Object.hasOwn(vacationLabels, vacationType)) return;
  const employeeId = ui.sheet.employeeId;
  const active = getAbsenceForDate(employeeId, ui.selectedDate);

  if (active) {
    active.absenceType = absenceType;
    if (absenceType === "VACATION") active.vacationType = vacationType;
    else delete active.vacationType;
    active.dateFrom = ui.selectedDate;
    active.dateTo = ui.selectedDate;
    active.updatedAt = new Date().toISOString();
  } else {
    state.absences.push({
      id: createId("absence"),
      employeeId,
      absenceType,
      ...(absenceType === "VACATION" ? { vacationType } : {}),
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
  const before = JSON.stringify({ blocks: roster.blocks, comment: roster.comment });
  mutator(roster);
  normalizeRoster(roster);
  const after = JSON.stringify({ blocks: roster.blocks, comment: roster.comment });
  if (before !== after) {
    roster.updatedAt = new Date().toISOString();
  }
  persist();
}

function updateRosterComment(value) {
  const roster = getRoster();
  const comment = String(value || "").slice(0, 240);
  if (roster.comment === comment) return;
  roster.comment = comment;
  roster.updatedAt = new Date().toISOString();
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

function deleteEmployee(employeeId) {
  const employee = findEmployee(employeeId);
  if (!employee) return;
  if (!window.confirm(`Удалить сотрудника «${employee.shortName}» из приложения?`)) return;

  state.employees = state.employees.filter((item) => item.id !== employeeId);
  state.absences = state.absences.filter((absence) => absence.employeeId !== employeeId);
  Object.values(state.rosters || {}).forEach((roster) => {
    normalizeRoster(roster);
    roster.blocks.forEach((block) => {
      block.members = block.members.filter((memberId) => memberId !== employeeId);
    });
    roster.updatedAt = new Date().toISOString();
  });
  persist();
  ui.modal = null;
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
    return employee ? { name: employee.shortName, position: employee.position || "", additionalProfession: employee.additionalProfession || "", lastName: employee.lastName || "" } : null;
  };
  normalizeRoster(roster);
  const assignedEmployeeIds = new Set(allAssignments(roster).map((item) => item.employeeId));
  const absent = state.employees
    .filter((employee) => employee.isActive)
    .filter((employee) => !assignedEmployeeIds.has(employee.id))
    .map((employee) => ({ employee, absence: getAbsenceForDate(employee.id, roster.date) }))
    .filter((item) => item.absence)
    .sort(compareAbsenceItems)
    .map((item) => ({
      name: item.employee.shortName,
      position: item.employee.position || "",
      lastName: item.employee.lastName || "",
      status: absenceStatusLabel(item.absence),
      vacationPeriod: item.absence.absenceType === "VACATION" ? vacationPeriodText(item.employee, roster.date) : "",
      absenceType: item.absence.absenceType
    }));
  return {
    title: state.appTitle,
    date: roster.date,
    dateText: formatLongDate(roster.date),
    comment: roster.comment || "",
    blocks: roster.blocks
      .map((block) => ({
        title: blockTitleForDate(block.title, roster.date),
        people: block.members.map(personData).filter(Boolean).sort(comparePeopleForRosterCard)
      }))
      .filter((block) => block.people.length),
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
  const sections = data.blocks.filter((block) => block.people?.length).map((block, index) => ({
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
        item.position || "",
        item.vacationPeriod || ""
      ])
    });
  }
  const comment = String(data.comment || "").trim();
  if (comment) {
    sections.push({
      type: "comment",
      title: "КОММЕНТАРИЙ",
      color: "#ffd36e",
      text: comment
    });
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  const measureCtx = canvas.getContext("2d");
  const contentX = 96;
  const contentRight = 1504;
  const columnGap = 30;
  const columnWidth = (contentRight - contentX - columnGap) / 2;
  const titleWidth = contentRight - contentX - 360;
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
    } else if (section.type === "comment") {
      drawCommentSection(ctx, section.title, section.text, sectionX, sectionY, section.color, width);
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
  if (section.type === "comment") {
    ctx.font = "700 32px Arial, sans-serif";
    const lines = wrapCanvasLines(ctx, section.text || "", width - 28);
    return headerHeight + lines.length * 42 + 52;
  }
  return headerHeight + section.rows.reduce((sum, [label, value, position, vacationPeriod]) => {
    ctx.font = "800 34px Arial, sans-serif";
    const labelLines = wrapCanvasLines(ctx, position ? `${label} (${position})` : label, width - 330);
    ctx.font = "800 34px Arial, sans-serif";
    const valueLines = wrapCanvasLines(ctx, value || "Не назначено", 300);
    return sum + Math.max(labelLines.length * 42, valueLines.length * 42) + (vacationPeriod ? 34 : 0) + 30;
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
  rows.forEach(([label, value, position, vacationPeriod]) => {
    ctx.fillStyle = "#fff8ef";
    ctx.font = "800 34px Arial, sans-serif";
    const labelLines = wrapCanvasLines(ctx, position ? `${label} (${position})` : label, width - 330);
    labelLines.forEach((line, index) => ctx.fillText(line, x, y + index * 42));
    let rowHeight = labelLines.length * 42;
    ctx.fillStyle = "#dff6ff";
    ctx.font = "800 34px Arial, sans-serif";
    ctx.textAlign = "right";
    const valueLines = wrapCanvasLines(ctx, value || "Не назначено", 300);
    valueLines.forEach((line, index) => ctx.fillText(line, x + width, y + index * 42));
    ctx.textAlign = "left";
    rowHeight = Math.max(rowHeight, valueLines.length * 42);
    if (vacationPeriod) {
      ctx.font = "650 24px Arial, sans-serif";
      ctx.fillText(vacationPeriod, x, y + rowHeight + 4);
      rowHeight += 34;
    }
    y += rowHeight + 30;
  });
  return y + 34;
}

function drawCommentSection(ctx, title, text, x, y, color, width = 908) {
  const top = y;
  const height = measureCanvasSection(ctx, { type: "comment", title, text }, width);
  drawCanvasPanel(ctx, x, top, width, height);
  y = drawSectionHeader(ctx, title, x, y, color, width);
  ctx.fillStyle = "#fff8ef";
  ctx.font = "700 32px Arial, sans-serif";
  wrapCanvasLines(ctx, text || "", width - 28).forEach((line, index) => {
    ctx.fillText(line, x, y + index * 42);
  });
  return top + height;
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

function measureCanvasText(ctx, text, font) {
  const previousFont = ctx.font;
  ctx.font = font;
  const width = ctx.measureText(text).width;
  ctx.font = previousFont;
  return width;
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
  const vacationEnds = form.getAll("vacationDateTo");
  const vacationPeriods = form.getAll("vacationDateFrom")
    .map((dateFrom, index) => ({ dateFrom: String(dateFrom), dateTo: String(vacationEnds[index] || "") }))
    .filter((period) => period.dateFrom || period.dateTo)
    .sort((a, b) => a.dateFrom.localeCompare(b.dateFrom));
  const vacationError = event.currentTarget.querySelector("[data-vacation-error]");
  const error = vacationPeriods.some((period) => !period.dateFrom || !period.dateTo || period.dateFrom > period.dateTo)
    ? "Выберите начало и окончание каждого отпуска."
    : vacationPeriods.some((period, index) => index > 0 && period.dateFrom <= vacationPeriods[index - 1].dateTo)
      ? "Периоды отпусков не должны пересекаться. Проверьте выбранные даты."
      : "";
  vacationError.textContent = error;
  vacationError.hidden = !error;
  if (error) return;
  const employee = ui.modal.employeeId ? findEmployee(ui.modal.employeeId) : { id: createId("employee"), createdAt: new Date().toISOString() };
  employee.lastName = String(form.get("lastName") || "").trim();
  employee.firstName = String(form.get("firstName") || "").trim();
  employee.middleName = String(form.get("middleName") || "").trim();
  employee.position = String(form.get("position") || "").trim();
  employee.additionalProfession = String(form.get("additionalProfession") || "").trim();
  employee.vacationPeriods = vacationPeriods;
  delete employee.vacationDateFrom;
  delete employee.vacationDateTo;
  employee.shortName = makeShortName(employee.lastName, employee.firstName, employee.middleName);
  employee.isActive = true;
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

function assignmentTitle(assignmentType) {
  const block = getRoster().blocks.find((item) => item.id === assignmentType);
  return block ? blockTitleForDate(block.title, ui.selectedDate) : "Блок";
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

function normalizeBlockTitle(title) {
  return isReserveDriverTitle(title) ? "Резервный водитель" : title;
}

function blockTitleForDate(title, date) {
  return isReserveDriverTitle(title) ? reserveDriverLabel(date) : title;
}

function isReserveDriverTitle(title) {
  return /^резервн(?:ый|ого)?\s+водител/i.test(String(title || "").trim());
}

function isDriverPosition(position) {
  return String(position || "").toLowerCase().includes("водител");
}

function comparePeopleForRosterCard(a, b) {
  const rtpDiff = Number(hasRtpProfession(b.additionalProfession)) - Number(hasRtpProfession(a.additionalProfession));
  if (rtpDiff) return rtpDiff;
  const driverDiff = Number(isDriverPosition(a.position)) - Number(isDriverPosition(b.position));
  if (driverDiff) return driverDiff;
  return String(a.lastName || a.name || "").localeCompare(String(b.lastName || b.name || ""), "ru");
}

function hasRtpProfession(profession) {
  return /(^|[^\p{L}\p{N}])ртп(?=$|[^\p{L}\p{N}])/iu.test(String(profession || ""));
}

function compareEmployeesByName(a, b) {
  return String(a.lastName || a.shortName || "").localeCompare(String(b.lastName || b.shortName || ""), "ru");
}

function compareEmployeesForDirectory(a, b) {
  const positionDiff = employeePositionSortOrder[employeePositionGroup(a)] - employeePositionSortOrder[employeePositionGroup(b)];
  if (positionDiff) return positionDiff;
  return compareEmployeesByName(a, b);
}

function employeePositionGroup(employee) {
  const position = normalizePositionText(employee.position);
  if (position.includes("рдс")) return "rds";
  if (position.includes("пнк")) return "pnk";
  if (position === "ко" || position.includes("командир отделения")) return "ko";
  if (position.includes("пожарн")) return "firefighter";
  if (isDriverPosition(position)) return "driver";
  return "other";
}

function normalizePositionText(value) {
  return String(value || "").toLowerCase().replaceAll(".", "").replace(/\s+/g, " ").trim();
}

function compareAbsenceItems(a, b) {
  const orderA = absenceSortOrder[a.absence.absenceType] ?? 2;
  const orderB = absenceSortOrder[b.absence.absenceType] ?? 2;
  if (orderA !== orderB) return orderA - orderB;
  return compareEmployeesByName(a.employee, b.employee);
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
  if (absence.dateFrom === absence.dateTo) return `${absenceStatusLabel(absence)} на день`;
  return `${absenceStatusLabel(absence)} до ${formatShortDate(absence.dateTo)}`;
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

app.addEventListener("scroll", (event) => {
  if (!event.target.classList?.contains("main")) return;
  window.clearTimeout(uiScrollTimer);
  uiScrollTimer = window.setTimeout(saveUiState, 100);
}, true);
window.addEventListener("beforeunload", () => {
  saveUiState();
  persist();
});
window.addEventListener("pagehide", saveUiState);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveUiState();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

normalizeStatsDates();
render();
loadStateFromServer();
