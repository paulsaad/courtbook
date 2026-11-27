// Extract every Supabase data call from a website tree: .from("table") chains (select / filters / order / insert /
// update / upsert / delete) and .rpc("fn", {args}). Usage: node extract.mjs <srcdir> > calls.json
// Storage calls (supabase.storage.from) are excluded. Tests (*.test.*) are excluded.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.resolve(process.env.TS_ROOT ?? process.env.REPO_ROOT ?? ".", "package.json"));
const ts = require("typescript");

const root = process.argv[2];
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.|\.spec\./.test(e.name)) files.push(p);
  }
})(root);

const FILTERS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "contains", "containedBy",
  "overlaps", "textSearch", "not", "filter", "order", "rangeGt", "rangeGte", "rangeLt", "rangeLte", "rangeAdjacent"]);
const str = (n) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
function objKeys(n) {
  if (!n) return { keys: [], unresolved: "no argument" };
  if (ts.isArrayLiteralExpression(n)) {
    const all = n.elements.map(objKeys);
    return { keys: [...new Set(all.flatMap((a) => a.keys))], unresolved: all.find((a) => a.unresolved)?.unresolved ?? null };
  }
  if (!ts.isObjectLiteralExpression(n)) return { keys: [], unresolved: `not an object literal (${n.getText().slice(0, 60)})` };
  const keys = []; let unresolved = null;
  for (const p of n.properties) {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) keys.push(p.name.getText().replace(/^["']|["']$/g, ""));
    else unresolved = `spread or computed property (${p.getText().slice(0, 60)})`;
  }
  return { keys, unresolved };
}
// string constants declared anywhere in the tree (const NAME = "..."), used for select lists passed by name
const consts = new Map();
for (const f of files) {
  for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]*)"/g)) {
    consts.set(m[1], consts.has(m[1]) && consts.get(m[1]) !== m[2] ? null : m[2]);
  }
}
const strOrConst = (n) => str(n) ?? (n && ts.isIdentifier(n) && consts.get(n.text) ? consts.get(n.text) : null);
const calls = [];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const admin = /createAdminClient|serviceDeps/.test(text);
  const rel = path.relative(root, f);
  // local wrappers of the form `function call(fn: string, args: ...) { ... .rpc(fn, args) }`: their literal call sites are rpc calls
  const wrappers = new Set([...text.matchAll(/function (\w+)\(fn: string, args/g)].map((m) => m[1]));
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const m = node.expression.name.text;
      const recv = node.expression.expression;
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (m === "from" && !(ts.isPropertyAccessExpression(recv) && recv.name.text === "storage") && node.arguments.length === 1) {
        const table = str(node.arguments[0]);
        if (table === null && /supabase|client|admin|db|sb|deps/i.test(recv.getText())) calls.push({ file: rel, line, admin, kind: "from", table: null, unresolved: `table name is not a literal: ${node.getText().slice(0, 80)}` });
        if (table !== null && !/^Array$|^Buffer$/.test(recv.getText())) {
          const c = { file: rel, line, admin, kind: "from", table, ops: [] };
          // walk up the method chain
          let cur = node;
          while (ts.isPropertyAccessExpression(cur.parent) && ts.isCallExpression(cur.parent.parent) && cur.parent.parent.expression === cur.parent) {
            const call = cur.parent.parent; const name = cur.parent.name.text; const a = call.arguments;
            if (name === "select") c.ops.push({ op: "select", cols: strOrConst(a[0]) ?? (a.length ? `<non-literal ${a[0].getText().slice(0, 40)}>` : "*") });
            else if (name === "insert" || name === "upsert" || name === "update") { const k = objKeys(a[0]); c.ops.push({ op: name, keys: k.keys, unresolved: k.unresolved, onConflict: name === "upsert" && a[1] ? a[1].getText() : undefined }); }
            else if (name === "delete") c.ops.push({ op: "delete" });
            else if (FILTERS.has(name)) c.ops.push({ op: "filter", m: name, col: str(a[0]) ?? `<non-literal ${a[0]?.getText().slice(0, 40)}>` });
            else if (name === "or") c.ops.push({ op: "or", expr: str(a[0]) ?? `<non-literal ${a[0]?.getText().slice(0, 60)}>`, foreign: a[1]?.getText() });
            else if (name === "match") { const k = objKeys(a[0]); c.ops.push({ op: "match", keys: k.keys, unresolved: k.unresolved }); }
            cur = call;
          }
          calls.push(c);
        }
      }
      if (m === "rpc" && node.arguments.length >= 1) {
        const fn = str(node.arguments[0]);
        const k = node.arguments[1] ? objKeys(node.arguments[1]) : { keys: [], unresolved: null };
        calls.push({ file: rel, line, admin, kind: "rpc", fn, keys: k.keys, unresolved: fn === null ? `function name not literal: ${node.getText().slice(0, 80)}` : k.unresolved });
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && wrappers.has(node.expression.text) && str(node.arguments[0])) {
      const k = node.arguments[1] ? objKeys(node.arguments[1]) : { keys: [], unresolved: null };
      calls.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, admin, kind: "rpc", fn: str(node.arguments[0]), keys: k.keys, unresolved: k.unresolved, via: node.expression.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
process.stdout.write(JSON.stringify(calls, null, 1));
