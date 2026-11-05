import test from "node:test";
import assert from "node:assert/strict";
import { achievementPoints, defaultAchievementRules, validAchievement, validAchievementRules, achievementStandings, achievementCategoryList, validAchievementCategories } from "../public/achievements.js";
import { mergeSharedState } from "../public/state-sync.js";

const event = (id, date, points, participants, type = "competition") => ({ id, date, points, title: "Соревнования", comment: "", type, participants: participants.map((employeeId) => ({ employeeId, name: employeeId })) });

test("points are awarded per participant, filtered by year/type, with equal places for tied totals", () => {
  const employees = ["a", "b", "c"].map((id) => ({ id, shortName: id, isActive: true }));
  const entries = [event("shared", "2026-05-01", 5, ["a", "b"]), event("work", "2026-06-01", 1, ["b"], "work"), event("previous", "2025-12-31", 100, ["c"]), event("tie", "2026-07-01", 6, ["c"])];
  const rows = achievementStandings(entries, employees, 2026);
  assert.deepEqual(rows.map((row) => [row.id, row.points, row.rank]), [["b", 6, 1], ["c", 6, 1], ["a", 5, 3]]);
  assert.equal(rows[0].entries.length, 2);
  assert.deepEqual(achievementStandings(entries, employees, 2026, "work").map((row) => row.points), [1, 0, 0]);
  assert.equal(achievementStandings(entries, employees, 2025)[0].id, "c");
});

test("old awards retain their points after changing rules, with archived names preserved", () => {
  const entry = event("old", "2026-05-01", 3, ["deleted"]);
  const rules = { ...defaultAchievementRules, competition: 10 };
  assert.equal(achievementPoints("competition", true, rules), 12);
  const row = achievementStandings([entry], [], 2026)[0];
  assert.equal(row.name, "deleted"); assert.equal(row.points, 3); assert.equal(row.active, false);
  assert.equal(achievementPoints("work", true), 1);
});

test("invalid dates, duplicate participants, fractional points and unexplained special awards are rejected", () => {
  const base = event("ok", "2026-05-01", 3, ["a"]);
  assert.equal(validAchievement(base), true);
  for (const entry of [{ ...base, date: "2026-02-31" }, { ...base, participants: [] }, { ...base, participants: [...base.participants, ...base.participants] }, { ...base, points: -1 }, { ...base, points: 1.5 }, { ...base, type: "special" }, { ...base, title: " " }]) assert.equal(Boolean(validAchievement(entry)), false);
  assert.equal(validAchievement({ ...base, type: "special", comment: "Работа вне смены" }), true);
  assert.equal(Boolean(validAchievementRules({ ...defaultAchievementRules, prize: -1 })), false);
});

test("independent achievement entries merge; editing the same entry requires a choice", () => {
  const base = { achievements: [event("same", "2026-05-01", 3, ["a"])] };
  const local = structuredClone(base), remote = structuredClone(base);
  local.achievements.push(event("one", "2026-06-01", 1, ["a"], "work"));
  remote.achievements.push(event("two", "2026-06-02", 1, ["a"], "work"));
  assert.equal(mergeSharedState(base, local, remote).state.achievements.length, 3);
  local.achievements[0].points = 5; remote.achievements[0].points = 8;
  assert.equal(mergeSharedState(base, local, remote).conflicts.length, 1);
});

test("custom kinds use their own points and legacy rules migrate without changing awards", () => {
  const legacy = achievementCategoryList({ achievementRules: { competition: 9, prize: 4, work: 2, special: 3 } });
  assert.equal(legacy.find((item) => item.id === "competition").points, 9);
  assert.equal(legacy.find((item) => item.id === "competition").prizeBonus, 4);
  const custom = { id: "outreach", name: "Профилактика", points: 4, prizeBonus: 2, requireComment: true, archived: false };
  const categories = [...legacy, custom];
  assert.equal(validAchievementCategories(categories), true);
  assert.equal(achievementPoints("outreach", true, {}, categories), 6);
  const entry = { ...event("custom", "2026-11-05", 6, ["a"], "outreach"), comment: "Работа с детьми", commentRequired: true, typeName: custom.name };
  assert.equal(validAchievement(entry), true);
  const archived = categories.map((item) => item.id === "outreach" ? { ...item, name: "Занятия", points: 9, archived: true } : item);
  assert.equal(validAchievementCategories(archived), true);
  assert.equal(achievementStandings([entry], [], 2026)[0].points, 6);
  assert.equal(entry.typeName, "Профилактика");
  assert.equal(validAchievementCategories([...categories, { ...custom, id: "duplicate", name: " ПРОФИЛАКТИКА " }]), false);
  assert.equal(validAchievementCategories(categories.map((item) => ({ ...item, archived: true }))), false);
});
