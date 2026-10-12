/**
 * The patterns of volatile paths: a small subset of ECMAScript regular expressions, defined in
 * spec/format.md. The package does not hand them to the regular expression engine of the
 * language. It matches them itself, in time proportional to the length of the value, so that
 * every implementation gives the same answer and no pattern can make a test hang.
 */

/** A pattern is longer than this many UTF-16 code units: refused. */
export const MAX_PATTERN_LENGTH = 1000;
/** A pattern is larger than this once its counted repetitions are written out: refused. */
export const MAX_PATTERN_SIZE = 10000;

/** Why a string is not a pattern. The message does not repeat the pattern. */
export class PatternError extends Error {
  override name = "PatternError";
}

type Range = readonly [number, number];
/** A set of code units: the union of `items`, each a (possibly negated) list of ranges. */
interface CharSet {
  negated: boolean;
  items: { negated: boolean; ranges: readonly Range[] }[];
}

type Node =
  | { type: "set"; set: CharSet }
  | { type: "start" }
  | { type: "end" }
  | { type: "sequence"; nodes: Node[] }
  | { type: "choice"; nodes: Node[] }
  /** `max` is -1 when there is no upper bound. */
  | { type: "repeat"; node: Node; min: number; max: number };

const code = (char: string): number => char.charCodeAt(0);

const DIGIT: readonly Range[] = [[code("0"), code("9")]];
const WORD: readonly Range[] = [
  [code("0"), code("9")],
  [code("A"), code("Z")],
  [code("_"), code("_")],
  [code("a"), code("z")],
];
const LINE_END: readonly Range[] = [
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x2028, 0x2029],
];
const SPACE: readonly Range[] = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
const CLASS_ESCAPES: Record<string, readonly Range[]> = { d: DIGIT, w: WORD, s: SPACE };
const CONTROL_ESCAPES: Record<string, number> = { n: 0x0a, r: 0x0d, t: 0x09 };
/** The characters that mean something in a pattern; each can be escaped with a backslash. */
const SYNTAX = "^$\\.*+?()[]{}|/-";

const one = (unit: number): CharSet => ({
  negated: false,
  items: [{ negated: false, ranges: [[unit, unit]] }],
});

function parse(source: string): Node {
  let at = 0;
  const fail = (message: string): never => {
    throw new PatternError(`${message} (at position ${at})`);
  };
  const peek = (): string => source.charAt(at);

  /** What follows a backslash: a set for \d \w \s (and their negations), or one code unit. */
  const escape = (): { ranges: readonly Range[]; negated: boolean } | number => {
    const char = peek();
    at++;
    const lower = char.toLowerCase();
    if (char !== "" && Object.hasOwn(CLASS_ESCAPES, lower)) {
      return { ranges: CLASS_ESCAPES[lower]!, negated: char !== lower };
    }
    if (char !== "" && Object.hasOwn(CONTROL_ESCAPES, char)) return CONTROL_ESCAPES[char]!;
    if (char !== "" && SYNTAX.includes(char)) return code(char);
    at--;
    return fail("this escape is not supported");
  };

  const characterClass = (): CharSet => {
    const set: CharSet = { negated: false, items: [] };
    if (peek() === "^") {
      set.negated = true;
      at++;
    }
    const ranges: Range[] = [];
    for (;;) {
      const char = peek();
      if (char === "") return fail("a character class is not closed");
      if (char === "]") break;
      at++;
      let low: number;
      if (char === "\\") {
        const escaped = escape();
        if (typeof escaped !== "number") {
          set.items.push(escaped);
          if (peek() === "-" && source.charAt(at + 1) !== "]") {
            return fail("a range in a character class needs a single character on both sides");
          }
          continue;
        }
        low = escaped;
      } else {
        low = code(char);
      }
      if (peek() !== "-" || source.charAt(at + 1) === "]" || source.charAt(at + 1) === "") {
        ranges.push([low, low]);
        continue;
      }
      at++;
      let high: number;
      if (peek() === "\\") {
        at++;
        const escaped = escape();
        if (typeof escaped !== "number") {
          return fail("a range in a character class needs a single character on both sides");
        }
        high = escaped;
      } else {
        high = code(peek());
        at++;
      }
      if (high < low) return fail("a range in a character class is out of order");
      ranges.push([low, high]);
    }
    at++;
    if (ranges.length > 0) set.items.push({ negated: false, ranges });
    if (set.items.length === 0) return fail("a character class is empty");
    return set;
  };

  const count = (): number => {
    const from = at;
    while (peek() >= "0" && peek() <= "9") at++;
    if (at === from) return fail("a repetition needs a number");
    if (at - from > 5) return fail("a repetition count is too large");
    return Number(source.slice(from, at));
  };

  /** The repetition after an atom, if there is one. */
  const repetition = (): { min: number; max: number } | null => {
    const char = peek();
    if (char === "*") return at++, { min: 0, max: -1 };
    if (char === "+") return at++, { min: 1, max: -1 };
    if (char === "?") return at++, { min: 0, max: 1 };
    if (char !== "{") return null;
    at++;
    const min = count();
    let max = min;
    if (peek() === ",") {
      at++;
      max = peek() === "}" ? -1 : count();
    }
    if (peek() !== "}") return fail("a repetition is not closed");
    at++;
    if (max !== -1 && max < min) return fail("a repetition is out of order");
    return { min, max };
  };

  const sequence = (): Node => {
    const nodes: Node[] = [];
    for (;;) {
      const char = peek();
      if (char === "" || char === "|" || char === ")") break;
      let atom: Node;
      at++;
      if (char === "^") atom = { type: "start" };
      else if (char === "$") atom = { type: "end" };
      else if (char === ".") {
        atom = { type: "set", set: { negated: false, items: [{ negated: true, ranges: LINE_END }] } };
      } else if (char === "[") atom = { type: "set", set: characterClass() };
      else if (char === "(") {
        if (peek() === "?") {
          if (source.charAt(at + 1) !== ":") return fail("only groups of the form (...) and (?:...) are supported");
          at += 2;
        }
        atom = choice();
        if (peek() !== ")") return fail("a group is not closed");
        at++;
      } else if (char === "\\") {
        const escaped = escape();
        atom = {
          type: "set",
          set: typeof escaped === "number" ? one(escaped) : { negated: false, items: [escaped] },
        };
      } else if ("*+?{".includes(char)) {
        at--;
        return fail("there is nothing to repeat here (lazy and stacked repetitions are not supported)");
      } else if (char === "]" || char === "}") {
        at--;
        return fail(`${char} must be escaped`);
      } else {
        atom = { type: "set", set: one(code(char)) };
      }
      const repeat = repetition();
      if (repeat === null) nodes.push(atom);
      else if (atom.type === "start" || atom.type === "end") {
        at--;
        return fail("^ and $ cannot be repeated");
      } else nodes.push({ type: "repeat", node: atom, ...repeat });
    }
    return nodes.length === 1 ? nodes[0]! : { type: "sequence", nodes };
  };

  function choice(): Node {
    const nodes = [sequence()];
    while (peek() === "|") {
      at++;
      nodes.push(sequence());
    }
    return nodes.length === 1 ? nodes[0]! : { type: "choice", nodes };
  }

  const root = choice();
  if (at < source.length) return fail("a group is closed that was not opened");
  return root;
}

/** The number of states the pattern needs, or MAX_PATTERN_SIZE + 1 as soon as it is more. */
function size(node: Node): number {
  const capped = (value: number): number => Math.min(value, MAX_PATTERN_SIZE + 1);
  switch (node.type) {
    case "set":
    case "start":
    case "end":
      return 1;
    case "sequence":
      return node.nodes.reduce((sum, child) => capped(sum + size(child)), 0);
    case "choice":
      return node.nodes.reduce((sum, child) => capped(sum + size(child)), node.nodes.length - 1);
    case "repeat": {
      // At least 1, so that repeating something empty is not free: the limit also bounds
      // the work of building the states.
      const inner = Math.max(1, size(node.node));
      return node.max === -1
        ? capped(inner * (node.min + 1) + 1)
        : capped(inner * node.max + (node.max - node.min));
    }
  }
}

const enum Kind {
  Set,
  Split,
  Start,
  End,
  Match,
}

/** A pattern, ready to be tried on values. */
export interface CompiledPattern {
  /** Whether the whole of `value` matches. */
  test(value: string): boolean;
  /** Whether a part of `value` matches (`^` and `$` are still the ends of the value). */
  search(value: string): boolean;
  /**
   * `search` without its shortcut: every position of the value is tried. The result is the
   * same by definition; the tests hold the two against each other.
   */
  scan(value: string): boolean;
  /**
   * A text that every match of the pattern contains, or `""` when none is known. A value
   * without it cannot hold a match, which `search` finds out before it tries the pattern.
   */
  readonly required: string;
  /**
   * Texts of which every match contains at least one, for a pattern without one `required`
   * text (a choice between whole alternatives); empty when none are known.
   */
  readonly requiredAny: readonly string[];
  /** The fewest code units a match can have. A shorter value is not tried either. */
  readonly minLength: number;
}

/** What is known about the texts a part of a pattern matches. */
interface Literal {
  /** The one text the part matches, or `null` when it can match more than one (or none). */
  exact: string | null;
  /** The longest text found that every match of the part contains. */
  required: string;
  /** Texts of which every match of the part contains at least one; empty when none are known. */
  anyOf: readonly string[];
  /** The fewest code units a match of the part can have. */
  min: number;
}

/** More alternatives than this are not kept: the part then says nothing. */
const MAX_ALTERNATIVES = 32;
/** A length beyond this is not counted further; no value is that long. */
const MAX_MIN_LENGTH = 1_000_000_000;

/** An exact text is not carried on beyond this length; what was found so far still counts. */
const MAX_LITERAL_LENGTH = 256;

/**
 * A text that every match of `node` contains. Only what is certain counts: a character that
 * stands for itself, a sequence of such, and what a group or a repetition of at least one
 * holds. A choice, a class, an optional part and an anchor say nothing, and end a run.
 */
function literal(node: Node): Literal {
  const longer = (a: string, b: string): string => (b.length > a.length ? b : a);
  switch (node.type) {
    case "set": {
      const { negated, items } = node.set;
      const only = !negated && items.length === 1 && !items[0]!.negated && items[0]!.ranges.length === 1;
      const range = only ? items[0]!.ranges[0]! : null;
      const exact = range !== null && range[0] === range[1] ? String.fromCharCode(range[0]) : null;
      return { exact, required: exact ?? "", anyOf: exact === null ? [] : [exact], min: 1 };
    }
    case "start":
    case "end":
      return { exact: null, required: "", anyOf: [], min: 0 };
    case "choice": {
      // A match is a match of one branch: it contains a text of that branch, if every
      // branch has one, and is as long as the shortest branch allows.
      const parts = node.nodes.map(literal);
      const all = parts.every((part) => part.anyOf.length > 0) ? [...new Set(parts.flatMap((part) => part.anyOf))] : [];
      return {
        exact: null,
        required: "",
        anyOf: all.length <= MAX_ALTERNATIVES ? all : [],
        min: Math.min(...parts.map((part) => part.min)),
      };
    }
    case "sequence": {
      let run = "";
      let required = "";
      let exact = true;
      let anyOf: readonly string[] = [];
      let min = 0;
      for (const child of node.nodes) {
        const part = literal(child);
        min = Math.min(MAX_MIN_LENGTH, min + part.min);
        // Of the parts that offer alternatives, the one with the fewest (the first, if equal).
        if (part.anyOf.length > 0 && (anyOf.length === 0 || part.anyOf.length < anyOf.length)) anyOf = part.anyOf;
        if (part.exact !== null && run.length + part.exact.length <= MAX_LITERAL_LENGTH) {
          run += part.exact;
          continue;
        }
        exact = false;
        required = longer(longer(required, run), part.required);
        run = part.exact ?? "";
      }
      required = longer(required, run);
      return { exact: exact ? run : null, required, anyOf: required === "" ? anyOf : [required], min };
    }
    case "repeat": {
      if (node.min < 1) return { exact: null, required: "", anyOf: [], min: 0 };
      const part = literal(node.node);
      const once = node.min === 1 && node.max === 1;
      return {
        exact: once ? part.exact : null,
        required: part.required,
        anyOf: part.anyOf,
        min: Math.min(MAX_MIN_LENGTH, part.min * node.min),
      };
    }
  }
}

/** Patterns that were compiled before, by their text. What a pattern means depends on nothing else. */
const compiled = new Map<string, CompiledPattern>();
/** More texts than this are not kept: the map is emptied and starts again. */
const MAX_COMPILED = 1000;

/**
 * Checks `source` against the pattern syntax of spec/format.md and prepares it for matching.
 * Throws `PatternError` when it is not a pattern.
 */
export function compilePattern(source: string): CompiledPattern {
  const known = compiled.get(source);
  if (known !== undefined) return known;
  const pattern = prepare(source);
  if (compiled.size >= MAX_COMPILED) compiled.clear();
  compiled.set(source, pattern);
  return pattern;
}

function prepare(source: string): CompiledPattern {
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new PatternError(`is longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  for (let i = 0; i < source.length; i++) {
    const unit = source.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdfff) {
      throw new PatternError(`characters beyond U+FFFF are not supported (at position ${i})`);
    }
  }
  const root = parse(source);
  if (size(root) > MAX_PATTERN_SIZE) {
    throw new PatternError(`is too large once its repetitions are written out (more than ${MAX_PATTERN_SIZE})`);
  }

  const kinds: Kind[] = [Kind.Match];
  const next: number[] = [0];
  const other: number[] = [0];
  const sets: (CharSet | null)[] = [null];
  const add = (kind: Kind, to: number, alternative = 0, set: CharSet | null = null): number => {
    kinds.push(kind);
    next.push(to);
    other.push(alternative);
    sets.push(set);
    return kinds.length - 1;
  };
  /** Adds the states of `node`, continuing at state `to`; returns the state to enter at. */
  const build = (node: Node, to: number): number => {
    switch (node.type) {
      case "set":
        return add(Kind.Set, to, 0, node.set);
      case "start":
        return add(Kind.Start, to);
      case "end":
        return add(Kind.End, to);
      case "sequence":
        return node.nodes.reduceRight((target, child) => build(child, target), to);
      case "choice":
        return node.nodes
          .map((child) => build(child, to))
          .reduceRight((second, first) => add(Kind.Split, first, second));
      case "repeat": {
        let target = to;
        if (node.max === -1) {
          const loop = add(Kind.Split, 0, to);
          next[loop] = build(node.node, loop);
          target = loop;
        } else {
          for (let i = node.min; i < node.max; i++) {
            target = add(Kind.Split, build(node.node, target), to);
          }
        }
        for (let i = 0; i < node.min; i++) target = build(node.node, target);
        return target;
      }
    }
  };
  const entry = build(root, 0);

  const contains = (set: CharSet, unit: number): boolean => {
    const found = set.items.some(
      (item) => item.ranges.some(([low, high]) => unit >= low && unit <= high) !== item.negated,
    );
    return found !== set.negated;
  };

  /** Whether `value` matches as a whole, or (`anywhere`) whether a part of it does. */
  const run = (value: string, anywhere: boolean): boolean => {
    const seen = new Int32Array(kinds.length).fill(-1);
    /** Follows the states that consume nothing, as they hold at `position`. */
    const enter = (list: number[], first: number, position: number): void => {
      const stack = [first];
      while (stack.length > 0) {
        const state = stack.pop()!;
        if (seen[state] === position) continue;
        seen[state] = position;
        const kind = kinds[state]!;
        if (kind === Kind.Split) stack.push(other[state]!, next[state]!);
        else if (kind === Kind.Start) {
          if (position === 0) stack.push(next[state]!);
        } else if (kind === Kind.End) {
          if (position === value.length) stack.push(next[state]!);
        } else list.push(state);
      }
    };
    const matched = (list: number[]): boolean => list.some((state) => kinds[state] === Kind.Match);
    let current: number[] = [];
    enter(current, entry, 0);
    if (anywhere && matched(current)) return true;
    for (let position = 0; position < value.length && (anywhere || current.length > 0); position++) {
      const unit = value.charCodeAt(position);
      const following: number[] = [];
      for (const state of current) {
        if (kinds[state] === Kind.Set && contains(sets[state]!, unit)) {
          enter(following, next[state]!, position + 1);
        }
      }
      if (anywhere) {
        // A match may start at every position, and it may end before the value does.
        enter(following, entry, position + 1);
        if (matched(following)) return true;
      }
      current = following;
    }
    return matched(current);
  };

  const { required, anyOf, min } = literal(root);
  const requiredAny: readonly string[] = Object.freeze(required === "" ? [...anyOf] : []);
  /** Whether `value` can hold a match at all: long enough, and with a text every match contains. */
  const possible = (value: string): boolean => {
    if (value.length < min) return false;
    if (required !== "") return value.includes(required);
    return requiredAny.length === 0 || requiredAny.some((text) => value.includes(text));
  };
  // Frozen: one object serves every caller that asks for the same text.
  return Object.freeze({
    test: (value: string) => run(value, false),
    search: (value: string) => possible(value) && run(value, true),
    scan: (value: string) => run(value, true),
    required,
    requiredAny,
    minLength: min,
  });
}
