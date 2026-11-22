// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output
// and exit codes, safe paths, format detection, matching lines at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under its own line break, with whether it ends with one (SPEC.md section 3). */
interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function toState(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function fromState(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** At tier 2, a non-context line of N that starts with P has that P replaced by F (section 5). */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O's lines match the file's lines at this tier (section 5). */
function occurrencesAtTier(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > fileLines.length) return out;
  const want = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (normLine(fileLines[i + k]!, tier) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at least once. */
function findTier(fileLines: string[], o: string[], strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAtTier(fileLines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first tier at which O occurs at least once at or after `from`; the first such occurrence. */
function findTierFrom(fileLines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAtTier(fileLines, o, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

/** One line of O (old) or N (new); a context line of N names its O index. */
interface OldLine {
  text: string;
  ctx: boolean;
}
interface NewLine {
  text: string;
  ctxO: number | null;
}

/** The lines N writes over O's match at `pos`, at the tier O was found at (section 5). */
function mappedNew(fileLines: string[], pos: number, o: OldLine[], n: NewLine[], tier: number): string[] {
  const f = leadingWs(fileLines[pos]!);
  const p = leadingWs(o[0]!.text);
  return n.map((l) => {
    if (l.ctxO !== null) return fileLines[pos + l.ctxO]!;
    if (tier === 2) return reindent(l.text, f, p);
    return l.text;
  });
}

/** O and N from a hunk or chunk body: context and `-` lines are O, context and `+` lines are N. */
function bodyON(body: string[]): { o: OldLine[]; n: NewLine[] } {
  const o: OldLine[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.startsWith(' ')) {
      const t = b.slice(1);
      o.push({ text: t, ctx: true });
      n.push({ text: t, ctxO: o.length - 1 });
    } else if (b.startsWith('-')) {
      o.push({ text: b.slice(1), ctx: false });
    } else if (b.startsWith('+')) {
      n.push({ text: b.slice(1), ctxO: null });
    } else if (b === '') {
      o.push({ text: '', ctx: true });
      n.push({ text: '', ctxO: o.length - 1 });
    }
    // a `\` line is a marker, not a line of O or N
  }
  return { o, n };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Unified diffs (SPEC.md section 6). */

interface Hunk {
  a: number;
  body: string[];
  o: OldLine[];
  n: NewLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noNL: boolean;
  /** a `\` line follows the hunk's last `+` line */
  plusNoNL: boolean;
  hasPlus: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The path of a `--- ` or `+++ ` header line: after the four characters, up to the first tab, trimmed. */
function dashPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  return stripAB(raw);
}

function parseHunk(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  const n = lines.length;
  let i = start + 1;
  const body: string[] = [];
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('@@')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const { o, n: nn } = bodyON(body);
  let noNL = false;
  let plusNoNL = false;
  let hasPlus = false;
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((b, idx) => {
    if (b.startsWith(' ') || b.startsWith('+') || b === '') lastCtxPlus = idx;
    if (b.startsWith('+')) {
      hasPlus = true;
      lastPlus = idx;
    }
  });
  if (lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\')) noNL = true;
  if (lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\')) plusNoNL = true;
  return { hunk: { a, body, o, n: nn, noNL, plusNoNL, hasPlus }, next: i };
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  pathsFromDash: boolean;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  inHeader: boolean;
}

function parseUnified(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const n = lines.length;
  let i = 0;
  const isPair = (at: number): boolean =>
    lines[at]!.startsWith('--- ') && (lines[at + 1] ?? '').startsWith('+++ ');
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, pathsFromDash: false, create: false, del: false, hunks: [], inHeader: true };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && isPair(i)) {
      const oldP = dashPath(line);
      const newP = dashPath(lines[i + 1]!);
      if (cur !== null && cur.inHeader) {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.pathsFromDash = true;
      } else {
        cur = { oldPath: oldP, newPath: newP, pathsFromDash: true, create: false, del: false, hunks: [], inHeader: true };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.inHeader) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunk(lines, i, Number(m[1]));
      cur.hunks.push(parsed.hunk);
      cur.inHeader = false;
      i = parsed.next;
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (line.startsWith('rename from ')) {
        if (!cur.pathsFromDash) cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!cur.pathsFromDash) cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.create = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.del = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict, moves));
}

/** Apply one hunk to a file's state; d is the drift of this section's earlier hunks. */
function applyHunk(state: FileState, h: Hunk, d: number, strict: boolean, path: string): { state: FileState; d: number } {
  const lines = state.lines;
  if (h.o.length === 0) {
    const at = Math.min(h.a + d, lines.length);
    const next = [...lines.slice(0, at), ...h.n.map((l) => l.text), ...lines.slice(at)];
    const final = at === lines.length ? !h.noNL : state.final;
    return { state: { br: state.br, lines: next, final }, d: d + h.n.length };
  }
  const found = findTier(lines, h.o.map((l) => l.text), strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let pos = found.occ[0]!;
  for (const p of found.occ) {
    if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
  }
  const next = mappedNew(lines, pos, h.o, h.n, found.tier);
  const out = [...lines.slice(0, pos), ...next, ...lines.slice(pos + h.o.length)];
  const final = pos + h.o.length === lines.length ? !h.noNL : state.final;
  return { state: { br: state.br, lines: out, final }, d: d + (h.n.length - h.o.length) };
}

function unifiedEdit(sec: Section, strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = sec.create || oldP === null;
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.startsWith('+')) plus.push(b.slice(1));
        }
      }
      let noNL = false;
      for (let k = sec.hunks.length - 1; k >= 0; k -= 1) {
        if (sec.hunks[k]!.hasPlus) {
          noNL = sec.hunks[k]!.plusNoNL;
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : `${plus.join('\n')}${noNL ? '' : '\n'}`);
      return;
    }
    const isDelete = sec.del || newP === null;
    if (isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const oldText = tree.get(oldP!);
    if (oldText === null) throw new Fail('missing', oldP!);
    if (oldP !== newP && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    let state = toState(oldText);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyHunk(state, h, d, strict, oldP!);
      state = r.state;
      d = r.d;
    }
    const text = fromState(state);
    if (oldP === newP) {
      tree.now.set(oldP!, text);
    } else {
      tree.now.set(oldP!, null);
      tree.now.set(newP!, text);
      moves.push([oldP!, newP!]);
    }
  };
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let sep = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
      if (t === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceEnd; j -= 1) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(srEdit(path, lines.slice(s + 1, sep), lines.slice(sep + 1, rep), strict));
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const state = toState(cur);
    const found = findTier(state.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const f = leadingWs(state.lines[pos]!);
    const p = leadingWs(oldLines[0]!);
    const next = newLines.map((l) => (found.tier === 2 ? reindent(l, f, p) : l));
    const out = [...state.lines.slice(0, pos), ...next, ...state.lines.slice(pos + oldLines.length)];
    tree.now.set(path, fromState({ ...state, lines: out }));
  };
}

/** V4A patches (SPEC.md section 8). */

interface Chunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
  o: OldLine[];
  n: NewLine[];
}

function v4aIsSectionStart(l: string): boolean {
  return l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
}

/** First line at or after `from` equal to the anchor, at the first tier with one (section 5, one line). */
function findAnchor(fileLines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(anchor, t);
    for (let i = from; i < fileLines.length; i += 1) {
      if (normLine(fileLines[i]!, t) === want) return i;
    }
  }
  return -1;
}

/** First occurrence of O at or after `from`, at the first tier with one; an end-of-file chunk only takes one ending at the file's last line. */
function findChunkOccurrence(fileLines: string[], o: string[], from: number, eof: boolean, strict: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAtTier(fileLines, o, t).filter((p) => p >= from);
    if (eof) {
      const atEnd = occ.filter((p) => p + o.length === fileLines.length);
      if (atEnd.length > 0) return { tier: t, pos: atEnd[0]! };
    } else if (occ.length > 0) {
      return { tier: t, pos: occ[0]! };
    }
  }
  return null;
}

function parseV4aAdd(lines: string[], start: number, last: number): { edit: Edit; next: number } {
  const path = lines[start]!.slice('*** Add File:'.length).trim();
  const raw: string[] = [];
  let i = start + 1;
  while (i < last) {
    const l = lines[i]!;
    if (v4aIsSectionStart(l)) break;
    raw.push(l);
    i += 1;
  }
  while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
  const fileLines: string[] = [];
  for (let k = 0; k < raw.length; k += 1) {
    const l = raw[k]!;
    if (l.startsWith('+')) fileLines.push(l.slice(1));
    else if (l === '') fileLines.push('');
    else throw new Exit2(`error: parse ${start + 2 + k}`);
  }
  const edit: Edit = (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
  };
  return { edit, next: i };
}

function parseV4aDelete(lines: string[], start: number, last: number): { edit: Edit; next: number } {
  const path = lines[start]!.slice('*** Delete File:'.length).trim();
  let i = start + 1;
  while (i < last) {
    const l = lines[i]!;
    if (v4aIsSectionStart(l)) break;
    if (!blank(l)) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  const edit: Edit = (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
  return { edit, next: i };
}

function parseV4aUpdate(lines: string[], start: number, last: number, strict: boolean, moves: Array<[string, string]>): { edit: Edit; next: number } {
  const path = lines[start]!.slice('*** Update File:'.length).trim();
  let i = start + 1;
  let moveTo: string | null = null;
  if (i < last && lines[i]!.startsWith('*** Move to:')) {
    moveTo = lines[i]!.slice('*** Move to:'.length).trim();
    i += 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  const flush = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  while (i < last) {
    const l = lines[i]!;
    if (v4aIsSectionStart(l)) break;
    if (l.startsWith('*** End of File')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.eof = true;
      flush();
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      flush();
      cur = { anchor: l.slice(2).trim(), body: [], eof: false, o: [], n: [] };
      i += 1;
      continue;
    }
    if (l.startsWith('***')) throw new Exit2(`error: parse ${i + 1}`);
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) cur = { anchor: null, body: [], eof: false, o: [], n: [] };
      cur.body.push(l);
      i += 1;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  flush();
  if (chunks.length > 0) {
    const lastChunk = chunks[chunks.length - 1]!;
    while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
  }
  for (const c of chunks) {
    const { o, n: nn } = bodyON(c.body);
    c.o = o;
    c.n = nn;
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${start + 1}`);
  const edit: Edit = (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let state = toState(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const anchorAt = findAnchor(state.lines, ch.anchor, cursor, strict);
        if (anchorAt < 0) throw new Fail('no-match', path);
        cursor = anchorAt + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? state.lines.length : cursor;
        const next = [...state.lines.slice(0, at), ...ch.n.map((l) => l.text), ...state.lines.slice(at)];
        state = { ...state, lines: next };
        cursor = at + ch.n.length;
        continue;
      }
      const found = findChunkOccurrence(state.lines, ch.o.map((l) => l.text), cursor, ch.eof, strict);
      if (found === null) throw new Fail('no-match', path);
      const next = mappedNew(state.lines, found.pos, ch.o, ch.n, found.tier);
      const out = [...state.lines.slice(0, found.pos), ...next, ...state.lines.slice(found.pos + ch.o.length)];
      state = { ...state, lines: out };
      cursor = found.pos + next.length;
    }
    const text = fromState(state);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
  return { edit, next: i };
}

function parseV4a(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const parsed = parseV4aAdd(lines, i, last);
      edits.push(parsed.edit);
      i = parsed.next;
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const parsed = parseV4aDelete(lines, i, last);
      edits.push(parsed.edit);
      i = parsed.next;
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const parsed = parseV4aUpdate(lines, i, last, strict, moves);
      edits.push(parsed.edit);
      i = parsed.next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict, moves)
          : kind === 'search-replace'
            ? parseSR(lines, strict)
            : parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const movedTo = new Map<string, string>();
  const movedFrom = new Map<string, string>();
  for (const [o, n] of moves) {
    if (!movedTo.has(n)) movedTo.set(n, o);
    if (!movedFrom.has(o)) movedFrom.set(o, n);
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && movedTo.has(p)) {
      const o = movedTo.get(p)!;
      if (tree.now.get(o) === null && tree.original(o) !== null) {
        rows.push({ key: p, line: `R ${o} -> ${p}` });
        continue;
      }
    }
    if (now === null && movedFrom.has(p)) {
      const n = movedFrom.get(p)!;
      if (tree.now.get(n) !== null && tree.original(n) === null) continue;
    }
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
