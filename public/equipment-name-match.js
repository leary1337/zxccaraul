function words(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g, "е").match(/[\p{L}]+|\d+/gu) || [];
}
function stem(word) {
  if (word.length < 5) return word;
  const result = word.replace(/(?:ами|ями|ого|ему|ыми|ими|ая|ое|ые|ий|ый|ой|ов|ев|ам|ям|ом|ем|ах|ях|а|я|ы|и|у|ю|е)$/u, "");
  return result.length >= 4 ? result : word;
}
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length];
}
export function findEquipmentNameMatches(query, equipment, excludeId = "") {
  const input = words(query);
  if (input.join("").length < 2) return [];
  const numbers = input.filter((word) => /^\d+$/.test(word));
  const letters = input.filter((word) => !/^\d+$/.test(word)).map(stem);
  const compact = input.join("");
  const matches = equipment.filter((item) => item.id !== excludeId).flatMap((item) => [item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])].filter((name) => typeof name === "string" && name.trim()).map((matchedName) => {
    const tokens = words(matchedName);
    const itemNumbers = tokens.filter((word) => /^\d+$/.test(word));
    if (numbers.length && itemNumbers.length && numbers.join(" ") !== itemNumbers.join(" ")) return null;
    const exact = compact === tokens.join("") || [...input].sort().join(" ") === [...tokens].sort().join(" ");
    if (exact) return { item, exact, score: 2, matchedName };
    if (compact.length < 3) return null;
    const itemLetters = tokens.filter((word) => !/^\d+$/.test(word)).map(stem);
    let score = 0;
    if (letters.length && itemLetters.length) {
      const coverage = letters.filter((word) => itemLetters.some((candidate) => word === candidate || (word.length >= 3 && candidate.startsWith(word)) || (Math.min(word.length, candidate.length) >= 5 && Math.abs(word.length - candidate.length) <= 2 && distance(word, candidate) <= (Math.max(word.length, candidate.length) > 10 ? 2 : 1)))).length / letters.length;
      const reverse = itemLetters.filter((word) => letters.some((candidate) => word === candidate || (candidate.length >= 3 && word.startsWith(candidate)) || (Math.min(word.length, candidate.length) >= 5 && distance(word, candidate) <= 1))).length / itemLetters.length;
      if (coverage === 1 || (coverage >= .75 && reverse >= .75)) score = coverage * .7 + reverse * .3;
    }
    return score >= .7 ? { item, exact: false, score, matchedName } : null;
  })).filter(Boolean).sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, "ru"));
  return [...new Map(matches.slice().reverse().map((match) => [match.item.id, match])).values()].sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, "ru")).slice(0, 8);
}

export function parseEquipmentAliases(value) {
  const unique = new Map();
  String(value || "").split(/[,;\n]+/).forEach((text) => {
    const name = text.trim().replace(/\s+/g, " ");
    const key = words(name).join(" ");
    if (key && !unique.has(key)) unique.set(key, name);
  });
  return [...unique.values()];
}
