// Merge independent records, but never silently merge two edits of the same record.
export function sameState(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameState(value, b[index]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && (key === "equipmentGroups"
    ? sameState(Object.entries(a[key] || {}), Object.entries(b[key] || {})) : sameState(a[key], b[key])));
}

const collections = new Set(["equipment", "employees", "absences", "equipmentLocations", "rosterCommentTemplates"]);
const labels = { equipment: "Оборудование", employees: "Сотрудник", absences: "Отсутствие", equipmentLocations: "Место хранения", rosterCommentTemplates: "Шаблон", rosters: "Раскладка", equipmentGroups: "Разделы оборудования", appTitle: "Название караула", templateBlocks: "Блоки раскладки" };

export function mergeSharedState(base = {}, local = {}, remote = {}, choices = {}) {
  base ||= {}; local ||= {}; remote ||= {};
  const conflicts = [];
  const choose = (before, mine, theirs, path) => {
    const key = JSON.stringify(path);
    if (choices[key] === "local") return mine;
    if (choices[key] === "remote") return theirs;
    if (sameState(mine, before)) return theirs;
    if (sameState(theirs, before) || sameState(mine, theirs)) return mine;
    const value = mine || theirs || before;
    conflicts.push({ key, path, label: `${labels[path[0]] || "Запись"}${path.length > 1 ? `: ${path[1] === "$order" ? "порядок записей" : value?.name || value?.shortName || value?.text || path[1]}` : ""}`, base: before, local: mine, remote: theirs });
    return mine;
  };
  const result = {};
  for (const field of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const b = base[field], l = local[field], r = remote[field];
    let value;
    const fieldChoice = choices[JSON.stringify([field])];
    if (fieldChoice === "local" || fieldChoice === "remote") value = fieldChoice === "local" ? l : r;
    else if (collections.has(field) && [b, l, r].every((items) => items === undefined || (Array.isArray(items) && items.every((item) => item && typeof item.id === "string") && new Set(items.map((item) => item.id)).size === items.length))) {
      const arrays = [b || [], l || [], r || []];
      const maps = arrays.map((items) => new Map(items.map((item) => [item.id, item])));
      const byId = new Map();
      for (const id of new Set(arrays.flatMap((items) => items.map((item) => item.id)))) {
        const entry = choose(maps[0].get(id), maps[1].get(id), maps[2].get(id), [field, id]);
        if (entry !== undefined) byId.set(id, entry);
      }
      const common = arrays[0].map((item) => item.id).filter((id) => maps[1].has(id) && maps[2].has(id));
      const orders = arrays.map((items) => items.map((item) => item.id).filter((id) => common.includes(id)));
      const order = choose(orders[0], orders[1], orders[2], [field, "$order"]) || [];
      const ids = [...new Set([...order, ...arrays[2].map((item) => item.id), ...arrays[1].map((item) => item.id)])];
      value = ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
    } else if (field === "rosters" && [b, l, r].every((items) => items === undefined || (items && typeof items === "object" && !Array.isArray(items)))) {
      value = {};
      for (const date of new Set([...Object.keys(b || {}), ...Object.keys(l || {}), ...Object.keys(r || {})])) {
        const entry = choose(b?.[date], l?.[date], r?.[date], [field, date]);
        if (entry !== undefined) Object.defineProperty(value, date, { value: entry, enumerable: true, configurable: true, writable: true });
      }
    } else if (field === "equipmentGroups") {
      const entries = choose(b === undefined ? undefined : Object.entries(b), l === undefined ? undefined : Object.entries(l), r === undefined ? undefined : Object.entries(r), [field]);
      value = entries === undefined ? undefined : Object.fromEntries(entries);
    } else value = choose(b, l, r, [field]);
    if (value !== undefined) Object.defineProperty(result, field, { value, enumerable: true, configurable: true, writable: true });
  }
  return { state: result, conflicts };
}
