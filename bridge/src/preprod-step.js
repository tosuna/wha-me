import { execFile as nodeExecFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { footprint, isMigration } from './clash.js';
import { runGate } from './gate.js';
import { installWorktree, readProjects } from './plan-step.js';
import { classify } from './migrations.js';
import { createSecretGuard } from './secrets.js';

// Peticiones pipeline `preprod` step, run by the bridge, no agent: per block, push
// its block branch and open (or reuse) a draft PR to the prod branch; apply the block's migrations to their preprod
// databases (the config's MigrationTarget, migrations.js; before stage, since the deploy reads the new schema); blocks of repos whose DeployTarget has a stage
// (deploy.js) are then merged into stage (under the stage lock), pushed, and deployed through that target.
// Resume-safe: PRs are reused, applied migrations are skipped (ledger), a stage that already holds the block's tip is not
// merged again, and that deploy is watched again. Preprod DB down -> a waiting hold (pipeline.js), no attempt spent.
// A stage merge conflict caused only by prod↔stage drift (fixes committed to the prod branch and cherry-picked to stage) is
// resolved with the prod side, verified with the project's gate and pushed; any other conflict fails the step.
const GIT_TIMEOUT = 5 * 60 * 1000;
const BIG = 64 * 1024 * 1024;
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];
const cut = (s, n) => { const t = String(s).trim().split('\n')[0]; return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

// Spanish, neutral PR description; no AI attribution.
// profile: the owner whose pipeline prepared the PR.
export function prBody({ request, goal, stat, block, migrations, profile }) {
  const gate = (block.gate ?? []).map((g) => `- \`${g.cmd}\`: ${g.code === 0 ? 'ok' : `código ${g.code}${g.failures?.length ? ` (${g.failures.join(', ')})` : ''}`}`);
  return [
    `## Petición #${request.id}`,
    request.summary,
    '',
    '## Objetivo del bloque',
    goal,
    '',
    '## Archivos',
    '```',
    stat.trim(),
    '```',
    '',
    '## Verificación',
    ...(gate.length ? gate : ['- Sin comandos de verificación registrados.']),
    ...(block.findings?.length ? ['', '## Notas de la revisión', ...block.findings.map((f) => `- ${f}`)] : []),
    '',
    '## Pendiente antes de producción',
    ...migrations.map((m) => `- Migración${m.summary ? ` «${m.summary}»` : ''}${m.file ? ` (\`${m.file}\`)` : ''}: ${
      m.targets?.length ? m.targets.map((t) => {
        const extra = (m.schemas ?? []).filter((d) => d !== t.database);
        return `${t.author}/${t.database}${extra.length ? ` (también toca ${extra.join(', ')})` : ''}`;
      }).join(', ') : 'sin bases destino declaradas'}${
      m.kind ? `, ${m.kind === 'additive' ? 'aditiva' : 'destructiva'}` : ''}; en producción se aplica al entregar (fase 2).`),
    '- Pruebas E2E en preprod (siguiente etapa del pipeline).',
    '',
    '---',
    `Preparado por el pipeline de peticiones de ${profile.name}.`,
  ].join('\n');
}

// requests: requests.js store; ops: repo-ops.js; token(): settings.token; stageLock: shared with small jobs (pipeline.js);
// db: pipeline.migrations opened on the requests ledger (null: migrations are only listed in the PR); clashCheck: clash.js createClashCheck, the cross-request check before anything is pushed or applied; a
// clash -> a hold (no attempt spent) until the owner's clash-ok. gate: gate.js runGate; install: plan-step.js installWorktree;
// workspace / pipeline: config sections (each repo's github, prodBranch and DeployTarget); onSecret: passed to the DeployTargets.
export function createPreprodStep({
  profile, workspace, pipeline, requests, ops, token, stageLock = (fn) => fn(), execFile = promisify(nodeExecFile), leaks = createSecretGuard(),
  db = pipeline.migrations.open({ ledger: requests.ledger }), clashCheck = async () => ({ ok: true }), gate = runGate, install = installWorktree,
  projectsYaml = () => readFileSync(workspace.projectsYaml, 'utf8'), onSecret = () => {},
}) {
  const git = async (wt, args, signal) => (await execFile('git', ['-C', wt, ...NO_HOOKS, ...args], { timeout: GIT_TIMEOUT, signal, maxBuffer: BIG })).stdout;
  const ok = (wt, args, signal) => git(wt, args, signal).then(() => true, () => false);
  const names = async (wt, args, signal) => (await git(wt, [...args, '-z'], signal)).split('\0').filter(Boolean);

  // In the conflicted merge of b into stage at tmp: -> { paths, picked } when every conflicted path is drift (not in the
  // request's diff, and every stage commit on it the branch lacks is a cherry-pick of one the branch has: the branch's
  // version holds stage's), else { blocked: reasons }. Checked against the tip, not origin/<base>: a cherry-pick of a prod
  // commit newer than the branch would be lost by taking the branch's side. Merges are never patch-equivalent (fail closed).
  async function drift(tmp, b, tip, signal) {
    const paths = await names(tmp, ['diff', '--name-only', '--diff-filter=U'], signal);
    if (!paths.length) return { blocked: [] };
    const mine = new Set(await names(tmp, ['diff', '--name-only', `origin/${b.base}...${tip}`], signal));
    const cherry = new Set((await git(tmp, ['cherry', tip, 'origin/stage'], signal)).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)));
    const blocked = [];
    const own = [];
    const picked = new Set();
    for (const p of paths) {
      if (mine.has(p)) { blocked.push(p); continue; }
      const shas = (await git(tmp, ['log', '--format=%H', `${tip}..origin/stage`, '--', p], signal)).split('\n').filter(Boolean);
      if (!shas.length || shas.some((x) => !cherry.has(x))) own.push(p);
      else shas.forEach((x) => picked.add(x));
    }
    const reasons = [...(blocked.length ? [`la petición toca ${blocked.join(', ')}`] : []), ...(own.length ? [`stage tiene cambios propios en ${own.join(', ')}`] : [])];
    return reasons.length ? { blocked: reasons } : { paths, picked: [...picked] };
  }

  // Drift resolved with the branch's (= prod's) side, installed and gated in tmp before the merge commit; -> the event text.
  async function resolveDrift(tmp, b, { paths, picked }, signal) {
    await git(tmp, ['checkout', '--theirs', '--', ...paths], signal);
    await git(tmp, ['add', '--', ...paths], signal);
    const { path, packageManager, verify = [] } = readProjects(projectsYaml())[b.project] ?? {};
    const failed = `conflicto de deriva master↔stage resuelto con el lado de ${b.base} pero el gate falló`;
    try {
      await install({ worktree: tmp, repo: join(workspace.root, path ?? b.project), packageManager, signal });
    } catch (e) { throw new Error(`${failed}: instalación: ${cut(e.message, 200)}`); }
    // ponytail: the stage lock is held through install + gate (minutes); other stage merges wait.
    const res = await gate({ worktree: tmp, commands: verify, signal });
    const bad = res.filter((r) => r.failures.some((f) => !b.baseline?.[r.cmd]?.includes(f)));
    if (bad.length) throw new Error(`${failed}: ${bad.map((r) => `${r.cmd}: ${r.failures.join(', ')}`).join('; ')}`);
    await git(tmp, ['commit', '--no-verify', '-m', `merge: ${b.branch} into stage (${paths.join(', ')} from ${b.base})`], signal);
    return `${b.key}: deriva master↔stage en stage resuelta con el lado de ${b.base} (gate ok): ${paths.join(', ')}; stage los tenía de cherry-picks de ${b.base}: ${picked.map((x) => x.slice(0, 7)).join(', ')}`;
  }

  // Merge the block into stage and push it, under the lock; -> the stage sha whose deploy to watch.
  async function toStage(id, b, tip, ev, signal) {
    const repo = pipeline.repos[b.project].github;
    return stageLock(async () => {
      await git(b.worktree, ['fetch', 'origin', 'stage'], signal);
      if (await ok(b.worktree, ['merge-base', '--is-ancestor', tip, 'origin/stage'], signal)) {
        return b.stage_sha ?? (await git(b.worktree, ['rev-parse', 'origin/stage'], signal)).trim();
      }
      const tmp = join(workspace.worktreesDir(b.project), `stage-pet-${id}`);
      await ok(b.worktree, ['worktree', 'remove', '--force', tmp]); // leftover of a crash
      await git(b.worktree, ['worktree', 'add', '--detach', tmp, 'origin/stage'], signal);
      try {
        if (!(await ok(tmp, ['merge', '--no-ff', '--no-edit', '--no-verify', b.branch], signal))) {
          try {
            const d = await drift(tmp, b, tip, signal);
            if (d.blocked) throw new Error(`conflicto al mezclar ${b.branch} en stage; quedan la rama y el PR (${b.pr_url})${d.blocked.length ? ` (${d.blocked.join('; ')})` : ''}`);
            ev('note', await resolveDrift(tmp, b, d, signal));
          } catch (e) {
            await ok(tmp, ['merge', '--abort']);
            throw e;
          }
        }
        const sha = (await git(tmp, ['rev-parse', 'HEAD'], signal)).trim();
        await ops.push({ worktree: tmp, repo, src: sha, ref: 'refs/heads/stage', signal });
        ev('push', `stage ← ${b.branch} (${sha.slice(0, 7)}) en ${repo}`);
        return sha;
      } finally {
        await ok(b.worktree, ['worktree', 'remove', '--force', tmp]);
      }
    });
  }

  return async ({ request, budgetUsd, timeoutMs, signal, onEvent, say = async () => {} }) => {
    if (!token()) throw new Error('falta el token de GitHub (Ajustes)');
    const { plan, blocks } = requests.detail(request.id);
    const ev = (kind, text) => requests.event(request.id, { actor: 'agent:preprod', kind, text });

    // Every check before any push.
    const ready = [];
    for (const b of blocks) {
      if (!Object.hasOwn(pipeline.repos, b.project)) throw new Error(`no sé a qué repo de GitHub subir ${b.project} (bloque ${b.key})`);
      // Tracked files only: the copied .env* and node_modules are never committed (implement-step.js).
      if ((await git(b.worktree, ['status', '--porcelain', '--untracked-files=no'], signal)).trim()) throw new Error(`el worktree de ${b.key} tiene cambios sin commit`);
      const tip = (await git(b.worktree, ['rev-parse', `refs/heads/${b.branch}`], signal)).trim();
      if ((await git(b.worktree, ['rev-parse', 'HEAD'], signal)).trim() !== tip) throw new Error(`el worktree de ${b.key} no está en la punta de ${b.branch}`);
      const range = `origin/${b.base}...${tip}`;
      if (leaks(await git(b.worktree, ['diff', range], signal))) throw new Error(`posible secreto en el diff de ${b.key}; no se subió nada`);
      // Deleted files are not migrations to apply.
      const files = (await git(b.worktree, ['diff', '--name-only', '--diff-filter=d', range], signal)).split('\n').filter(Boolean);
      const migs = [];
      for (const file of files.filter(isMigration)) {
        const entry = plan?.migrations?.find((m) => m.project === b.project && m.file === file);
        const sql = file.endsWith('.sql') ? await git(b.worktree, ['show', `${tip}:${file}`], signal) : null;
        const c = sql == null ? null : classify(sql);
        migs.push({ file, sql, summary: entry?.summary, targets: entry?.targets, kind: c?.kind ?? null, schemas: c?.schemas ?? [] });
      }
      b.footprint = footprint({ files: (await git(b.worktree, ['diff', '--name-only', range], signal)).split('\n').filter(Boolean), migrations: migs });
      ready.push({ b, tip, migs, stat: await git(b.worktree, ['diff', '--stat', range], signal) });
    }
    requests.patch(request.id, { blocks }); // footprints, for other requests' clash checks
    const clash = await clashCheck({ request, blocks, budgetUsd, timeoutMs, signal, onEvent });
    if (!clash.ok) return { hold: clash.hold, clash: true };

    const urls = [];
    for (const { b, tip, migs, stat } of ready) {
      const { github: repo, prodBranch: prod, deploy } = pipeline.repos[b.project];
      await ops.push({ worktree: b.worktree, repo, src: tip, ref: `refs/heads/${b.branch}`, signal });
      ev('push', `${b.branch} (${tip.slice(0, 7)}) en ${repo}`);
      const goal = plan?.blocks?.find((p) => p.key === b.key)?.goal || request.summary;
      // The block's migration files, plus planned ones of its project the diff does not hold (listed by summary).
      const planned = (plan?.migrations ?? []).filter((m) => m.project === b.project && !migs.some((x) => x.file === m.file));
      const body = prBody({ request, goal, stat, block: b, migrations: [...migs, ...planned], profile });
      if (leaks(body)) throw new Error(`posible secreto en la descripción del PR de ${b.key}`);
      const { url } = await ops.ensurePr({ repo, base: prod, head: b.branch, title: cut(`Petición #${request.id}: ${goal}`, 120), body });
      b.pr_url = url;
      requests.patch(request.id, { blocks });
      ev('pr', `${b.key}: ${url}`);
      urls.push(url);

      if (migs.length && db) {
        const unknown = migs.filter((m) => m.sql == null || !m.targets?.length).map((m) => m.file);
        if (unknown.length) {
          const text = `${b.key}: ${unknown.join(', ')} sin bases destino declaradas en el plan (o no es .sql); no se adivina: aplícala a mano o vuelve a planear`;
          ev('note', text);
          throw new Error(text);
        }
        for (const m of migs) {
          for (const { author, database } of m.targets) {
            let r;
            try {
              r = await db.apply({ requestId: request.id, project: b.project, file: m.file, sql: m.sql, author, database, signal });
            } catch (e) {
              if (e.code === 'PREPROD_DOWN') return { hold: e.message, wait: true };
              throw e;
            }
            const what = r.skipped ? 'ya aplicada' : `${r.kind === 'additive' ? 'aditiva' : 'destructiva'}${r.dumpPath ? `, respaldo ${r.dumpPath}` : ''}`;
            ev('migration', `${b.key}: ${m.file} → ${author}/${database} (${what})`);
          }
        }
      }

      if (!deploy.stage) continue;
      const sha = await toStage(request.id, b, tip, ev, signal);
      b.stage_sha = sha;
      requests.patch(request.id, { blocks });
      ev('note', `${b.key}: deploy a preprod ${await deploy.run({ repo, sha, worktree: b.worktree, signal, ops, leaks, onSecret })}`);
    }
    await say(`PETICIÓN #${request.id} lista para entregar: ${urls.join(' ')}`);
    return { result: urls.join('\n') };
  };
}
