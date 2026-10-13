import test from "node:test";
import assert from "node:assert/strict";
import { findEquipmentNameMatches, parseEquipmentAliases } from "../public/equipment-name-match.js";

const items = [
  { id: "hose51", name: "Рукав пожарный 51 мм" },
  { id: "hose77", name: "Рукав пожарный 77 мм" },
  { id: "pump", name: "Насос" },
  { id: "nozzle", name: "Ствол РСК-50" }
];

test("recognizes whitespace, punctuation and word order", () => {
  assert.equal(findEquipmentNameMatches("  ПОЖАРНЫЙ   РУКАВ 51мм ", items)[0].item.id, "hose51");
  assert.equal(findEquipmentNameMatches("Ствол РСК50", items)[0].exact, true);
});

test("recognizes small typos and Russian inflection", () => {
  assert.equal(findEquipmentNameMatches("Насосс", items)[0].item.id, "pump");
  assert.equal(findEquipmentNameMatches("Рукава пожарные 51 мм", items)[0].item.id, "hose51");
});

test("different numbers and unrelated names are not duplicate warnings", () => {
  assert.deepEqual(findEquipmentNameMatches("Рукав пожарный 66 мм", items), []);
  assert.deepEqual(findEquipmentNameMatches("Ствол РСК-70", items), []);
  assert.deepEqual(findEquipmentNameMatches("Радиостанция", items), []);
});

test("excludes the edited record and waits for enough input", () => {
  assert.deepEqual(findEquipmentNameMatches("Насос", items, "pump"), []);
  assert.deepEqual(findEquipmentNameMatches("Ру", items), []);
  assert.equal(findEquipmentNameMatches("Рукав", items).length, 2);
});

test("finds registered abbreviations, including two letters, once per record", () => {
  const equipment = [{ id: "a", name: "Полное название оборудования", aliases: ["АБ", "АБ-51", "Другое название"] }];
  assert.equal(findEquipmentNameMatches("аб", equipment)[0].item.id, "a");
  assert.equal(findEquipmentNameMatches("АБ51", equipment)[0].matchedName, "АБ-51");
  assert.deepEqual(findEquipmentNameMatches("АБ77", [{ id: "a", name: "Оборудование 51", aliases: ["АБ-51"] }]), []);
  assert.equal(findEquipmentNameMatches("Другое название", equipment).length, 1);
  assert.deepEqual(parseEquipmentAliases("АБ; аб\n Другое   название, АБ-51"), ["АБ", "Другое название", "АБ-51"]);
});
