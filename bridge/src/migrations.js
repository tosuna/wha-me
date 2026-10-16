// MigrationTarget: where the preprod step applies a request's schema migrations (config pipeline.migrations). Duck-typed:
//   planRules: string[] — plan prompt rules on database work and the plan's `migrations` field (which targets exist). [] with
//     planTarget null: the plan has no migrations field.
//   planTarget: string | null — JSON type of one { author, database } target in the plan's answer contract.
//   allowed({ author, database }) -> boolean — may a plan name this target (plan-step.js validatePlan).
//   open({ ledger }) -> { apply(args) } | null — ledger: requests.js ledger (applied files). apply({ requestId, project, file, sql,
//     author, database, signal }) -> { skipped, kind, dumpPath, extraDatabases }; throws an Error with code 'PREPROD_DOWN' (its
//     message becomes the request's hold) when the target is unreachable, before touching anything. null: nothing is applied;
//     the preprod step only lists the migration files in the PR.
//   reachable() -> Promise<boolean>, downHold: string — optional: holds equal to downHold are cleared once reachable()
//     (createMigrationWait).
// Targets keep their state in closures: loadConfig freezes them.

// No migration target.
export const none = () => ({ planRules: [], planTarget: null, allowed: () => false, open: () => null });

// Requests held by the target being down: cleared (and the pipeline kicked) once it answers again. Called every 10 min.
export function createMigrationWait({ requests, target, kick }) {
  return {
    async check() {
      if (!target.reachable) return;
      const held = requests.list('activas').filter((r) => r.hold === target.downHold);
      if (!held.length || !(await target.reachable())) return;
      for (const r of held) {
        requests.patch(r.id, { hold: null });
        requests.event(r.id, { actor: 'bridge', text: 'preprod arriba: se reanuda' });
      }
      kick();
    },
  };
}

// SQL helpers shared by MigrationTargets and the clash check (clash.js footprints).
// SQL text -> [{ sql, compound }] without comments, string literals emptied ('' / ""), split on the current delimiter
// (DELIMITER lines honoured; compound: ended by a non-; delimiter). null when unsure (unterminated quote/comment, /*! */).
export function splitSql(text) {
  const s = String(text);
  const out = [];
  let cur = '';
  let delim = ';';
  let i = 0;
  const push = () => { const t = cur.trim(); if (t) out.push({ sql: t, compound: delim !== ';' }); cur = ''; };
  while (i < s.length) {
    if (!cur.trim()) {
      const d = /[ \t\r\n]*DELIMITER[ \t]+(\S+)[^\n]*(?:\n|$)/iy;
      d.lastIndex = i;
      const m = d.exec(s);
      if (m) { delim = m[1]; cur = ''; i = d.lastIndex; continue; }
    }
    const c = s[i];
    if ((c === '-' && s[i + 1] === '-' && /[\s]|^$/.test(s[i + 2] ?? '')) || c === '#') {
      const end = s.indexOf('\n', i);
      i = end < 0 ? s.length : end;
    } else if (c === '/' && s[i + 1] === '*') {
      if (s[i + 2] === '!') return null;
      const end = s.indexOf('*/', i + 2);
      if (end < 0) return null;
      cur += ' ';
      i = end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      for (;;) {
        if (j >= s.length) return null;
        if (s[j] === '\\' && c !== '`') j += 2;
        else if (s[j] === c && s[j + 1] === c) j += 2;
        else if (s[j] === c) break;
        else j++;
      }
      cur += c === '`' ? s.slice(i, j + 1) : c + c;
      i = j + 1;
    } else if (s.startsWith(delim, i)) {
      push();
      i += delim.length;
    } else {
      cur += c;
      i++;
    }
  }
  push();
  return out;
}

const ID = '(?:`[^`]+`|[\\w$]+)';
const NAME = `(${ID}(?:\\s*\\.\\s*${ID})?)`;
const DEFINER = '(?:DEFINER\\s*=\\s*\\S+\\s+)?';
const parts = (n) => [...n.matchAll(new RegExp(ID, 'g'))].map((x) => x[0].replace(/^`|`$/g, ''));
const WRITES = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|RENAME|REPLACE|ALTER|CREATE|USE|GRANT|REVOKE|CALL|LOAD)\b/i;

// One statement -> { additive, names (tables, maybe schema-qualified), routines, schemas }.
function statement(sql, compound) {
  const t = sql.replace(/\s+/g, ' ');
  const m = (src) => t.match(new RegExp(`^${src.replaceAll(' ', '\\s+').replaceAll('<N>', NAME)}`, 'i'));
  const joins = (part) => [...part.matchAll(new RegExp(`\\bJOIN\\s+${NAME}`, 'gi'))].map((x) => x[1]);
  const list = (s) => s.split(/,|\s+TO\s+/i).map((x) => x.trim()).filter(Boolean);
  let x;
  if ((x = m('CREATE (OR REPLACE )?(?:TEMPORARY )?TABLE (?:IF NOT EXISTS )?<N>'))) return { additive: !x[1], names: [x[2]] };
  if ((x = m(`CREATE (?:OR REPLACE )?(?:ALGORITHM ?= ?\\w+ )?${DEFINER}(?:SQL SECURITY \\w+ )?VIEW (?:IF NOT EXISTS )?<N>`))) return { additive: true, names: [x[1]] };
  if ((x = m(`CREATE (?:OR REPLACE )?(?:UNIQUE |FULLTEXT |SPATIAL )?INDEX (?:IF NOT EXISTS )?${ID} ON <N>`))) return { additive: true, names: [x[1]] };
  if ((x = m(`CREATE (?:OR REPLACE )?${DEFINER}TRIGGER (?:IF NOT EXISTS )?<N> .*? ON <N>`))) return { additive: true, names: [x[2]], routines: [x[1]] };
  if ((x = m(`CREATE (?:OR REPLACE )?${DEFINER}(?:PROCEDURE|FUNCTION) (?:IF NOT EXISTS )?<N>`))) return { additive: true, routines: [x[1]] };
  if ((x = m('ALTER (?:ONLINE )?(?:IGNORE )?TABLE <N> (.*)$'))) {
    const clauses = [''];
    let depth = 0;
    for (const c of x[2]) {
      depth += c === '(' ? 1 : c === ')' ? -1 : 0;
      if (c === ',' && !depth) clauses.push(''); else clauses[clauses.length - 1] += c;
    }
    return { additive: clauses.every((c) => /^\s*(ADD\b|ALGORITHM\s*=|LOCK\s*=)/i.test(c)), names: [x[1]] };
  }
  if ((x = m('INSERT (?:LOW_PRIORITY |DELAYED |HIGH_PRIORITY )?(?:IGNORE )?(?:INTO )?<N>'))) return { additive: !/\bON DUPLICATE KEY UPDATE\b/i.test(t), names: [x[1]] };
  if ((x = m('REPLACE (?:LOW_PRIORITY |DELAYED )?(?:INTO )?<N>'))) return { additive: false, names: [x[1]] };
  if ((x = m('UPDATE (?:LOW_PRIORITY )?(?:IGNORE )?<N>'))) return { additive: false, names: [x[1], ...joins(t.split(/\bSET\b/i)[0])] };
  if ((x = m('DELETE (?:LOW_PRIORITY )?(?:QUICK )?(?:IGNORE )?(?:[^;]*? )?FROM <N>'))) return { additive: false, names: [x[1], ...joins(t.split(/\bWHERE\b/i)[0])] };
  if ((x = m('DROP (?:TEMPORARY )?(?:TABLE|VIEW)S? (?:IF EXISTS )?(.+?)(?: RESTRICT| CASCADE)?$'))) return { additive: false, names: list(x[1]) };
  if ((x = m('DROP (?:PROCEDURE|FUNCTION|TRIGGER) (?:IF EXISTS )?<N>'))) return { additive: false, routines: [x[1]] };
  if ((x = m('TRUNCATE (?:TABLE )?<N>'))) return { additive: false, names: [x[1]] };
  if ((x = m('RENAME TABLES? (.+)$'))) return { additive: false, names: list(x[1]) };
  if ((x = m(`USE (${ID})`))) return { additive: false, schemas: [parts(x[1])[0]] };
  // Preflight/compound blocks (BEGIN NOT ATOMIC ... IF ... SIGNAL): additive only without any write keyword inside.
  if (compound || /^BEGIN NOT ATOMIC\b/i.test(t)) return WRITES.test(t) ? { additive: false, unsure: true } : { additive: true };
  return { additive: /^(SET|SELECT|SIGNAL|START TRANSACTION|BEGIN|COMMIT|ROLLBACK|DO)\b/i.test(t) };
}

// A migration file -> { kind: additive|destructive, tables (touched, unqualified), schemas (explicit qualifiers / USE),
// unsure }. Unsure (unparseable or opaque compound writes) is destructive.
export function classify(text) {
  const stmts = splitSql(text);
  if (!stmts) return { kind: 'destructive', tables: [], schemas: [], unsure: true };
  const tables = new Set();
  const schemas = new Set();
  let additive = true;
  let unsure = false;
  for (const { sql, compound } of stmts) {
    const r = statement(sql, compound);
    additive &&= r.additive;
    unsure ||= !!r.unsure;
    for (const n of [...(r.names ?? []), ...(r.routines ?? [])]) {
      const p = parts(n);
      if (p.length > 1) schemas.add(p[0]);
      if (r.names?.includes(n)) tables.add(p.at(-1));
    }
    for (const sc of r.schemas ?? []) schemas.add(sc);
  }
  return { kind: additive ? 'additive' : 'destructive', tables: [...tables], schemas: [...schemas], unsure };
}

