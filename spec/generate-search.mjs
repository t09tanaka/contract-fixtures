// Writes spec/fixtures/search.json. Run from the repository root after `npm run build`:
//
//   node spec/generate-search.mjs
//
// The cases come from a fixed seed, so the file is the same on every run. What a pattern
// finds is asked of the RegExp of the engine, not of the package. Only `required` (the text
// the package derives that every match contains) is taken from the TypeScript package; the
// Dart package must derive the same one, and both must find it in every string that holds a
// match.
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
const entry = (name, pattern, values, required) => {
  const compiled = compilePattern(pattern);
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
  "Cases for the search that the `forbidden` patterns of a configuration use, in the shape of the cases of patterns.json. `finds` and `findsNot`: a part of each string in `finds` must match, and no part of a string in `findsNot` may; `matches` and `rejects` are for the whole string. On every string of a case, the search with its shortcut and the search that tries every position must agree, and so must the engine of the language, given the pattern as it is. `required` is the text every match contains, as the packages derive it (the empty string when they derive none): a value without that text is not tried, and every string in which a match is found must contain it. The file is written by spec/generate-search.mjs from a fixed seed; the expectations of what matches are those of an ECMAScript engine.";
const lines = cases.map((c) => "    " + JSON.stringify(c)).join(",\n");
fs.writeFileSync(
  fileURLToPath(new URL("./fixtures/search.json", import.meta.url)),
  `{\n  "description": ${JSON.stringify(description)},\n  "cases": [\n${lines}\n  ]\n}\n`,
);

const pairs = cases.reduce((n, c) => n + c.finds.length + c.findsNot.length, 0);
const both = cases.filter((c) => c.finds.length > 0 && c.findsNot.some((v) => c.required !== "" && !v.includes(c.required))).length;
console.log(`${cases.length} cases, ${pairs} pairs of pattern and string; ${both} cases with a match and a string the shortcut leaves out`);
