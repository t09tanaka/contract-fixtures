// Writes spec/fixtures/search.json. Run from the repository root after `npm run build`:
//
//   node spec/generate-search.mjs
//
// The cases come from a fixed seed, so the file is the same on every run. What a pattern
// finds is asked of the RegExp of the engine, not of the package. Only what the package
// derives to leave values untried is taken from the TypeScript package: `required` (a text
// every match contains), `requiredAny` (texts of which every match contains one) and
// `shortest` (the fewest code units of a match). The Dart package must derive the same,
// and both must find them true of every string that holds a match.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const { compilePattern } = await import(new URL("../packages/ts/dist/esm/pattern.js", import.meta.url).href);

let state = 20260101;
const rand = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

/** A grammar over a few characters, so that matches are common. */
const grammar = (chars, classes) => {
  const esc = (c) => (c === "-" ? "\\-" : c);
  const atom = (depth) => {
    const r = rand();
    if (r < 0.5) return esc(pick(chars));
    if (r < 0.6) return pick(classes);
    if (r < 0.9 && depth < 2) return `(${rand() < 0.5 ? "?:" : ""}${alt(depth + 1)})`;
    return esc(pick(chars)) + esc(pick(chars));
  };
  const piece = (depth) => {
    const a = atom(depth);
    return rand() < 0.62 ? a : a + pick(["?", "*", "+", "{2}", "{1,2}", "{0,1}", "{1}", "{2,}", "{0}"]);
  };
  const seq = (depth) => Array.from({ length: Math.floor(rand() * 5) + (depth === 0 ? 1 : 0) }, () => piece(depth)).join("");
  const alt = (depth) => (rand() < 0.25 ? `${seq(depth)}|${seq(depth)}` : seq(depth));
  return () => {
    let p = alt(0);
    if (rand() < 0.12) p = "^" + p;
    if (rand() < 0.12) p += "$";
    return p;
  };
};

/** Every string over `chars` up to `length` code units. */
const all = (chars, length) => {
  let last = [""];
  const out = [""];
  for (let i = 0; i < length; i++) {
    last = last.flatMap((s) => chars.map((c) => s + c));
    out.push(...last);
  }
  return out;
};

const wrong = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const entry = (name, pattern, values, required, requiredAny, shortest) => {
  const compiled = compilePattern(pattern);
  if (requiredAny !== undefined && !same(compiled.requiredAny, requiredAny)) {
    wrong.push(`${pattern.slice(0, 40)}: derived any of ${JSON.stringify(compiled.requiredAny)}, expected ${JSON.stringify(requiredAny)}`);
  }
  if (shortest !== undefined && compiled.shortest !== shortest) {
    wrong.push(`${pattern.slice(0, 40)}: derived a length of ${compiled.shortest}, expected ${shortest}`);
  }
  const native = new RegExp(pattern);
  const whole = new RegExp(`^(?:${pattern})$`);
  if (required !== undefined && compiled.required !== required) {
    wrong.push(`${pattern.slice(0, 40)}: derived ${JSON.stringify(compiled.required.slice(0, 40))} (${compiled.required.length}), expected ${JSON.stringify(required.slice(0, 40))} (${required.length})`);
  }
  return {
    case: name,
    pattern,
    valid: true,
    required: compiled.required,
    requiredAny: compiled.requiredAny,
    shortest: compiled.shortest,
    matches: values.filter((v) => whole.test(v)),
    rejects: values.filter((v) => !whole.test(v)),
    finds: values.filter((v) => native.test(v)),
    findsNot: values.filter((v) => !native.test(v)),
  };
};

const cases = [];

// 1. Hand-written: the derived text is given here, and the strings are chosen for it.
const x = (text, n) => text.repeat(n);
const hand = [
  ["sec_(live|test)_[A-Za-z0-9]+", "sec_", ["key=sec_live_9fK27Q;", "sec_sec_test_1", "sec_", "sec_live", "sec-live-1", "_live_1"]],
  ["^hook_", "hook_", ["hook_1", "hook_", "a hook_1", "hook", ""]],
  ["\\.json$", ".json", ["a.json", ".json", "a.json ", "ajson", "a.JSON"]],
  ["a*", "", ["", "bbb"]],
  ["a|b", "", ["xa", "b", "xyz", ""]],
  ["a|", "", ["", "b", "a"]],
  ["(|a)b", "b", ["b", "ab", "a", ""]],
  ["()", "", ["", "a"]],
  ["(?:)", "", ["", "a"]],
  ["x(){3}y", "x", ["xy", "axyb", "x", "y", "x y"]],
  ["(abc){2,}x", "abc", ["abcabcx", "zabcabcabcxz", "abcx", "abcabc", "abc abc x"]],
  ["x(ab){2}y", "ab", ["xababy", "xaby", "xabababy", "ababy"]],
  ["x(ab){1}y", "xaby", ["xaby", "axabyb", "xababy", "xy"]],
  ["xa+b", "x", ["xab", "xaab", "xb", "aab"]],
  ["ab(c|d)efg", "efg", ["abcefg", "xabdefgx", "abefg", "efg", "abxefg"]],
  ["x[y]z", "xyz", ["xyz", "axyzb", "xz", "xYz"]],
  ["x[a-a]z", "xaz", ["xaz", "xbz", "xz"]],
  ["x[aa]z", "x", ["xaz", "xbz", "xz"]],
  ["x[^a]z", "x", ["xbz", "xaz", "xz"]],
  ["x[\\da]z", "x", ["x1z", "xaz", "xbz"]],
  ["x[a\\d]z", "x", ["x1z", "xaz", "xbz"]],
  ["x[\\D]z", "x", ["xaz", "x1z"]],
  ["[\\n]a", "\na", ["\na", "b\nab", "a", "\n"]],
  ["a\\tb\\.c", "a\tb.c", ["a\tb.c", "a\tbxc", "a b.c"]],
  ["a?bc", "bc", ["bc", "abc", "xbcx", "b", "ac", "cb"]],
  ["(ab)(?:cd)", "abcd", ["abcd", "xabcdx", "ab cd", "abc"]],
  ["a{1}b", "ab", ["ab", "cab", "a", "ba"]],
  ["a{2}b", "a", ["aab", "xaab", "ab", "aa"]],
  ["a{0}b", "b", ["b", "ab", "a"]],
  ["(a+b)+c", "a", ["abc", "aababc", "ac", "bc", "ab"]],
  ["ab^cd", "ab", ["abcd", "ab", "cd", ""]],
  ["$a", "a", ["a", "", "ba"]],
  ["(^a|b)c", "c", ["ac", "bc", "xbc", "xac", "c"]],
  ["[ab]cd[^e]ef?", "cd", ["acdxe", "bcdxef", "cd", "acde", "xcdxe"]],
  ["\\d\\d-\\d\\d", "-", ["12-34", "a99-00b", "1-23", "12 34", "ab-cd"]],
  ["(a|b)c(d|e)", "c", ["acd", "xbcex", "ac", "cd", "abde"]],
  ["abc|abd", "", ["abc", "xabd", "ab", "abe"]],
  ["a.c", "a", ["abc", "xa-c", "ac", "a\nc"]],
  ["é+ü", "é", ["éü", "xééü", "éü", "é", "ü"]],
  ["İx", "İx", ["İx", "ix", "İx"]],
  ["a.b", "a", ["a😀b", "a\ud83db", "a\ude00b", "a b", "axb"]],
  // A run of literal characters is not carried on beyond 256 code units.
  [x("a", 300), x("a", 256), [x("a", 300), x("a", 299), x("a", 301), x("a", 256)]],
  [`(${x("b", 200)})(${x("b", 200)})x`, x("b", 200) + "x", [x("b", 400) + "x", x("b", 200) + "x", x("b", 401) + "x", x("b", 400)]],
  [`${x("c", 256)}d`, x("c", 256), [x("c", 256) + "d", x("c", 255) + "d", x("c", 256)]],
];
for (const [pattern, required, values] of hand) {
  cases.push(entry(`required text: ${pattern.length > 40 ? `${pattern.slice(0, 20)}... (${pattern.length} code units)` : pattern}`, pattern, values, required));
}

// 1b. Hand-written: a choice between whole alternatives, where no one text is required but
// one of several is, and the fewest code units of a match.
const forty = Array.from({ length: 40 }, (_, i) => `k${String.fromCharCode(97 + (i % 26))}${i}`);
const alternatives = [
  ["abc_x+|abd_y+", ["abc_", "abd_"], 5, ["abc_x", "zabd_yyz", "abc_", "abd_x", "abc_y", ""]],
  ["(abc|abd)", ["abc", "abd"], 3, ["abc", "xabdx", "ab", "abe", "a b c"]],
  ["(ab|cd)[xy]", ["ab", "cd"], 3, ["abx", "cdy", "ab", "xy", "adx"]],
  ["(a|b)(cd|ef|gh)", ["a", "b"], 3, ["acd", "bgh", "cd", "aef", "ab"]],
  ["(cd|ef|gh)(a|b)", ["a", "b"], 3, ["cda", "ghb", "cd", "efa", "ab"]],
  ["(ab|ab|cd)[0-9]", ["ab", "cd"], 3, ["ab1", "cd9", "ab", "cdx"]],
  ["x{3}|y{2,}", ["x", "y"], 2, ["xxx", "yy", "xx", "y", "xxyy"]],
  ["(a|b){0,2}c|d+", ["c", "d"], 1, ["c", "abc", "d", "ab", ""]],
  ["(ab|(cd|ef)g)h?", ["ab", "g"], 2, ["ab", "cdg", "efgh", "cd", "g"]],
  ["a|", [], 0, ["", "b", "a"]],
  ["(a|[bc])d?", [], 1, ["a", "c", "d", ""]],
  ["(ab|c*)d", [], 1, ["abd", "d", "ccd", "ab", ""]],
  ["(ab|cd)e", [], 3, ["abe", "cde", "ab", "e", "ade"]],
  ["[A-Za-z0-9]{32}", [], 32, [x("a", 32), x("a", 31), `${x("a", 31)}-`, x("Z9", 20), `- ${x("b", 32)} -`, ""]],
  ["[ab]{2}[cd]{3,}", [], 5, ["abccc", "abcc", "xbaddddx", "ab", "ccc"]],
  ["\\d{4}-\\d{4}", [], 9, ["1234-5678", "x1234-5678x", "1234-567", "12345678", "-"]],
  ["^(live|test)_[a-z]+$", [], 6, ["live_a", "test_abc", "live_", "xlive_a", "prod_a"]],
  [`(${forty.join("|")})!?`, [], 3, ["ka0", "kn39!", "ka", "kz99", ""]],
  [`(${forty.slice(0, 32).join("|")})!?`, forty.slice(0, 32), 3, ["ka0", "kf31!", "kg32", ""]],
  // One alternative more than is kept, and the string that matches uses the last one.
  [`(${forty.slice(0, 33).join("|")})!?`, [], 3, ["kg32", "x kg32!", "kf31", "kh33", ""]],
  // Two choices of 20 alternatives each, as branches of one choice: 40 texts, not kept.
  [`(${forty.slice(0, 20).join("|")})[0-9]|(${forty.slice(20).join("|")})[a-z]`, [], 4, ["ka07", "kn39z", "ku20q", "ka0z", "ku207", ""]],
  // The same two as parts of a sequence: the first one offers 20, which are kept.
  [`(${forty.slice(0, 20).join("|")})[xy](${forty.slice(20).join("|")})`, forty.slice(0, 20), 8, ["ka0xku20", "kt19ykn39", "ka0ku20", "ku20xka0", ""]],
];
for (const [pattern, requiredAny, shortest, values] of alternatives) {
  cases.push(entry(`alternatives and length: ${pattern.length > 40 ? `${pattern.slice(0, 20)}... (${pattern.length} code units)` : pattern}`, pattern, values, undefined, requiredAny, shortest));
}

if (wrong.length > 0) throw new Error(`the derived text is not the expected one:\n${wrong.join("\n")}`);

// 2. Generated, a few characters and every short string: matches are common, and so are
// strings that lack the derived text.
const small = grammar(["a", "b", "c"], ["[ab]", "[^a]", "[a-c]", "[b]", ".", "[c-c]"]);
const short = all(["a", "b", "c"], 4);
const seen = new Set();
const generate = (make, values, count, label) => {
  let made = 0;
  while (made < count) {
    const pattern = make();
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    try {
      compilePattern(pattern);
    } catch {
      continue;
    }
    made++;
    cases.push(entry(`${label} ${made}: ${pattern}`, pattern, typeof values === "function" ? values() : values));
  }
};
generate(small, short, 150, "generated, every short string");

// 3. Generated, more characters and classes, longer random strings.
const chars = ["a", "b", "c", "_", "-", "0", "1"];
const wide = grammar(chars, ["[ab]", "[^a]", "[a-c]", "[0-9]", "\\d", "\\w", "\\D", ".", "[_\\-]", "[b]", "\\s"]);
const text = () => Array.from({ length: Math.floor(rand() * 20) }, () => pick(chars)).join("");
generate(wide, () => [...new Set(Array.from({ length: 16 }, text))], 150, "generated, random strings");

const description =
  "Cases for the search that the `forbidden` patterns of a configuration use, in the shape of the cases of patterns.json. `finds` and `findsNot`: a part of each string in `finds` must match, and no part of a string in `findsNot` may; `matches` and `rejects` are for the whole string. On every string of a case, the search with its shortcut and the search that tries every position must agree, and so must the engine of the language, given the pattern as it is. `required` is the text every match contains, as the packages derive it (the empty string when they derive none); `requiredAny` is a list of texts of which every match contains at least one (empty when they derive none, or when there is a `required` text); `shortest` is the fewest code units of a match. A value without the text, without any of the texts, or shorter than that is not tried, and every string in which a match is found must have all three. The file is written by spec/generate-search.mjs from a fixed seed; the expectations of what matches are those of an ECMAScript engine.";
const lines = cases.map((c) => "    " + JSON.stringify(c)).join(",\n");
fs.writeFileSync(
  fileURLToPath(new URL("./fixtures/search.json", import.meta.url)),
  `{\n  "description": ${JSON.stringify(description)},\n  "cases": [\n${lines}\n  ]\n}\n`,
);

const pairs = cases.reduce((n, c) => n + c.finds.length + c.findsNot.length, 0);
const both = cases.filter((c) => c.finds.length > 0 && c.findsNot.some((v) => c.required !== "" && !v.includes(c.required))).length;
console.log(`${cases.length} cases, ${pairs} pairs of pattern and string; ${both} cases with a match and a string the shortcut leaves out`);
