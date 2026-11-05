import test from "node:test";
import assert from "node:assert/strict";
import { isReserveDriverTitle, previousFilledRoster, copyRosterBlocks, isScheduleDate, scheduleEnabled, isDutyDate, nearestDutyDate } from "../public/roster-history.js";

test("reserve history recognizes intact and damaged headings from old saved rosters", () => {
  for (const title of ["Резервный водитель", "Резервного водителя на 17 сентября", "Резервный водит��ль", "��езервный водитель", "Резервный ��одитель", "Резервный водител�", "  РЕЗЕРВНЫЙ   ВОДИТЕЛЬ  "]) {
    assert.equal(isReserveDriverTitle(title), true, title);
  }
});

test("carry-forward picks the closest earlier filled date, not a future or recently edited older roster", () => {
  const make = (date, members = ["driver"]) => ({ date, blocks: [{ title: "АЦ", members }] });
  const rosters = { old: { ...make("2026-10-01"), updatedAt: "2040-01-01" }, recent: make("2026-11-06"), empty: make("2026-11-09", []), reserveOnly: { date: "2026-11-08", blocks: [{ title: "Резервный водитель", members: ["driver"] }] }, future: make("2026-11-14") };
  assert.equal(previousFilledRoster(rosters, "2026-11-10"), rosters.recent);
  assert.equal(previousFilledRoster(rosters, "2026-09-01"), null);
});

test("copied blocks preserve regular staff, respect target absences, and omit one-day guests and reserve", () => {
  const source = { date: "2026-11-06", substitutions: { guest: { name: "Подмена", kind: "substitution", replacedEmployeeId: "away" } }, blocks: [
    { id: "a", title: "АЦ", members: ["ready", "away", "inactive", "deleted", "guest"] },
    { id: "b", title: "Резервный водит��ль", members: ["ready"] }
  ] };
  const before = structuredClone(source);
  let id = 0;
  const blocks = copyRosterBlocks(source, [{ id: "ready", isActive: true }, { id: "away", isActive: true }, { id: "inactive", isActive: false }], [{ employeeId: "away", dateFrom: "2026-11-10", dateTo: "2026-11-12" }], "2026-11-10", () => `copy-${++id}`);
  assert.deepEqual(blocks, [{ id: "copy-1", title: "АЦ", members: ["ready"] }, { id: "copy-2", title: "Резервный водитель", members: [] }]);
  blocks[0].members.length = 0;
  assert.deepEqual(source, before);
});

test("unrelated blocks and heavily damaged names are not inferred as reserve", () => {
  for (const title of ["Водитель АЦ", "Резервный насос", "Резервный водительский состав", "Резервный водит��льский состав", "�������� водитель", "Резервный ��������", "[.*] водитель", "Резервный", "", null]) {
    assert.equal(isReserveDriverTitle(title), false, String(title));
  }
});

test("24-hour duty every fourth day works before the anchor and across month/year boundaries", () => {
  const schedule = { enabled: true, anchorDate: "2026-11-06" };
  for (const date of ["2026-11-02", "2026-11-06", "2026-11-10", "2026-11-14"]) assert.equal(isDutyDate(date, schedule), true, date);
  for (const date of ["2026-11-03", "2026-11-05", "2026-11-07", "2026-11-09"]) assert.equal(isDutyDate(date, schedule), false, date);
  assert.equal(nearestDutyDate("2026-11-07", schedule), "2026-11-10");
  assert.equal(nearestDutyDate("2026-11-05", schedule, -1), "2026-11-02");
  assert.equal(nearestDutyDate("2026-12-31", { enabled: true, anchorDate: "2026-12-30" }), "2027-01-03");
  assert.equal(nearestDutyDate("2024-02-29", { enabled: true, anchorDate: "2024-02-27" }), "2024-03-02");
});

test("disabled and invalid schedules leave the full calendar available", () => {
  for (const schedule of [undefined, { enabled: false, anchorDate: "2026-11-06" }, { enabled: true, anchorDate: "2026-02-31" }]) {
    assert.equal(scheduleEnabled(schedule), false);
    assert.equal(isDutyDate("2026-11-07", schedule), true);
    assert.equal(nearestDutyDate("2026-11-07", schedule), "2026-11-07");
  }
  assert.equal(isScheduleDate("2024-02-29"), true);
  assert.equal(isScheduleDate("2026-02-29"), false);
});
