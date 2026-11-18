'use strict';

const constants = require('./constants');
const utils = require('./utils');

/**
 * Constants
 */

const {
  MAX_LENGTH,
  POSIX_REGEX_SOURCE,
  REGEX_NON_SPECIAL_CHARS,
  REGEX_SPECIAL_CHARS_BACKREF,
  REPLACEMENTS
} = constants;

/**
 * Helpers
 */

const expandRange = (args, options) => {
  if (typeof options.expandRange === 'function') {
    return options.expandRange(...args, options);
  }

  args.sort();
  const value = `[${args.join('-')}]`;

  try {
    /* eslint-disable-next-line no-new */
    new RegExp(value);
  } catch (ex) {
    return args.map(v => utils.escapeRegex(v)).join('..');
  }

  return value;
};

/**
 * Create the message for a syntax error
 */

const syntaxError = (type, char) => {
  return `Missing ${type}: "${char}" - use "\\\\${char}" to match literal characters`;
};

const splitTopLevel = input => {
  const parts = [];
  let bracket = 0;
  let paren = 0;
  let quote = 0;
  let value = '';
  let escaped = false;

  for (const ch of input) {
    if (escaped === true) {
      value += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      value += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      quote = quote === 1 ? 0 : 1;
      value += ch;
      continue;
    }

    if (quote === 0) {
      if (ch === '[') {
        bracket++;
      } else if (ch === ']' && bracket > 0) {
        bracket--;
      } else if (bracket === 0) {
        if (ch === '(') {
          paren++;
        } else if (ch === ')' && paren > 0) {
          paren--;
        } else if (ch === '|' && paren === 0) {
          parts.push(value);
          value = '';
          continue;
        }
      }
    }

    value += ch;
  }

  parts.push(value);
  return parts;
};

const isPlainBranch = branch => {
  let escaped = false;

  for (const ch of branch) {
    if (escaped === true) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (/[?*+@!()[\]{}]/.test(ch)) {
      return false;
    }
  }

  return true;
};

const normalizeSimpleBranch = branch => {
  let value = branch.trim();
  let changed = true;

  while (changed === true) {
    changed = false;

    if (/^@\([^\\()[\]{}|]+\)$/.test(value)) {
      value = value.slice(2, -1);
      changed = true;
    }
  }

  if (!isPlainBranch(value)) {
    return;
  }

  return value.replace(/\\(.)/g, '$1');
};

const hasRepeatedCharPrefixOverlap = branches => {
  const values = branches.map(normalizeSimpleBranch).filter(Boolean);

  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const a = values[i];
      const b = values[j];
      const char = a[0];

      if (!char || a !== char.repeat(a.length) || b !== char.repeat(b.length)) {
        continue;
      }

      if (a === b || a.startsWith(b) || b.startsWith(a)) {
        return true;
      }
    }
  }

  return false;
};

const parseRepeatedExtglob = (pattern, requireEnd = true) => {
  if ((pattern[0] !== '+' && pattern[0] !== '*') || pattern[1] !== '(') {
    return;
  }

  let bracket = 0;
  let paren = 0;
  let quote = 0;
  let escaped = false;

  for (let i = 1; i < pattern.length; i++) {
    const ch = pattern[i];

    if (escaped === true) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      quote = quote === 1 ? 0 : 1;
      continue;
    }

    if (quote === 1) {
      continue;
    }

    if (ch === '[') {
      bracket++;
      continue;
    }

    if (ch === ']' && bracket > 0) {
      bracket--;
      continue;
    }

    if (bracket > 0) {
      continue;
    }

    if (ch === '(') {
      paren++;
      continue;
    }

    if (ch === ')') {
      paren--;

      if (paren === 0) {
        if (requireEnd === true && i !== pattern.length - 1) {
          return;
        }

        return {
          type: pattern[0],
          body: pattern.slice(2, i),
          end: i
        };
      }
    }
  }
};

const getStarExtglobSequenceOutput = pattern => {
  let index = 0;
  const chars = [];

  while (index < pattern.length) {
    const match = parseRepeatedExtglob(pattern.slice(index), false);

    if (!match || match.type !== '*') {
      return;
    }

    const branches = splitTopLevel(match.body).map(branch => branch.trim());
    if (branches.length !== 1) {
      return;
    }

    const branch = normalizeSimpleBranch(branches[0]);
    if (!branch || branch.length !== 1) {
      return;
    }

    chars.push(branch);
    index += match.end + 1;
  }

  if (chars.length < 1) {
    return;
  }

  const source = chars.length === 1
    ? utils.escapeRegex(chars[0])
    : `[${chars.map(ch => utils.escapeRegex(ch)).join('')}]`;

  return `${source}*`;
};

const repeatedExtglobRecursion = pattern => {
  let depth = 0;
  let value = pattern.trim();
  let match = parseRepeatedExtglob(value);

  while (match) {
    depth++;
    value = match.body.trim();
    match = parseRepeatedExtglob(value);
  }

  return depth;
};

const analyzeRepeatedExtglob = (body, options) => {
  if (options.maxExtglobRecursion === false) {
    return { risky: false };
  }

  const max =
    typeof options.maxExtglobRecursion === 'number'
      ? options.maxExtglobRecursion
      : constants.DEFAULT_MAX_EXTGLOB_RECURSION;

  const branches = splitTopLevel(body).map(branch => branch.trim());

  if (branches.length > 1) {
    if (
      branches.some(branch => branch === '') ||
      branches.some(branch => /^[*?]+$/.test(branch)) ||
      hasRepeatedCharPrefixOverlap(branches)
    ) {
      return { risky: true };
    }
  }

  for (const branch of branches) {
    const safeOutput = getStarExtglobSequenceOutput(branch);
    if (safeOutput) {
      return { risky: true, safeOutput };
    }

    if (repeatedExtglobRecursion(branch) > max) {
      return { risky: true };
    }
  }

  return { risky: false };
};

// ---------------------------------------------------------------------------
// CVE-2026-112366 (GHSA-fc5q-39xc-vjpf): TEMPORARY local patch, applied to the
// official release until an upstream fix ships. See vendor/picomatch/README.md
// in the project that vendors this copy.
//
// hasExponentialBacktracking(source, flags) reports whether a regex source
// can backtrack exponentially (exponential degree of ambiguity, Weber & Seidl
// 1991, on the Glushkov automaton with derivation counts). parse() uses it as
// a final check: such a pattern is matched as literal text instead, the same
// fallback picomatch already uses for risky extglobs. Every simplification in
// the analyzer errs on the side of reporting ambiguity.
// ---------------------------------------------------------------------------

const EDA_MAX_SCC_POSITIONS = 400;
const EDA_MAX = 0x10ffff;
const EDA_CAP = 2; // derivation counts only need to distinguish 0, 1 and "2 or more"

const edaAdd = (a, b) => Math.min(EDA_CAP, a + b);
const edaMul = (a, b) => Math.min(EDA_CAP, a * b);

// --- character sets ---------------------------------------------------------
// A set is { neg, ranges }: ranges are sorted, non-overlapping [lo, hi] pairs,
// and neg = true means "every character except these".

const edaNormalize = ranges => {
  const sorted = ranges.filter(r => r[0] <= r[1]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      out.push([r[0], r[1]]);
    }
  }
  return out;
};

const edaIntersectRanges = (a, b) => {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (lo <= hi) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
};

const edaComplementRanges = a => {
  const out = [];
  let next = 0;
  for (const [lo, hi] of a) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= EDA_MAX) out.push([next, EDA_MAX]);
  return out;
};

const edaSubtractRanges = (a, b) => edaIntersectRanges(a, edaComplementRanges(b));

const edaSet = (ranges, neg = false) => ({ neg, ranges: edaNormalize(ranges) });

// The characters a set matches, as plain ranges.
const edaMembers = set => (set.neg ? edaComplementRanges(set.ranges) : set.ranges);

const edaRangesOverlap = (a, b) => {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i][1] < b[j][0]) i++;
    else if (b[j][1] < a[i][0]) j++;
    else return true;
  }
  return false;
};

const EDA_DIGIT = [[48, 57]];
const EDA_WORD = [[48, 57], [65, 90], [95, 95], [97, 122]];
const EDA_SPACE = [
  [9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202], [8232, 8233],
  [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279]
];
const EDA_LINE_TERMINATORS = [[10, 10], [13, 13], [8232, 8233]];
const EDA_ALL = [[0, EDA_MAX]];

// --- case folding (the `i` flag) ---------------------------------------------
// Two characters match each other under `i` when they have the same canonical
// form. Without `u` that is the spec's Canonicalize (toUpperCase, unless that
// turns a non-ASCII character into an ASCII one). With `u` the spec uses
// Unicode simple case folding; here every character is grouped with its
// toLowerCase / toUpperCase forms, which covers at least the same pairs.

let edaFoldGroups = null;

const edaBuildFoldGroups = () => {
  const legacyKey = new Uint16Array(0x10000);
  const parent = new Int32Array(0x10000);
  for (let c = 0; c < 0x10000; c++) parent[c] = c;
  const find = x => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const union = (a, b) => {
    if (a < 0x10000 && b < 0x10000) parent[find(a)] = find(b);
  };
  for (let c = 0; c < 0x10000; c++) {
    const ch = String.fromCharCode(c);
    const up = ch.toUpperCase();
    const low = ch.toLowerCase();
    const cu = up.length === 1 ? up.charCodeAt(0) : c;
    legacyKey[c] = c >= 128 && cu < 128 ? c : cu;
    if (up.length === 1) union(c, up.charCodeAt(0));
    if (low.length === 1) union(c, low.charCodeAt(0));
  }
  const group = keyOf => {
    const byKey = new Map();
    for (let c = 0; c < 0x10000; c++) {
      const k = keyOf(c);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(c);
    }
    return { keyOf, byKey };
  };
  return { legacy: group(c => legacyKey[c]), unicode: group(c => find(c)) };
};

const edaFoldRanges = (ranges, unicode) => {
  if (!edaFoldGroups) edaFoldGroups = edaBuildFoldGroups();
  const { keyOf, byKey } = unicode ? edaFoldGroups.unicode : edaFoldGroups.legacy;
  const out = ranges.slice();
  const seen = new Set();
  for (const [lo, hi] of ranges) {
    for (let c = lo; c <= Math.min(hi, 0xffff); c++) {
      const k = keyOf(c);
      if (seen.has(k)) continue;
      seen.add(k);
      for (const m of byKey.get(k)) out.push([m, m]);
    }
    // Characters outside the BMP only occur with `u`; some have case pairs.
    if (hi > 0xffff) out.push([0x10000, EDA_MAX]);
  }
  return edaNormalize(out);
};

const edaFoldCache = new Map();

// How `i` applies depends on how the set was written (spec: CharacterSetMatcher).
// A class written [^...] matches a character when NO member has its canonical
// form: the complement of the folded members. Everything else (a plain class,
// \W, \D, \S, `.`, a class mixing such escapes like [!\Wb]) matches when SOME
// member has its canonical form: the folded members themselves. Treating the
// second kind like the first would shrink it, and hide ambiguity.
const edaFold = (set, unicode) => {
  const key = `${unicode ? 'u' : ''}${set.inverted ? '!' : ''}${set.neg ? '^' : ''}${JSON.stringify(set.ranges)}`;
  if (edaFoldCache.has(key)) return edaFoldCache.get(key);
  let out;
  if (set.inverted) {
    if (unicode) {
      out = set; // folding the members can only shrink [^...]; leaving it is the safe side
    } else {
      const members = edaMembers({ neg: !set.neg, ranges: set.ranges });
      out = { neg: true, ranges: edaFoldRanges(members, false) };
    }
  } else {
    out = { neg: false, ranges: edaFoldRanges(edaMembers(set), unicode) };
  }
  if (edaFoldCache.size > 500) edaFoldCache.clear();
  edaFoldCache.set(key, out);
  return out;
};

// --- parser for the regex subset (any JS regex source) -----------------------

// Returns { root, looks } or null. `looks` holds the body of every lookaround
// (at any depth): they match nothing on the main path, but the engine still
// runs each body, so each one is analysed as a regex of its own.
const edaParse = (source, flags) => {
  const unicode = flags.includes('u') || flags.includes('v');
  if (flags.includes('v') && source.includes('[')) return null; // class set syntax: not modelled
  const dotAll = flags.includes('s');
  let i = 0;
  const EPS = { t: 'eps' };
  // A backreference matches some text (the captured string), so it is
  // modelled as any text. A repeat of a fixed sequence that contains one,
  // like `(\1)+` or `(?:a\1)*`, splits its input in only one way (every
  // iteration has the same length), so the whole repeat is any text too.
  // `fixed` marks a bare backreference: one fixed string. Anything built by
  // a quantifier (`\1?`, `(\1)+`) has a variable length and is not fixed.
  const anyText = fixed => ({ t: 'rep', node: { t: 'char', set: edaSet(EDA_ALL) }, min: 0, max: Infinity, backref: true, fixed });
  const BACKREF = anyText(true);
  const fixedSequence = n => n.fixed === true || n.t === 'char' || n.t === 'eps' || (n.t === 'cat' && n.items.every(fixedSequence));
  const hasBackref = n => Boolean(n.backref) || (n.t === 'cat' && n.items.some(hasBackref));
  const looks = [];
  let failed = false;

  const readChar = () => {
    // one character of the pattern: a code unit, or a code point with `u`
    const c = unicode ? source.codePointAt(i) : source.charCodeAt(i);
    i += c > 0xffff ? 2 : 1;
    return c;
  };

  const hex = n => {
    const h = source.slice(i, i + n);
    if (h.length === n && /^[0-9a-fA-F]+$/.test(h)) {
      i += n;
      return parseInt(h, 16);
    }
    return -1;
  };

  // Legacy octal escapes (`\0`-`\377` without `u`) and, inside a class,
  // `\1`-`\9`: some character from \0 to \377 or a digit. Over-approximated.
  const OCTAL_OR_DIGIT = edaSet([[0, 255], [48, 57]]);

  // at source[i] === '\\'; returns { set } or { cp }
  const escape = inClass => {
    i++;
    if (i >= source.length) return { cp: 92 };
    const c = source[i];
    if (!unicode && ((c === '0' && /[0-9]/.test(source[i + 1] || '')) || (inClass && c >= '1' && c <= '9'))) {
      while (/[0-9]/.test(source[i] || '')) i++;
      return { set: OCTAL_OR_DIGIT };
    }
    switch (c) {
      case 'd': i++; return { set: edaSet(EDA_DIGIT) };
      case 'D': i++; return { set: edaSet(EDA_DIGIT, true) };
      case 'w': i++; return { set: edaSet(EDA_WORD) };
      case 'W': i++; return { set: edaSet(EDA_WORD, true) };
      case 's': i++; return { set: edaSet(EDA_SPACE) };
      case 'S': i++; return { set: edaSet(EDA_SPACE, true) };
      case 'n': i++; return { cp: 10 };
      case 'r': i++; return { cp: 13 };
      case 't': i++; return { cp: 9 };
      case 'f': i++; return { cp: 12 };
      case 'v': i++; return { cp: 11 };
      case '0': i++; return { cp: 0 };
      case 'x': {
        i++;
        const v = hex(2);
        return { cp: v >= 0 ? v : 120 };
      }
      case 'u': {
        i++;
        if (unicode && source[i] === '{') {
          const m = /^\{([0-9a-fA-F]+)\}/.exec(source.slice(i));
          if (m) {
            i += m[0].length;
            return { cp: Math.min(parseInt(m[1], 16), EDA_MAX) };
          }
        }
        const v = hex(4);
        if (v < 0) return { cp: 117 };
        if (unicode && v >= 0xd800 && v <= 0xdbff && source.startsWith('\\u', i)) {
          const save = i;
          i += 2;
          const lo = hex(4);
          if (lo >= 0xdc00 && lo <= 0xdfff) return { cp: 0x10000 + ((v - 0xd800) << 10) + (lo - 0xdc00) };
          i = save;
        }
        return { cp: v };
      }
      case 'c': {
        const l = source[i + 1];
        // inside a class (without `u`) digits and `_` are control letters too
        if (l && (/[a-zA-Z]/.test(l) || (inClass && !unicode && /[0-9_]/.test(l)))) {
          i += 2;
          return { cp: l.charCodeAt(0) % 32 };
        }
        return { cp: 92 }; // `\c` is a literal backslash; `c` is read next
      }
      case 'p':
      case 'P':
        if (unicode) {
          i++;
          if (source[i] === '{') {
            while (i < source.length && source[i] !== '}') i++;
            i++;
          }
          return { set: edaSet(EDA_ALL) };
        }
        i++;
        return { cp: c.charCodeAt(0) };
      default:
        return { cp: readChar() };
    }
  };

  const parseClass = () => {
    // at source[i] === '['
    i++;
    let neg = false;
    if (source[i] === '^') {
      neg = true;
      i++;
    }
    const ranges = [];
    const negated = []; // members like \W, \D, \S: each is "everything except R"
    const member = () => {
      if (source[i] === '\\') {
        // inside a class \b is a backspace
        if (source[i + 1] === 'b') {
          i += 2;
          return { cp: 8 };
        }
        return escape(true);
      }
      return { cp: readChar() };
    };
    // `[]` is an empty class and `[^]` matches anything: a `]` right after
    // `[` (or `[^`) closes the class.
    while (i < source.length && source[i] !== ']') {
      const a = member();
      if (a.set) {
        if (a.set.neg) negated.push(a.set.ranges);
        else ranges.push(...a.set.ranges);
        continue;
      }
      if (source[i] === '-' && i + 1 < source.length && source[i + 1] !== ']') {
        i++;
        const b = member();
        if (b.set) {
          // `a-\d`: the dash is literal
          ranges.push([a.cp, a.cp], [45, 45]);
          if (b.set.neg) negated.push(b.set.ranges);
          else ranges.push(...b.set.ranges);
          continue;
        }
        ranges.push(a.cp <= b.cp ? [a.cp, b.cp] : [b.cp, a.cp]);
      } else {
        ranges.push([a.cp, a.cp]);
      }
    }
    if (i >= source.length) failed = true;
    i++; // ']'
    // The class matches the union of its members. With negated members it is
    // "everything except (what every negated member excludes, minus the
    // positive members)".
    let set;
    const positive = edaNormalize(ranges);
    if (negated.length === 0) {
      set = { neg: false, ranges: positive };
    } else {
      let excluded = edaNormalize(negated[0]);
      for (const r of negated.slice(1)) excluded = edaIntersectRanges(excluded, edaNormalize(r));
      set = { neg: true, ranges: edaSubtractRanges(excluded, positive) };
    }
    if (neg) set = { neg: !set.neg, ranges: set.ranges, inverted: true };
    return { t: 'char', set };
  };

  const parseQuantifier = node => {
    for (;;) {
      const c = source[i];
      let min;
      let max;
      if (c === '*') {
        min = 0;
        max = Infinity;
        i++;
      } else if (c === '+') {
        min = 1;
        max = Infinity;
        i++;
      } else if (c === '?') {
        min = 0;
        max = 1;
        i++;
      } else if (c === '{') {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
        if (!m) return node;
        min = Number(m[1]);
        max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
        i += m[0].length;
      } else {
        return node;
      }
      if (source[i] === '?') i++; // lazy
      node = hasBackref(node) && fixedSequence(node) ? anyText(false) : { t: 'rep', node, min, max };
    }
  };

  const parseAtom = () => {
    const c = source[i];
    if (c === '(') {
      i++;
      let look = false;
      if (source[i] === '?') {
        const n = source[i + 1];
        if (n === ':') {
          i += 2;
        } else if (n === '=' || n === '!') {
          i += 2;
          look = true;
        } else if (n === '<' && (source[i + 2] === '=' || source[i + 2] === '!')) {
          i += 3;
          look = true;
        } else if (n === '<') {
          while (i < source.length && source[i] !== '>') i++;
          i++;
        } else {
          failed = true; // unknown group syntax: do not guess
          return EPS;
        }
      }
      const inner = parseAlt();
      if (source[i] !== ')') failed = true;
      i++; // ')'
      if (look) {
        looks.push(inner);
        return EPS;
      }
      return inner;
    }
    if (c === '[') return parseClass();
    if (c === '.') {
      i++;
      return { t: 'char', set: dotAll ? edaSet(EDA_ALL) : edaSet(EDA_LINE_TERMINATORS, true) };
    }
    if (c === '^' || c === '$') {
      i++;
      return EPS;
    }
    if (c === '\\') {
      const n = source[i + 1];
      if (n === 'b' || n === 'B') {
        i += 2;
        return EPS;
      }
      if (n >= '1' && n <= '9') {
        // backreference (or a legacy octal / identity escape): some text
        i += 2;
        while (source[i] >= '0' && source[i] <= '9') i++;
        return BACKREF;
      }
      if (n === 'k' && source[i + 2] === '<') {
        i += 3;
        while (i < source.length && source[i] !== '>') i++;
        i++;
        return BACKREF;
      }
      const e = escape(false);
      return { t: 'char', set: e.set || edaSet([[e.cp, e.cp]]) };
    }
    const cp = readChar();
    return { t: 'char', set: edaSet([[cp, cp]]) };
  };

  const parseSeq = () => {
    const items = [];
    while (i < source.length && source[i] !== '|' && source[i] !== ')') {
      items.push(parseQuantifier(parseAtom()));
      if (failed) break;
    }
    return { t: 'cat', items };
  };

  function parseAlt() {
    const opts = [parseSeq()];
    while (!failed && source[i] === '|') {
      i++;
      opts.push(parseSeq());
    }
    return opts.length === 1 ? opts[0] : { t: 'alt', opts };
  }

  const root = parseAlt();
  // A stray `)` cannot appear in a valid regex; if it does, stop analysing.
  return !failed && i >= source.length ? { root, looks } : null;
};

// --- Glushkov construction with derivation counts ------------------------------

// For every sub-expression: nul = number of ways it matches the empty string,
// first / last = Map(position -> number of ways it starts / ends there).
// follow[p] = Map(position -> number of derivations of the edge p -> r).
const edaGlushkov = (root, fold, unicode) => {
  const sets = [null]; // position 0 = initial state
  const follow = [new Map()];

  const link = (from, to, n) => {
    if (n === 0) return;
    const m = follow[from];
    m.set(to, edaAdd(m.get(to) || 0, n));
  };
  const scale = (map, n) => {
    const out = new Map();
    if (n === 0) return out;
    for (const [p, c] of map) out.set(p, edaMul(c, n));
    return out;
  };
  const merge = (a, b) => {
    const out = new Map(a);
    for (const [p, c] of b) out.set(p, edaAdd(out.get(p) || 0, c));
    return out;
  };
  const connect = (lastMap, firstMap) => {
    for (const [l, cl] of lastMap) for (const [f, cf] of firstMap) link(l, f, edaMul(cl, cf));
  };

  const build = node => {
    switch (node.t) {
      case 'eps':
        return { nul: 1, first: new Map(), last: new Map() };
      case 'char': {
        const p = sets.length;
        sets.push(fold ? edaFold(node.set, unicode) : node.set);
        follow.push(new Map());
        return { nul: 0, first: new Map([[p, 1]]), last: new Map([[p, 1]]) };
      }
      case 'cat': {
        let acc = { nul: 1, first: new Map(), last: new Map() };
        for (const item of node.items) {
          const r = build(item);
          connect(acc.last, r.first);
          acc = {
            nul: edaMul(acc.nul, r.nul),
            first: merge(acc.first, scale(r.first, acc.nul)),
            last: merge(r.last, scale(acc.last, r.nul))
          };
        }
        return acc;
      }
      case 'alt': {
        let acc = { nul: 0, first: new Map(), last: new Map() };
        for (const opt of node.opts) {
          const r = build(opt);
          acc = { nul: edaAdd(acc.nul, r.nul), first: merge(acc.first, r.first), last: merge(acc.last, r.last) };
        }
        return acc;
      }
      case 'rep': {
        const { min, max } = node;
        if (max === 0) return { nul: 1, first: new Map(), last: new Map() };
        const r = build(node.node);
        // JavaScript rejects an empty iteration once `min` iterations are
        // done, so empty iterations only happen among the first `min`.
        // A repeat allowing 2+ iterations is modelled as a loop; counted
        // repeats like {2,5} get the same cycle (the safe side).
        if (max > 1) connect(r.last, r.first);
        let nul = min === 0 ? 1 : r.nul;
        // mandatory empty iterations before the first real one / after the last
        const firstBoost = min >= 1 && max > 1 && r.nul > 0 ? edaAdd(1, r.nul) : 1;
        const lastBoost = min >= 2 && r.nul > 0 ? edaAdd(1, r.nul) : 1;
        if (min >= 2 && r.nul > 1) nul = EDA_CAP;
        return { nul, first: scale(r.first, firstBoost), last: scale(r.last, lastBoost) };
      }
      default:
        return { nul: 1, first: new Map(), last: new Map() };
    }
  };

  const r = build(root);
  for (const [f, c] of r.first) link(0, f, c);
  return {
    sets,
    follow: follow.map(m => [...m.keys()]),
    multiplicity: follow
  };
};

// Iterative Tarjan SCC over nodes 0..n-1 with an edge function.
const edaScc = (n, edgesOf) => {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const stack = [];
  let next = 0;
  let count = 0;

  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    const work = [[s, 0, edgesOf(s)]];
    index[s] = low[s] = next++;
    stack.push(s);
    onStack[s] = 1;

    while (work.length) {
      const frame = work[work.length - 1];
      const [v, , edges] = frame;
      if (frame[1] < edges.length) {
        const w = edges[frame[1]++];
        if (index[w] === -1) {
          index[w] = low[w] = next++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0, edgesOf(w)]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w]);
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low[parent] = Math.min(low[parent], low[v]);
        }
        if (low[v] === index[v]) {
          let w;
          do {
            w = stack.pop();
            onStack[w] = 0;
            comp[w] = count;
          } while (w !== v);
          count++;
        }
      }
    }
  }

  return { comp, count };
};

// Does this parsed regex (one tree) have exponential degree of ambiguity?
const edaAnalyze = (root, fold, unicode) => {
  const { sets, follow, multiplicity } = edaGlushkov(root, fold, unicode);
  const n = sets.length;

  // States reachable from the initial state.
  const reach = new Uint8Array(n);
  const queue = [0];
  reach[0] = 1;
  while (queue.length) {
    const v = queue.pop();
    for (const w of follow[v]) {
      if (!reach[w]) {
        reach[w] = 1;
        queue.push(w);
      }
    }
  }

  // Cycles of the product automaton project onto cycles of the NFA, so only
  // pairs inside one non-trivial NFA SCC can matter.
  const nfa = edaScc(n, v => (reach[v] ? follow[v] : []));
  const members = new Map();
  for (let v = 1; v < n; v++) {
    if (!reach[v]) continue;
    const c = nfa.comp[v];
    if (!members.has(c)) members.set(c, []);
    members.get(c).push(v);
  }

  for (const list of members.values()) {
    const k = list.length;
    if (k === 1 && !follow[list[0]].includes(list[0])) continue; // trivial
    if (k > EDA_MAX_SCC_POSITIONS) return true; // too large to analyse: unsafe

    const local = new Map(list.map((v, idx) => [v, idx]));
    const succ = list.map(v => follow[v].filter(w => local.has(w)).map(w => local.get(w)));
    const chars = list.map(v => edaMembers(sets[v]));
    const compat = (a, b) => a === b || edaRangesOverlap(chars[a], chars[b]);

    // product node id = a * k + b
    const edgesOf = id => {
      const a = Math.floor(id / k);
      const b = id % k;
      const out = [];
      for (const x of succ[a]) {
        for (const y of succ[b]) {
          if (compat(x, y)) out.push(x * k + y);
        }
      }
      return out;
    };

    const prod = edaScc(k * k, edgesOf);
    const offDiag = new Set();
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) {
        if (a !== b) offDiag.add(prod.comp[a * k + b]);
      }
    }

    // A diagonal pair and a non-diagonal pair in the same product SCC means
    // two distinct equal-label cycles through one state (the SCC then has at
    // least two nodes, so it is a real cycle).
    for (let a = 0; a < k; a++) {
      if (offDiag.has(prod.comp[a * k + a])) return true;
    }

    // An edge p -> r with two or more derivations, where (p, p) and (r, r)
    // lie in one product SCC, gives two distinct equal-label cycles (one per
    // derivation). Covers `(a+)+`, `(?:[^/]*?)+`, `(?:a(?:|)b)+`.
    for (let a = 0; a < k; a++) {
      for (const [to, count] of multiplicity[list[a]]) {
        if (count < 2 || !local.has(to)) continue;
        const x = local.get(to);
        if (prod.comp[a * k + a] === prod.comp[x * k + x]) return true;
      }
    }
  }

  return false;
};

// Results are cached: tools compile the same few globs over and over.
const EDA_CACHE_LIMIT = 1000;
const edaCache = new Map();

const hasExponentialBacktracking = (source, flags = '') => {
  // Fast exit: cycles through more than one position come only from a
  // quantified group, and a quantifier on a single character, class or
  // backreference gives a one-state self-loop with a single derivation,
  // which has exactly one way back to itself. Without a quantifier on a
  // group there is no EDA.
  // (This also covers lookaround bodies, which are part of the source.)
  if (!/\)[*+{]/.test(source)) return false;

  const key = `${flags}\u0000${source}`;
  if (edaCache.has(key)) return edaCache.get(key);

  let result;
  const parsed = edaParse(source, flags);
  if (parsed === null) {
    result = true; // unparseable: treat as unsafe
  } else {
    const fold = flags.includes('i');
    const unicode = flags.includes('u') || flags.includes('v');
    result = edaAnalyze(parsed.root, fold, unicode) || parsed.looks.some(look => edaAnalyze(look, fold, unicode));
  }

  if (edaCache.size >= EDA_CACHE_LIMIT) edaCache.delete(edaCache.keys().next().value);
  edaCache.set(key, result);
  return result;
};

/**
 * Parse the given input string.
 * @param {String} input
 * @param {Object} options
 * @return {Object}
 */

const parse = (input, options) => {
  if (typeof input !== 'string') {
    throw new TypeError('Expected a string');
  }

  input = REPLACEMENTS[input] || input;

  const opts = { ...options };
  const max = typeof opts.maxLength === 'number' ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;

  let len = input.length;
  if (len > max) {
    throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
  }

  const bos = { type: 'bos', value: '', output: opts.prepend || '' };
  const tokens = [bos];

  const capture = opts.capture ? '' : '?:';
  const win32 = utils.isWindows(options);

  // create constants based on platform, for windows or posix
  const PLATFORM_CHARS = constants.globChars(win32);
  const EXTGLOB_CHARS = constants.extglobChars(PLATFORM_CHARS);

  const {
    DOT_LITERAL,
    PLUS_LITERAL,
    SLASH_LITERAL,
    ONE_CHAR,
    DOTS_SLASH,
    NO_DOT,
    NO_DOT_SLASH,
    NO_DOTS_SLASH,
    QMARK,
    QMARK_NO_DOT,
    STAR,
    START_ANCHOR
  } = PLATFORM_CHARS;

  const globstar = opts => {
    return `(${capture}(?:(?!${START_ANCHOR}${opts.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
  };

  const nodot = opts.dot ? '' : NO_DOT;
  const qmarkNoDot = opts.dot ? QMARK : QMARK_NO_DOT;
  let star = opts.bash === true ? globstar(opts) : STAR;

  if (opts.capture) {
    star = `(${star})`;
  }

  // minimatch options support
  if (typeof opts.noext === 'boolean') {
    opts.noextglob = opts.noext;
  }

  const state = {
    input,
    index: -1,
    start: 0,
    dot: opts.dot === true,
    consumed: '',
    output: '',
    prefix: '',
    backtrack: false,
    negated: false,
    brackets: 0,
    braces: 0,
    parens: 0,
    quotes: 0,
    globstar: false,
    tokens
  };

  input = utils.removePrefix(input, state);
  len = input.length;

  const extglobs = [];
  const braces = [];
  const stack = [];
  let prev = bos;
  let value;

  /**
   * Tokenizing helpers
   */

  const eos = () => state.index === len - 1;
  const peek = state.peek = (n = 1) => input[state.index + n];
  const advance = state.advance = () => input[++state.index] || '';
  const remaining = () => input.slice(state.index + 1);
  const consume = (value = '', num = 0) => {
    state.consumed += value;
    state.index += num;
  };

  const append = token => {
    state.output += token.output != null ? token.output : token.value;
    consume(token.value);
  };

  const negate = () => {
    let count = 1;

    while (peek() === '!' && (peek(2) !== '(' || peek(3) === '?')) {
      advance();
      state.start++;
      count++;
    }

    if (count % 2 === 0) {
      return false;
    }

    state.negated = true;
    state.start++;
    return true;
  };

  const increment = type => {
    state[type]++;
    stack.push(type);
  };

  const decrement = type => {
    state[type]--;
    stack.pop();
  };

  /**
   * Push tokens onto the tokens array. This helper speeds up
   * tokenizing by 1) helping us avoid backtracking as much as possible,
   * and 2) helping us avoid creating extra tokens when consecutive
   * characters are plain text. This improves performance and simplifies
   * lookbehinds.
   */

  const push = tok => {
    if (prev.type === 'globstar') {
      const isBrace = state.braces > 0 && (tok.type === 'comma' || tok.type === 'brace');
      const isExtglob = tok.extglob === true || (extglobs.length && (tok.type === 'pipe' || tok.type === 'paren'));

      if (tok.type !== 'slash' && tok.type !== 'paren' && !isBrace && !isExtglob) {
        state.output = state.output.slice(0, -prev.output.length);
        prev.type = 'star';
        prev.value = '*';
        prev.output = star;
        state.output += prev.output;
      }
    }

    if (extglobs.length && tok.type !== 'paren') {
      extglobs[extglobs.length - 1].inner += tok.value;
    }

    if (tok.value || tok.output) append(tok);
    if (prev && prev.type === 'text' && tok.type === 'text') {
      prev.value += tok.value;
      prev.output = (prev.output || '') + tok.value;
      return;
    }

    tok.prev = prev;
    tokens.push(tok);
    prev = tok;
  };

  const extglobOpen = (type, value) => {
    const token = { ...EXTGLOB_CHARS[value], conditions: 1, inner: '' };

    token.prev = prev;
    token.parens = state.parens;
    token.output = state.output;
    token.startIndex = state.index;
    token.tokensIndex = tokens.length;
    const output = (opts.capture ? '(' : '') + token.open;

    increment('parens');
    push({ type, value, output: state.output ? '' : ONE_CHAR });
    push({ type: 'paren', extglob: true, value: advance(), output });
    extglobs.push(token);
  };

  const extglobClose = token => {
    const literal = input.slice(token.startIndex, state.index + 1);
    const body = input.slice(token.startIndex + 2, state.index);
    const analysis = analyzeRepeatedExtglob(body, opts);

    if ((token.type === 'plus' || token.type === 'star') && analysis.risky) {
      const safeOutput = analysis.safeOutput
        ? (token.output ? '' : ONE_CHAR) + (opts.capture ? `(${analysis.safeOutput})` : analysis.safeOutput)
        : undefined;
      const open = tokens[token.tokensIndex];

      open.type = 'text';
      open.value = literal;
      open.output = safeOutput || utils.escapeRegex(literal);

      for (let i = token.tokensIndex + 1; i < tokens.length; i++) {
        tokens[i].value = '';
        tokens[i].output = '';
        delete tokens[i].suffix;
      }

      state.output = token.output + open.output;
      state.backtrack = true;

      push({ type: 'paren', extglob: true, value, output: '' });
      decrement('parens');
      return;
    }

    let output = token.close + (opts.capture ? ')' : '');
    let rest;

    if (token.type === 'negate') {
      let extglobStar = star;

      if (token.inner && token.inner.length > 1 && token.inner.includes('/')) {
        extglobStar = globstar(opts);
      }

      if (extglobStar !== star || eos() || /^\)+$/.test(remaining())) {
        output = token.close = `)$))${extglobStar}`;
      }

      if (token.inner.includes('*') && (rest = remaining()) && /^\.[^\\/.]+$/.test(rest)) {
        // Any non-magical string (`.ts`) or even nested expression (`.{ts,tsx}`) can follow after the closing parenthesis.
        // In this case, we need to parse the string and use it in the output of the original pattern.
        // Suitable patterns: `/!(*.d).ts`, `/!(*.d).{ts,tsx}`, `**/!(*-dbg).@(js)`.
        //
        // Disabling the `fastpaths` option due to a problem with parsing strings as `.ts` in the pattern like `**/!(*.d).ts`.
        const expression = parse(rest, { ...options, fastpaths: false }).output;

        output = token.close = `)${expression})${extglobStar})`;
      }

      if (token.prev.type === 'bos') {
        state.negatedExtglob = true;
      }
    }

    push({ type: 'paren', extglob: true, value, output });
    decrement('parens');
  };

  /**
   * Fast paths
   */

  if (opts.fastpaths !== false && !/(^[*!]|[/()[\]{}"])/.test(input)) {
    let backslashes = false;

    let output = input.replace(REGEX_SPECIAL_CHARS_BACKREF, (m, esc, chars, first, rest, index) => {
      if (first === '\\') {
        backslashes = true;
        return m;
      }

      if (first === '?') {
        if (esc) {
          return esc + first + (rest ? QMARK.repeat(rest.length) : '');
        }
        if (index === 0) {
          return qmarkNoDot + (rest ? QMARK.repeat(rest.length) : '');
        }
        return QMARK.repeat(chars.length);
      }

      if (first === '.') {
        return DOT_LITERAL.repeat(chars.length);
      }

      if (first === '*') {
        if (esc) {
          return esc + first + (rest ? star : '');
        }
        return star;
      }
      return esc ? m : `\\${m}`;
    });

    if (backslashes === true) {
      if (opts.unescape === true) {
        output = output.replace(/\\/g, '');
      } else {
        output = output.replace(/\\+/g, m => {
          return m.length % 2 === 0 ? '\\\\' : (m ? '\\' : '');
        });
      }
    }

    if (output === input && opts.contains === true) {
      state.output = input;
      return state;
    }

    state.output = utils.wrapOutput(output, state, options);
    return state;
  }

  /**
   * Tokenize input until we reach end-of-string
   */

  while (!eos()) {
    value = advance();

    if (value === '\u0000') {
      continue;
    }

    /**
     * Escaped characters
     */

    if (value === '\\') {
      const next = peek();

      if (next === '/' && opts.bash !== true) {
        continue;
      }

      if (next === '.' || next === ';') {
        continue;
      }

      if (!next) {
        value += '\\';
        push({ type: 'text', value });
        continue;
      }

      // collapse slashes to reduce potential for exploits
      const match = /^\\+/.exec(remaining());
      let slashes = 0;

      if (match && match[0].length > 2) {
        slashes = match[0].length;
        state.index += slashes;
        if (slashes % 2 !== 0) {
          value += '\\';
        }
      }

      if (opts.unescape === true) {
        value = advance();
      } else {
        value += advance();
      }

      if (state.brackets === 0) {
        push({ type: 'text', value });
        continue;
      }
    }

    /**
     * If we're inside a regex character class, continue
     * until we reach the closing bracket.
     */

    if (state.brackets > 0 && (value !== ']' || prev.value === '[' || prev.value === '[^')) {
      if (opts.posix !== false && value === ':') {
        const inner = prev.value.slice(1);
        if (inner.includes('[')) {
          prev.posix = true;

          if (inner.includes(':')) {
            const idx = prev.value.lastIndexOf('[');
            const pre = prev.value.slice(0, idx);
            const rest = prev.value.slice(idx + 2);
            const posix = POSIX_REGEX_SOURCE[rest];
            if (posix) {
              prev.value = pre + posix;
              state.backtrack = true;
              advance();

              if (!bos.output && tokens.indexOf(prev) === 1) {
                bos.output = ONE_CHAR;
              }
              continue;
            }
          }
        }
      }

      if ((value === '[' && peek() !== ':') || (value === '-' && peek() === ']')) {
        value = `\\${value}`;
      }

      if (value === ']' && (prev.value === '[' || prev.value === '[^')) {
        value = `\\${value}`;
      }

      if (opts.posix === true && value === '!' && prev.value === '[') {
        value = '^';
      }

      prev.value += value;
      append({ value });
      continue;
    }

    /**
     * If we're inside a quoted string, continue
     * until we reach the closing double quote.
     */

    if (state.quotes === 1 && value !== '"') {
      value = utils.escapeRegex(value);
      prev.value += value;
      append({ value });
      continue;
    }

    /**
     * Double quotes
     */

    if (value === '"') {
      state.quotes = state.quotes === 1 ? 0 : 1;
      if (opts.keepQuotes === true) {
        push({ type: 'text', value });
      }
      continue;
    }

    /**
     * Parentheses
     */

    if (value === '(') {
      increment('parens');
      push({ type: 'paren', value });
      continue;
    }

    if (value === ')') {
      if (state.parens === 0 && opts.strictBrackets === true) {
        throw new SyntaxError(syntaxError('opening', '('));
      }

      const extglob = extglobs[extglobs.length - 1];
      if (extglob && state.parens === extglob.parens + 1) {
        extglobClose(extglobs.pop());
        continue;
      }

      push({ type: 'paren', value, output: state.parens ? ')' : '\\)' });
      decrement('parens');
      continue;
    }

    /**
     * Square brackets
     */

    if (value === '[') {
      if (opts.nobracket === true || !remaining().includes(']')) {
        if (opts.nobracket !== true && opts.strictBrackets === true) {
          throw new SyntaxError(syntaxError('closing', ']'));
        }

        value = `\\${value}`;
      } else {
        increment('brackets');
      }

      push({ type: 'bracket', value });
      continue;
    }

    if (value === ']') {
      if (opts.nobracket === true || (prev && prev.type === 'bracket' && prev.value.length === 1)) {
        push({ type: 'text', value, output: `\\${value}` });
        continue;
      }

      if (state.brackets === 0) {
        if (opts.strictBrackets === true) {
          throw new SyntaxError(syntaxError('opening', '['));
        }

        push({ type: 'text', value, output: `\\${value}` });
        continue;
      }

      decrement('brackets');

      const prevValue = prev.value.slice(1);
      if (prev.posix !== true && prevValue[0] === '^' && !prevValue.includes('/')) {
        value = `/${value}`;
      }

      prev.value += value;
      append({ value });

      // when literal brackets are explicitly disabled
      // assume we should match with a regex character class
      if (opts.literalBrackets === false || utils.hasRegexChars(prevValue)) {
        continue;
      }

      const escaped = utils.escapeRegex(prev.value);
      state.output = state.output.slice(0, -prev.value.length);

      // when literal brackets are explicitly enabled
      // assume we should escape the brackets to match literal characters
      if (opts.literalBrackets === true) {
        state.output += escaped;
        prev.value = escaped;
        continue;
      }

      // when the user specifies nothing, try to match both
      prev.value = `(${capture}${escaped}|${prev.value})`;
      state.output += prev.value;
      continue;
    }

    /**
     * Braces
     */

    if (value === '{' && opts.nobrace !== true) {
      increment('braces');

      const open = {
        type: 'brace',
        value,
        output: '(',
        outputIndex: state.output.length,
        tokensIndex: state.tokens.length
      };

      braces.push(open);
      push(open);
      continue;
    }

    if (value === '}') {
      const brace = braces[braces.length - 1];

      if (opts.nobrace === true || !brace) {
        push({ type: 'text', value, output: value });
        continue;
      }

      let output = ')';

      if (brace.dots === true) {
        const arr = tokens.slice();
        const range = [];

        for (let i = arr.length - 1; i >= 0; i--) {
          tokens.pop();
          if (arr[i].type === 'brace') {
            break;
          }
          if (arr[i].type !== 'dots') {
            range.unshift(arr[i].value);
          }
        }

        output = expandRange(range, opts);
        state.backtrack = true;
      }

      if (brace.comma !== true && brace.dots !== true) {
        const out = state.output.slice(0, brace.outputIndex);
        const toks = state.tokens.slice(brace.tokensIndex);
        brace.value = brace.output = '\\{';
        value = output = '\\}';
        state.output = out;
        for (const t of toks) {
          state.output += (t.output || t.value);
        }
      }

      push({ type: 'brace', value, output });
      decrement('braces');
      braces.pop();
      continue;
    }

    /**
     * Pipes
     */

    if (value === '|') {
      if (extglobs.length > 0) {
        extglobs[extglobs.length - 1].conditions++;
      }
      push({ type: 'text', value });
      continue;
    }

    /**
     * Commas
     */

    if (value === ',') {
      let output = value;

      const brace = braces[braces.length - 1];
      if (brace && stack[stack.length - 1] === 'braces') {
        brace.comma = true;
        output = '|';
      }

      push({ type: 'comma', value, output });
      continue;
    }

    /**
     * Slashes
     */

    if (value === '/') {
      // if the beginning of the glob is "./", advance the start
      // to the current index, and don't add the "./" characters
      // to the state. This greatly simplifies lookbehinds when
      // checking for BOS characters like "!" and "." (not "./")
      if (prev.type === 'dot' && state.index === state.start + 1) {
        state.start = state.index + 1;
        state.consumed = '';
        state.output = '';
        tokens.pop();
        prev = bos; // reset "prev" to the first token
        continue;
      }

      push({ type: 'slash', value, output: SLASH_LITERAL });
      continue;
    }

    /**
     * Dots
     */

    if (value === '.') {
      if (state.braces > 0 && prev.type === 'dot') {
        if (prev.value === '.') prev.output = DOT_LITERAL;
        const brace = braces[braces.length - 1];
        prev.type = 'dots';
        prev.output += value;
        prev.value += value;
        brace.dots = true;
        continue;
      }

      if ((state.braces + state.parens) === 0 && prev.type !== 'bos' && prev.type !== 'slash') {
        push({ type: 'text', value, output: DOT_LITERAL });
        continue;
      }

      push({ type: 'dot', value, output: DOT_LITERAL });
      continue;
    }

    /**
     * Question marks
     */

    if (value === '?') {
      const isGroup = prev && prev.value === '(';
      if (!isGroup && opts.noextglob !== true && peek() === '(' && peek(2) !== '?') {
        extglobOpen('qmark', value);
        continue;
      }

      if (prev && prev.type === 'paren') {
        const next = peek();
        let output = value;

        if (next === '<' && !utils.supportsLookbehinds()) {
          throw new Error('Node.js v10 or higher is required for regex lookbehinds');
        }

        if ((prev.value === '(' && !/[!=<:]/.test(next)) || (next === '<' && !/<([!=]|\w+>)/.test(remaining()))) {
          output = `\\${value}`;
        }

        push({ type: 'text', value, output });
        continue;
      }

      if (opts.dot !== true && (prev.type === 'slash' || prev.type === 'bos')) {
        push({ type: 'qmark', value, output: QMARK_NO_DOT });
        continue;
      }

      push({ type: 'qmark', value, output: QMARK });
      continue;
    }

    /**
     * Exclamation
     */

    if (value === '!') {
      if (opts.noextglob !== true && peek() === '(') {
        if (peek(2) !== '?' || !/[!=<:]/.test(peek(3))) {
          extglobOpen('negate', value);
          continue;
        }
      }

      if (opts.nonegate !== true && state.index === 0) {
        negate();
        continue;
      }
    }

    /**
     * Plus
     */

    if (value === '+') {
      if (opts.noextglob !== true && peek() === '(' && peek(2) !== '?') {
        extglobOpen('plus', value);
        continue;
      }

      if ((prev && prev.value === '(') || opts.regex === false) {
        push({ type: 'plus', value, output: PLUS_LITERAL });
        continue;
      }

      if ((prev && (prev.type === 'bracket' || prev.type === 'paren' || prev.type === 'brace')) || state.parens > 0) {
        push({ type: 'plus', value });
        continue;
      }

      push({ type: 'plus', value: PLUS_LITERAL });
      continue;
    }

    /**
     * Plain text
     */

    if (value === '@') {
      if (opts.noextglob !== true && peek() === '(' && peek(2) !== '?') {
        push({ type: 'at', extglob: true, value, output: '' });
        continue;
      }

      push({ type: 'text', value });
      continue;
    }

    /**
     * Plain text
     */

    if (value !== '*') {
      if (value === '$' || value === '^') {
        value = `\\${value}`;
      }

      const match = REGEX_NON_SPECIAL_CHARS.exec(remaining());
      if (match) {
        value += match[0];
        state.index += match[0].length;
      }

      push({ type: 'text', value });
      continue;
    }

    /**
     * Stars
     */

    if (prev && (prev.type === 'globstar' || prev.star === true)) {
      prev.type = 'star';
      prev.star = true;
      prev.value += value;
      prev.output = star;
      state.backtrack = true;
      state.globstar = true;
      consume(value);
      continue;
    }

    let rest = remaining();
    if (opts.noextglob !== true && /^\([^?]/.test(rest)) {
      extglobOpen('star', value);
      continue;
    }

    if (prev.type === 'star') {
      if (opts.noglobstar === true) {
        consume(value);
        continue;
      }

      const prior = prev.prev;
      const before = prior.prev;
      const isStart = prior.type === 'slash' || prior.type === 'bos';
      const afterStar = before && (before.type === 'star' || before.type === 'globstar');

      if (opts.bash === true && (!isStart || (rest[0] && rest[0] !== '/'))) {
        push({ type: 'star', value, output: '' });
        continue;
      }

      const isBrace = state.braces > 0 && (prior.type === 'comma' || prior.type === 'brace');
      const isExtglob = extglobs.length && (prior.type === 'pipe' || prior.type === 'paren');
      if (!isStart && prior.type !== 'paren' && !isBrace && !isExtglob) {
        push({ type: 'star', value, output: '' });
        continue;
      }

      // strip consecutive `/**/`
      while (rest.slice(0, 3) === '/**') {
        const after = input[state.index + 4];
        if (after && after !== '/') {
          break;
        }
        rest = rest.slice(3);
        consume('/**', 3);
      }

      if (prior.type === 'bos' && eos()) {
        prev.type = 'globstar';
        prev.value += value;
        prev.output = globstar(opts);
        state.output = prev.output;
        state.globstar = true;
        consume(value);
        continue;
      }

      if (prior.type === 'slash' && prior.prev.type !== 'bos' && !afterStar && eos()) {
        state.output = state.output.slice(0, -(prior.output + prev.output).length);
        prior.output = `(?:${prior.output}`;

        prev.type = 'globstar';
        prev.output = globstar(opts) + (opts.strictSlashes ? ')' : '|$)');
        prev.value += value;
        state.globstar = true;
        state.output += prior.output + prev.output;
        consume(value);
        continue;
      }

      if (prior.type === 'slash' && prior.prev.type !== 'bos' && rest[0] === '/') {
        const end = rest[1] !== void 0 ? '|$' : '';

        state.output = state.output.slice(0, -(prior.output + prev.output).length);
        prior.output = `(?:${prior.output}`;

        prev.type = 'globstar';
        prev.output = `${globstar(opts)}${SLASH_LITERAL}|${SLASH_LITERAL}${end})`;
        prev.value += value;

        state.output += prior.output + prev.output;
        state.globstar = true;

        consume(value + advance());

        push({ type: 'slash', value: '/', output: '' });
        continue;
      }

      if (prior.type === 'bos' && rest[0] === '/') {
        prev.type = 'globstar';
        prev.value += value;
        prev.output = `(?:^|${SLASH_LITERAL}|${globstar(opts)}${SLASH_LITERAL})`;
        state.output = prev.output;
        state.globstar = true;
        consume(value + advance());
        push({ type: 'slash', value: '/', output: '' });
        continue;
      }

      // remove single star from output
      state.output = state.output.slice(0, -prev.output.length);

      // reset previous token to globstar
      prev.type = 'globstar';
      prev.output = globstar(opts);
      prev.value += value;

      // reset output with globstar
      state.output += prev.output;
      state.globstar = true;
      consume(value);
      continue;
    }

    const token = { type: 'star', value, output: star };

    if (opts.bash === true) {
      token.output = '.*?';
      if (prev.type === 'bos' || prev.type === 'slash') {
        token.output = nodot + token.output;
      }
      push(token);
      continue;
    }

    if (prev && (prev.type === 'bracket' || prev.type === 'paren') && opts.regex === true) {
      token.output = value;
      push(token);
      continue;
    }

    if (state.index === state.start || prev.type === 'slash' || prev.type === 'dot') {
      if (prev.type === 'dot') {
        state.output += NO_DOT_SLASH;
        prev.output += NO_DOT_SLASH;

      } else if (opts.dot === true) {
        state.output += NO_DOTS_SLASH;
        prev.output += NO_DOTS_SLASH;

      } else {
        state.output += nodot;
        prev.output += nodot;
      }

      if (peek() !== '*') {
        state.output += ONE_CHAR;
        prev.output += ONE_CHAR;
      }
    }

    push(token);
  }

  while (state.brackets > 0) {
    if (opts.strictBrackets === true) throw new SyntaxError(syntaxError('closing', ']'));
    state.output = utils.escapeLast(state.output, '[');
    decrement('brackets');
  }

  while (state.parens > 0) {
    if (opts.strictBrackets === true) throw new SyntaxError(syntaxError('closing', ')'));
    state.output = utils.escapeLast(state.output, '(');
    decrement('parens');
  }

  while (state.braces > 0) {
    if (opts.strictBrackets === true) throw new SyntaxError(syntaxError('closing', '}'));
    state.output = utils.escapeLast(state.output, '{');
    decrement('braces');
  }

  if (opts.strictSlashes !== true && (prev.type === 'star' || prev.type === 'bracket')) {
    push({ type: 'maybe_slash', value: '', output: `${SLASH_LITERAL}?` });
  }

  // rebuild the output if we had to backtrack at any point
  if (state.backtrack === true) {
    state.output = '';

    for (const token of state.tokens) {
      state.output += token.output != null ? token.output : token.value;

      if (token.suffix) {
        state.output += token.suffix;
      }
    }
  }

  // CVE-2026-112366 (temporary local patch): never hand back a regex that can
  // backtrack exponentially. If the finished regex has exponential ambiguity
  // (see hasExponentialBacktracking above), match the whole pattern as
  // literal text instead, the same fallback picomatch uses for risky
  // extglobs. An invalid regex is left alone: it never runs, and picomatch
  // already turns it into one that matches nothing. `maxExtglobRecursion:
  // false` still opts out, as upstream.
  if (opts.maxExtglobRecursion !== false) {
    const flags = opts.flags || (opts.nocase ? 'i' : '');
    if (hasExponentialBacktracking(state.output, flags)) {
      let valid = true;
      try {
        RegExp(`(?:${state.output})`, flags);
      } catch (err) {
        valid = false;
      }
      if (valid) {
        state.output = (opts.prepend || '') + utils.escapeRegex(input.slice(state.start));
      }
    }
  }

  return state;
};

/**
 * Fast paths for creating regular expressions for common glob patterns.
 * This can significantly speed up processing and has very little downside
 * impact when none of the fast paths match.
 */

parse.fastpaths = (input, options) => {
  const opts = { ...options };
  const max = typeof opts.maxLength === 'number' ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
  const len = input.length;
  if (len > max) {
    throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
  }

  input = REPLACEMENTS[input] || input;
  const win32 = utils.isWindows(options);

  // create constants based on platform, for windows or posix
  const {
    DOT_LITERAL,
    SLASH_LITERAL,
    ONE_CHAR,
    DOTS_SLASH,
    NO_DOT,
    NO_DOTS,
    NO_DOTS_SLASH,
    STAR,
    START_ANCHOR
  } = constants.globChars(win32);

  const nodot = opts.dot ? NO_DOTS : NO_DOT;
  const slashDot = opts.dot ? NO_DOTS_SLASH : NO_DOT;
  const capture = opts.capture ? '' : '?:';
  const state = { negated: false, prefix: '' };
  let star = opts.bash === true ? '.*?' : STAR;

  if (opts.capture) {
    star = `(${star})`;
  }

  const globstar = opts => {
    if (opts.noglobstar === true) return star;
    return `(${capture}(?:(?!${START_ANCHOR}${opts.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
  };

  const create = str => {
    switch (str) {
      case '*':
        return `${nodot}${ONE_CHAR}${star}`;

      case '.*':
        return `${DOT_LITERAL}${ONE_CHAR}${star}`;

      case '*.*':
        return `${nodot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;

      case '*/*':
        return `${nodot}${star}${SLASH_LITERAL}${ONE_CHAR}${slashDot}${star}`;

      case '**':
        return nodot + globstar(opts);

      case '**/*':
        return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${ONE_CHAR}${star}`;

      case '**/*.*':
        return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;

      case '**/.*':
        return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${DOT_LITERAL}${ONE_CHAR}${star}`;

      default: {
        const match = /^(.*?)\.(\w+)$/.exec(str);
        if (!match) return;

        const source = create(match[1]);
        if (!source) return;

        return source + DOT_LITERAL + match[2];
      }
    }
  };

  const output = utils.removePrefix(input, state);
  let source = create(output);

  if (source && opts.strictSlashes !== true) {
    source += `${SLASH_LITERAL}?`;
  }

  return source;
};

module.exports = parse;
