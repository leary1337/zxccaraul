import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("function moveEquipmentToGroup(");
const end = source.indexOf("\nfunction ", start + 1);
function fixture(canEdit = true) {
  const equipment = [
    { id: "a", name: "Насос", group: "old", aliases: ["НП"], unit: "шт.", instances: [{ inventoryNumber: "77", location: "АЦ 1", condition: "READY", comment: "Комплект" }, { inventoryNumber: "Исключение", location: "Склад", condition: "MAINTENANCE" }] },
    { id: "b", name: "Рукава", group: "old", trackingMode: "quantity", quantity: 20, location: "Склад", condition: "READY", comment: "Без номеров" },
    { id: "c", name: "Ствол", group: "old", quantity: 1 }
  ];
  const context = { state: { equipment }, equipmentGroups: { old: "ПТВ", target: "Новый раздел" }, can: () => canEdit };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  return context;
}

test("bulk move changes only group and timestamp, including all locations", () => {
  const context = fixture(); const before = structuredClone(context.state.equipment);
  assert.equal(context.moveEquipmentToGroup(["a", "b"], "target").count, 2);
  context.state.equipment.forEach((item, index) => {
    if (index < 2) assert.equal(item.group, "target");
    const { group, updatedAt, ...actual } = item;
    const { group: oldGroup, updatedAt: oldTime, ...expected } = before[index];
    assert.deepEqual(actual, expected);
  });
  assert.equal(context.state.equipment[2].group, "old");
  assert.equal(context.moveEquipmentToGroup(["a", "b"], "target").count, 0);
});

test("expired selections, unknown targets and read-only access do not partially move", () => {
  const context = fixture(); const before = JSON.stringify(context.state);
  assert.ok(context.moveEquipmentToGroup(["a", "deleted"], "target").error);
  assert.ok(context.moveEquipmentToGroup(["a"], "unknown").error);
  assert.equal(JSON.stringify(context.state), before);
  const viewer = fixture(false); const snapshot = JSON.stringify(viewer.state);
  assert.ok(viewer.moveEquipmentToGroup(["a"], "target").error);
  assert.equal(JSON.stringify(viewer.state), snapshot);
});
