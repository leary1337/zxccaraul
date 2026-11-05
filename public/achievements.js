import { isScheduleDate } from "./roster-history.js";

export const achievementTypes = { competition: "Соревнования", work: "Дополнительные работы", special: "Особый вклад" };
export const defaultAchievementRules = Object.freeze({ competition: 3, prize: 2, work: 1, special: 1 });

export function achievementCategoryList(state = {}) {
  if (Array.isArray(state.achievementCategories)) return state.achievementCategories;
  const rules = { ...defaultAchievementRules, ...state.achievementRules };
  return Object.entries(achievementTypes).map(([id, name]) => ({ id, name, points: rules[id], prizeBonus: id === "competition" ? rules.prize : 0, requireComment: id === "special", archived: false }));
}

export function validAchievementCategories(categories) {
  return Array.isArray(categories) && categories.length > 0 && categories.length <= 100
    && categories.some((category) => !category.archived)
    && categories.every((category) => category && typeof category.id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(category.id) && !["__proto__", "constructor", "prototype"].includes(category.id)
      && typeof category.name === "string" && category.name.trim().length > 0 && category.name.length <= 80
      && Number.isInteger(category.points) && category.points >= 0 && category.points <= 1000
      && Number.isInteger(category.prizeBonus) && category.prizeBonus >= 0 && category.prizeBonus <= 1000
      && typeof category.requireComment === "boolean" && typeof category.archived === "boolean")
    && new Set(categories.map((category) => category.id)).size === categories.length
    && new Set(categories.map((category) => category.name.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru"))).size === categories.length;
}

export function achievementPoints(type, prize, rules = {}, categories = null) {
  if (Array.isArray(categories)) {
    const category = categories.find((item) => item.id === type);
    return category ? category.points + (prize ? category.prizeBonus : 0) : 0;
  }
  const values = { ...defaultAchievementRules, ...rules };
  return (values[type] || 0) + (type === "competition" && prize ? values.prize : 0);
}

export function validAchievementRules(rules) {
  return rules && typeof rules === "object" && !Array.isArray(rules)
    && Object.keys(defaultAchievementRules).every((key) => Number.isInteger(rules[key]) && rules[key] >= 0 && rules[key] <= 1000);
}

export function validAchievement(entry) {
  return entry && typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 160
    && isScheduleDate(entry.date) && typeof entry.type === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(entry.type)
    && typeof entry.title === "string" && entry.title.trim().length > 0 && entry.title.length <= 160
    && (entry.typeName === undefined || (typeof entry.typeName === "string" && entry.typeName.length <= 80))
    && (entry.commentRequired === undefined || typeof entry.commentRequired === "boolean")
    && (entry.prize === undefined || typeof entry.prize === "boolean")
    && Number.isInteger(entry.points) && entry.points >= 0 && entry.points <= 2000
    && typeof entry.comment === "string" && entry.comment.length <= 1000
    && (!(entry.commentRequired === true || (entry.type === "special" && entry.commentRequired !== false)) || entry.comment.trim().length > 0)
    && Array.isArray(entry.participants) && entry.participants.length > 0 && entry.participants.length <= 500
    && entry.participants.every((person) => person && typeof person.employeeId === "string" && person.employeeId.length > 0 && person.employeeId.length <= 160 && typeof person.name === "string" && person.name.trim().length > 0 && person.name.length <= 160)
    && new Set(entry.participants.map((person) => person.employeeId)).size === entry.participants.length;
}

export function achievementStandings(entries, employees, year, type = "") {
  const people = new Map(employees.map((person) => [person.id, { id: person.id, name: person.shortName, points: 0, entries: [], active: person.isActive !== false }]));
  entries.filter((entry) => entry.date.slice(0, 4) === String(year) && (!type || entry.type === type)).forEach((entry) => {
    entry.participants.forEach((person) => {
      if (!people.has(person.employeeId)) people.set(person.employeeId, { id: person.employeeId, name: person.name, points: 0, entries: [], active: false });
      const row = people.get(person.employeeId);
      row.points += entry.points;
      row.entries.push(entry);
    });
  });
  const rows = [...people.values()].filter((row) => row.active || row.entries.length)
    .sort((a, b) => b.points - a.points || Number(b.entries.length > 0) - Number(a.entries.length > 0) || a.name.localeCompare(b.name, "ru"));
  let rank = 0;
  rows.forEach((row, index) => {
    if (!index || rows[index - 1].points !== row.points) rank = index + 1;
    row.rank = row.entries.length ? rank : null;
    row.entries.sort((a, b) => b.date.localeCompare(a.date));
  });
  return rows;
}
