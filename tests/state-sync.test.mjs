import test from "node:test";
import assert from "node:assert/strict";
import { mergeSharedState, sameState } from "../public/state-sync.js";

test("independent edits and additions survive a stale snapshot", () => {
  const base = { equipment: [{ id: "a", name: "Рукав", quantity: 1 }, { id: "b", name: "Насос", quantity: 1 }] };
  const local = structuredClone(base); local.equipment[0].quantity = 2; local.equipment.push({ id: "c", name: "Ствол" });
  const remote = structuredClone(base); remote.equipment[1].quantity = 3; remote.equipment.push({ id: "d", name: "Пила" });
  const merged = mergeSharedState(base, local, remote);
  assert.equal(merged.conflicts.length, 0);
  assert.deepEqual(merged.state.equipment.map((item) => item.id), ["a", "b", "d", "c"]);
  assert.equal(merged.state.equipment[0].quantity, 2);
  assert.equal(merged.state.equipment[1].quantity, 3);
});

test("same-record edits and delete-versus-edit require a choice", () => {
  const base = { equipment: [{ id: "a", name: "Рукав", quantity: 1 }] };
  const local = { equipment: [] };
  const remote = { equipment: [{ id: "a", name: "Рукав", quantity: 2 }] };
  const merged = mergeSharedState(base, local, remote);
  assert.equal(merged.conflicts.length, 1);
  assert.deepEqual(mergeSharedState(base, local, remote, { [merged.conflicts[0].key]: "remote" }).state, remote);
  assert.deepEqual(mergeSharedState(base, local, remote, { [merged.conflicts[0].key]: "local" }).state, local);
});

test("same edits do not conflict; object key order is irrelevant", () => {
  assert.equal(sameState({ id: "a", name: "Насос" }, { name: "Насос", id: "a" }), true);
  assert.equal(mergeSharedState({ equipment: [] }, { equipment: [{ id: "a", name: "Насос" }] }, { equipment: [{ name: "Насос", id: "a" }] }).conflicts.length, 0);
});

test("group order is meaningful and concurrent reorderings are protected", () => {
  const base = { equipmentGroups: { a: "Рукава", b: "Насосы", c: "Пилы" } };
  const local = { equipmentGroups: { b: "Насосы", a: "Рукава", c: "Пилы" } };
  const remote = { equipmentGroups: { c: "Пилы", b: "Насосы", a: "Рукава" } };
  assert.equal(sameState(base, local), false);
  assert.equal(mergeSharedState(base, local, remote).conflicts.length, 1);
  assert.deepEqual(Object.keys(mergeSharedState(base, local, base).state.equipmentGroups), ["b", "a", "c"]);
});

test("rosters on different dates merge while the same date is protected", () => {
  const base = { rosters: { "2026-10-13": { comment: "" }, "2026-10-14": { comment: "" } } };
  const local = structuredClone(base); local.rosters["2026-10-13"].comment = "Заправка";
  const remote = structuredClone(base); remote.rosters["2026-10-14"].comment = "ПХД";
  assert.equal(mergeSharedState(base, local, remote).conflicts.length, 0);
  remote.rosters["2026-10-13"].comment = "Другая запись";
  assert.equal(mergeSharedState(base, local, remote).conflicts.length, 1);
});

test("related-record conflicts can explicitly choose a complete collection", () => {
  const base = { equipment: [], equipmentLocations: [{ id: "garage", name: "Гараж" }] };
  const local = { ...base, equipment: [{ id: "a", name: "Насос", location: "Гараж" }] };
  const remote = { equipment: [], equipmentLocations: [] };
  const chosen = mergeSharedState(base, local, remote, { '["equipment"]': "local", '["equipmentLocations"]': "local" });
  assert.deepEqual(chosen.state, local);
});
