import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, createMigrationWait, none, splitSql } from './migrations.js';
import { createRequests } from './requests.js';
import example from '../../config/example.config.js';

const PROFILE = example.profile;
const DOWN = 'waiting for the preprod db';

test('none(): no plan rules, no target allowed, nothing to apply, nothing to wait for', () => {
  const m = none();
  assert.deepEqual(m.planRules, []);
  assert.equal(m.planTarget, null);
  assert.equal(m.allowed({ author: 'demo', database: 'app' }), false);
  assert.equal(m.open({ ledger: {} }), null);
  assert.equal(m.reachable, undefined);
});

test('wait: a target without reachable() never touches the requests', async () => {
  let listed = 0;
  const requests = { list: () => { listed++; return []; } };
  await createMigrationWait({ requests, target: none(), kick: () => assert.fail('kicked') }).check();
  assert.equal(listed, 0);
});

test('wait: held requests stay held while the target is down; cleared and kicked once it is up', async (t) => {
  const requests = createRequests({ profile: PROFILE, file: ':memory:' });
  t.after(() => requests.close());
  const { id } = requests.fromHandoff('a@s.whatsapp.net', { name: 'A' }, { type: 'feature-request', fields: { summary: 'x' } });
  for (const to of ['aprobada', 'planificando', 'implementando', 'en_revision', 'en_preprod']) requests.transition(id, to, { actor: 'bridge' });
  requests.patch(id, { hold: DOWN });
  let up = false;
  let kicks = 0;
  const wait = createMigrationWait({ requests, target: { reachable: async () => up, downHold: DOWN }, kick: () => { kicks++; } });
  await wait.check();
  assert.deepEqual([requests.get(id).hold, kicks], [DOWN, 0]);
  up = true;
  await wait.check();
  assert.deepEqual([requests.get(id).hold, requests.get(id).status, kicks], [null, 'en_preprod', 1]);
  await wait.check();
  assert.equal(kicks, 1, 'nothing held -> no kick');
});

test('splitSql: comments, quoted semicolons and DELIMITER blocks', () => {
  const sql = `-- header; not a statement
SET NAMES utf8mb4; # trailing comment
INSERT INTO t (a) VALUES ('x;y'), ("it\\'s; ok");
/* block; comment */ SELECT 1;
DELIMITER //
BEGIN NOT ATOMIC
  IF DATABASE() <> 'shop' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a; b'; END IF;
END //
DELIMITER ;
SELECT 2`;
  const got = splitSql(sql);
  assert.equal(got.length, 5);
  assert.deepEqual(got.map((s) => s.compound), [false, false, false, true, false]);
  assert.match(got[1].sql, /^INSERT INTO t \(a\) VALUES \(''\), \(""\)$/);
  assert.match(got[3].sql, /^BEGIN NOT ATOMIC[\s\S]*END$/);
  assert.equal(splitSql("SELECT 'open"), null, 'unterminated quote -> unsure');
  assert.equal(splitSql('/*!40101 SET x=1 */;'), null, 'executable comment -> unsure');
});

test('classify: additive statements', () => {
  const sql = `-- preflight; DROP TABLE x is only a comment
SET NAMES utf8mb4;
SELECT @@hostname, DATABASE();
DELIMITER //
BEGIN NOT ATOMIC
  IF DATABASE() <> 'shop' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DROP; DELETE'; END IF;
END //
CREATE PROCEDURE sp_x() BEGIN UPDATE tramites SET a = 1; END //
DELIMITER ;
CREATE TABLE IF NOT EXISTS \`presets\` (id INT, name VARCHAR(10) DEFAULT 'a;b');
CREATE OR REPLACE VIEW vw_presets AS SELECT * FROM presets;
CREATE UNIQUE INDEX ix_name ON presets (name);
ALTER TABLE tramites ADD COLUMN preset_id INT NULL, ADD INDEX ix_preset (preset_id), ADD CONSTRAINT fk_p FOREIGN KEY (preset_id) REFERENCES presets (id), ALGORITHM=INPLACE;
INSERT INTO presets (name) VALUES ('uno');
START TRANSACTION;
COMMIT;`;
  const c = classify(sql);
  assert.equal(c.kind, 'additive');
  assert.deepEqual(c.tables.sort(), ['presets', 'tramites', 'vw_presets']);
  assert.deepEqual(c.schemas, []);
  assert.equal(c.unsure, false);
});

test('classify: each non-additive statement makes the file destructive, with its tables', () => {
  const cases = {
    'DROP TABLE IF EXISTS a, `b`;': ['a', 'b'],
    'TRUNCATE TABLE a;': ['a'],
    "DELETE FROM a WHERE x = ';';": ['a'],
    'UPDATE a JOIN b ON a.id = b.id SET a.x = 1;': ['a', 'b'],
    'RENAME TABLE a TO a_old, b TO b_old;': ['a', 'a_old', 'b', 'b_old'],
    'ALTER TABLE a DROP COLUMN x;': ['a'],
    'ALTER TABLE a ADD COLUMN y INT, MODIFY COLUMN x BIGINT;': ['a'],
    'ALTER TABLE a CHANGE x z INT;': ['a'],
    'ALTER TABLE a RENAME COLUMN x TO z;': ['a'],
    "REPLACE INTO a VALUES (1);": ['a'],
    'INSERT INTO a (id) VALUES (1) ON DUPLICATE KEY UPDATE id = 1;': ['a'],
    'CREATE OR REPLACE TABLE a (id INT);': ['a'],
    'DROP PROCEDURE IF EXISTS sp_x;': [],
    'GRANT ALL ON a TO x;': [],
  };
  for (const [sql, tables] of Object.entries(cases)) {
    const c = classify(`CREATE TABLE z (id INT);\n${sql}`);
    assert.equal(c.kind, 'destructive', sql);
    assert.deepEqual(c.tables.filter((t) => t !== 'z').sort(), tables, sql);
  }
  const block = classify("DELIMITER //\nBEGIN NOT ATOMIC UPDATE a SET x = 1; END //\nDELIMITER ;");
  assert.deepEqual([block.kind, block.unsure], ['destructive', true]);
  assert.deepEqual([classify("SELECT 'x").kind, classify("SELECT 'x").unsure], ['destructive', true]);
});

test('classify: qualified names and USE name their schema', () => {
  assert.deepEqual(classify('INSERT INTO app_central.t VALUES (1);').schemas, ['app_central']);
  assert.deepEqual(classify('DROP PROCEDURE IF EXISTS `app_central`.`sp_x`;').schemas, ['app_central']);
  assert.deepEqual(classify('USE shop;').schemas, ['shop']);
  assert.deepEqual(classify('SELECT COUNT(*) FROM information_schema.columns;').schemas, [], 'reads are not targets');
});
