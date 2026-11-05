// Older requests could split a Russian letter into replacement characters.
// Recover only the known reserve heading; do not guess arbitrary saved text.
export function isReserveDriverTitle(title) {
  const text = String(title || "").trim();
  if (/^резервн(?:ый|ого)?\s+водител[ья](?=$|[^\p{L}\p{N}])/iu.test(text)) return true;
  const words = text.toLocaleLowerCase("ru").split(/\s+/).slice(0, 2);
  if (words.length !== 2 || !words.some((word) => word.includes("\uFFFD"))) return false;
  const matches = (damaged, candidates) => {
    if (!/^[а-яё\uFFFD]+$/u.test(damaged)) return false;
    // Require four intact letters per word to avoid guessing unrelated block names.
    if (damaged.replace(/\uFFFD/g, "").length < 4) return false;
    const pattern = damaged.replace(/\uFFFD+/g, (run) => `[а-яё]{1,${run.length}}`);
    return candidates.some((word) => new RegExp(`^${pattern}$`, "u").test(word));
  };
  return matches(words[0], ["резервный", "резервного"])
    && matches(words[1], ["водитель", "водителя"]);
}

export function previousFilledRoster(rosters, targetDate) {
  return Object.values(rosters || {})
    .filter((roster) => roster?.date < targetDate && Array.isArray(roster.blocks)
      && roster.blocks.some((block) => !isReserveDriverTitle(block.title) && Array.isArray(block.members) && block.members.some(Boolean)))
    .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
}

export function copyRosterBlocks(source, employees, absences, targetDate, makeId) {
  const active = new Set(employees.filter((person) => person.isActive !== false).map((person) => person.id));
  const absent = new Set(absences.filter((item) => item.dateFrom <= targetDate && item.dateTo >= targetDate).map((item) => item.employeeId));
  return source.blocks.map((block) => ({
    id: makeId(), title: isReserveDriverTitle(block.title) ? "Резервный водитель" : block.title,
    members: isReserveDriverTitle(block.title) ? [] : (block.members || []).filter((id) => active.has(id) && !absent.has(id) && !source.substitutions?.[id])
  }));
}

export function isScheduleDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function scheduleEnabled(schedule) {
  return schedule?.enabled === true && isScheduleDate(schedule.anchorDate);
}

export function isDutyDate(date, schedule) {
  if (!scheduleEnabled(schedule)) return true;
  return ((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${schedule.anchorDate}T00:00:00Z`)) / 86400000) % 4 === 0;
}

export function nearestDutyDate(date, schedule, direction = 1) {
  if (!scheduleEnabled(schedule)) return date;
  const time = Date.parse(`${date}T00:00:00Z`);
  const days = (time - Date.parse(`${schedule.anchorDate}T00:00:00Z`)) / 86400000;
  const remainder = ((days % 4) + 4) % 4;
  const offset = remainder === 0 ? 0 : direction < 0 ? -remainder : 4 - remainder;
  return new Date(time + offset * 86400000).toISOString().slice(0, 10);
}
