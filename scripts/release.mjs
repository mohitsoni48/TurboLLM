#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// TurboLLM release driver — a phase state machine for the runbook in
// docs/RELEASE.md (docs/ is local-only; this script is the public half).
//
//   node scripts/release.mjs <phase> [--version X.Y.Z] [--approved] [--dry-run]
//
// Phases (in order):
//   preflight  → review → prepare → verify → merge → publish → announce → docs-drain
//   report     → prints the whole checklist, exits non-zero if a mandatory phase
//                never completed.
//
// Why this exists: the runbook is long prose executed from memory, so steps got
// skipped silently. Here, ordering is ENFORCED — a phase refuses to run until
// its predecessors are recorded `ok` in `.omc/release/<version>.json` — and the
// final `report` turns a skipped step into a non-zero exit instead of an
// omission nobody notices.
//
// Human gates stay human: anything irreversible (merge, npm publish, the Discord
// post) refuses to run without an explicit `--approved` flag. The script never
// infers approval.
//
// Secrets: none live here. The npm token is read from $TURBOLLM_NPM_TOKEN or
// ~/.turbollm-release/npm-token at publish time (see `resolveNpmToken`).
//
// Node ≥ 22, zero dependencies, cross-platform (Windows/macOS/Linux).
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const WIN = process.platform === 'win32';
// On Windows npm is a .cmd shim, and Node ≥ 20 refuses to spawn those without a
// shell, so npm (and only npm) goes through one — with every argument quoted.
const NPM = WIN ? 'npm.cmd' : 'npm';
const PKG = 'turbollm';

// Desktop installers CI (.github/workflows/desktop-release.yml) uploads onto
// every published release. `publish` fails if the set comes back incomplete.
const DESKTOP_ASSETS = [
  'TurboLLM-Setup-x64.exe',
  'TurboLLM-x86_64.AppImage',
  'TurboLLM-arm64.dmg',
];

// ── phase table ──────────────────────────────────────────────────────────────
// `requires` is what must be `ok` before this phase may run (ordering guard).
// `mandatory` is what `report` demands before it will exit 0.
const PHASES = [
  { name: 'preflight', requires: [], mandatory: true, approval: false },
  { name: 'review', requires: ['preflight'], mandatory: true, approval: false },
  { name: 'prepare', requires: ['preflight', 'review'], mandatory: true, approval: false },
  { name: 'verify', requires: ['prepare'], mandatory: true, approval: false },
  { name: 'merge', requires: ['verify'], mandatory: true, approval: true },
  { name: 'publish', requires: ['merge'], mandatory: true, approval: true },
  { name: 'announce', requires: ['publish'], mandatory: false, approval: true },
  // Runs once CI is green (requires only `verify`, not `merge`/`publish` — a
  // different flow from the npm/desktop cycle by explicit founder direction,
  // ADR-411: local build, no Opus review gate, no `gh pr checks` of its own).
  // Optional: not every checkout has the private TurboLLM Android/ repo.
  { name: 'android', requires: ['verify'], mandatory: false, approval: true },
  { name: 'docs-drain', requires: ['publish'], mandatory: true, approval: false },
];
const PHASE_NAMES = PHASES.map((p) => p.name);

// ── tiny output helpers ──────────────────────────────────────────────────────
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);

const log = (...a) => console.log(...a);
const step = (s) => log(`${dim('·')} ${s}`);
const okLine = (s) => log(`${green('✔')} ${s}`);
const warnLine = (s) => log(`${yellow('!')} ${s}`);

class ReleaseError extends Error {}
const fail = (msg) => { throw new ReleaseError(msg); };

// ── process helpers ──────────────────────────────────────────────────────────
const shellQuote = (a) => (/[\s"&|<>^()%!]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);

function run(cmd, args, opts = {}) {
  const useShell = !!opts.shell;
  const res = spawnSync(cmd, useShell ? args.map(shellQuote) : args, {
    cwd: opts.cwd || REPO,
    encoding: 'utf8',
    env: opts.env || process.env,
    maxBuffer: 64 * 1024 * 1024,
    shell: useShell,
  });
  if (res.error) fail(`${cmd} could not be started: ${res.error.message}`);
  const stdout = (res.stdout || '').trim();
  const stderr = (res.stderr || '').trim();
  return { code: res.status ?? 1, stdout, stderr, out: [stdout, stderr].filter(Boolean).join('\n') };
}

function mustRun(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (r.code !== 0) fail(`\`${cmd} ${args.join(' ')}\` failed (exit ${r.code})\n${r.out}`);
  return r;
}

const runNpm = (args, opts = {}) => run(NPM, args, { ...opts, shell: WIN });

const git = (...args) => run('git', args);
const mustGit = (...args) => mustRun('git', args);
const gh = (...args) => run('gh', args);
const mustGh = (...args) => mustRun('gh', args);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── semver ───────────────────────────────────────────────────────────────────
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
function parseSemver(v) {
  const m = SEMVER.exec(String(v).trim().replace(/^v/, ''));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}
function cmpSemver(a, b) {
  const x = parseSemver(a); const y = parseSemver(b);
  if (!x || !y) return NaN;
  return (x.major - y.major) || (x.minor - y.minor) || (x.patch - y.patch);
}

// ── run state ────────────────────────────────────────────────────────────────
// `.omc/` is gitignored wholesale, so run state never reaches a commit.
const stateDir = () => join(REPO, '.omc', 'release');
const statePath = (version) => join(stateDir(), `${version}.json`);

function loadState(version) {
  const p = statePath(version);
  if (!existsSync(p)) {
    return { version, createdAt: new Date().toISOString(), updatedAt: null, notes: {}, phases: {} };
  }
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'));
    s.phases ||= {};
    s.notes ||= {};
    return s;
  } catch (e) {
    fail(`run state at ${p} is not readable JSON (${e.message}). Fix or delete it.`);
  }
}

function saveState(state) {
  mkdirSync(stateDir(), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(statePath(state.version), `${JSON.stringify(state, null, 2)}\n`);
}

function recordPhase(state, name, status, extra = {}) {
  const prev = state.phases[name] || {};
  state.phases[name] = {
    status,
    startedAt: prev.startedAt || new Date().toISOString(),
    finishedAt: status === 'started' ? null : new Date().toISOString(),
    ...extra,
  };
  saveState(state);
}

// Keep the last ~40 lines of a phase's output for the receipt.
const tailOf = (s, lines = 40) => String(s || '').split(/\r?\n/).slice(-lines).join('\n');

function assertOrder(state, phase) {
  const def = PHASES.find((p) => p.name === phase);
  const missing = def.requires.filter((r) => state.phases[r]?.status !== 'ok');
  if (missing.length) {
    fail(
      `phase \`${phase}\` cannot run: ${missing.map((m) => `\`${m}\``).join(', ')} `
      + `${missing.length > 1 ? 'are' : 'is'} not recorded ok in ${statePath(state.version)}.\n`
      + `Run the missing phase(s) first, or \`node scripts/release.mjs report --version ${state.version}\` to see where the run stands.`,
    );
  }
}

function requireApproval(flags, what) {
  if (!flags.approved) {
    fail(
      `${what} requires an explicit human gate: re-run with --approved.\n`
      + 'Approval is never inferred from context — a person passes this flag.',
    );
  }
}

// ── repo facts ───────────────────────────────────────────────────────────────
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const daemonPkgPath = () => join(REPO, 'turbollm', 'package.json');
const wrapperPkgPath = () => join(REPO, 'wrapper', 'package.json');

function npmLatest() {
  const r = runNpm(['view', PKG, 'version']);
  if (r.code !== 0) fail(`\`npm view ${PKG} version\` failed — npm is the source of truth for the base version, so this is blocking.\n${r.out}`);
  const v = r.stdout.split(/\r?\n/).pop().trim();
  if (!parseSemver(v)) fail(`\`npm view ${PKG} version\` returned something that is not a semver: ${JSON.stringify(v)}`);
  return v;
}

function lastTag() {
  const r = git('describe', '--tags', '--abbrev=0');
  return r.code === 0 ? r.stdout : null;
}

function currentBranch() {
  return mustGit('rev-parse', '--abbrev-ref', 'HEAD').stdout;
}

// Extract one `## [X.Y.Z]` section out of turbollm/CHANGELOG.md.
function changelogSection(version) {
  const p = join(REPO, 'turbollm', 'CHANGELOG.md');
  if (!existsSync(p)) fail('turbollm/CHANGELOG.md is missing.');
  const text = readFileSync(p, 'utf8');
  const lines = text.split(/\r?\n/);
  const head = new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\]`);
  const start = lines.findIndex((l) => head.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  const discordIdx = body.search(/^###\s+Discord\s*$/m);
  const discord = discordIdx === -1 ? null : body.slice(discordIdx).replace(/^###\s+Discord\s*$/m, '').trim();
  const notes = discordIdx === -1 ? body : body.slice(0, discordIdx).trim();
  return { body, notes, discord };
}

// ── phase: preflight ─────────────────────────────────────────────────────────
async function phasePreflight(state, flags) {
  const version = state.version;
  const problems = [];
  const out = [];
  const note = (s) => { out.push(s); step(s); };

  // 1. clean tree
  const dirty = mustGit('status', '--porcelain').stdout;
  if (dirty) problems.push(`working tree is not clean:\n${dirty}`);
  else note('working tree clean');

  // 2. on the release branch
  const branch = currentBranch();
  const expected = `release/v${version}`;
  if (branch !== expected) problems.push(`on branch \`${branch}\`, expected \`${expected}\` (RELEASE.md step 1 — the branch name carries the version)`);
  else note(`on ${expected}`);

  // 3. npm vs tag agreement; npm wins on a mismatch
  const npmV = npmLatest();
  const tag = lastTag();
  note(`npm latest: ${npmV}${tag ? `, last git tag: ${tag}` : ', no git tag found'}`);
  if (tag && tag.replace(/^v/, '') !== npmV) {
    warnLine(`tag/npm mismatch: tag ${tag} vs npm ${npmV} — npm is authoritative, the base version is ${npmV}`);
    out.push(`WARN tag/npm mismatch (tag ${tag}, npm ${npmV}); using npm`);
  }
  if (!(cmpSemver(version, npmV) > 0)) {
    problems.push(`--version ${version} is not ahead of the published ${npmV}`);
  }
  state.notes.baseVersion = npmV;

  // 4. telemetry schema-hash gate — run the SAME script CI runs, never a
  //    re-implementation of its hashing rules (it hashes the whole telemetry/
  //    tree, not just schema.ts). ADR-331: a client-first schema/Worker
  //    mismatch silently drops events at the edge with no error anywhere a
  //    human would see it — it once cost 2 days of `first_chat` data. So this
  //    is not just checked, it is FIXED here: on drift, with --approved, the
  //    script redeploys the Worker itself (same as `cd telemetry-worker &&
  //    npm run deploy` — deploys, records the hash, fires the canary that
  //    proves the live pipe accepts every real event name) rather than just
  //    telling a human to go run that command by hand. Without --approved it
  //    still only reports — a Worker deploy is production infra, so the same
  //    approval bar as merge/publish/announce applies.
  const hashScript = join(REPO, 'telemetry-worker', 'scripts', 'schema-hash.mjs');
  if (existsSync(hashScript)) {
    let h = run(process.execPath, [hashScript, 'check']);
    if (h.code !== 0) {
      if (flags.approved) {
        step('telemetry schema drifted from the deployed Worker — redeploying now (--approved)...');
        const deploy = runNpm(['run', 'deploy'], { cwd: join(REPO, 'telemetry-worker') });
        if (deploy.code !== 0) fail(`telemetry Worker deploy failed:\n${tailOf(deploy.out, 40)}`);
        note(tailOf(deploy.out, 12));
        h = run(process.execPath, [hashScript, 'check']);
        if (h.code !== 0) {
          problems.push('telemetry Worker deploy ran but the schema hash still does not match — inspect `telemetry-worker/scripts/schema-hash.mjs check` output above by hand before continuing.');
        } else {
          note('telemetry Worker redeployed — schema hash now matches (commit the updated deployed.schema.sha256 in this PR)');
        }
      } else {
        problems.push(
          'telemetry schema-hash gate is RED — the telemetry sources changed since the Worker was deployed.\n'
          + `  ${tailOf(h.out, 4).replace(/\n/g, '\n  ')}\n`
          + '  Re-run `preflight --approved` to have the script redeploy the Worker itself (this is a production infra change, so it needs the same approval as merge/publish), or run `cd telemetry-worker && npm run deploy` by hand.\n'
          + '  Client-first ordering silently drops events at the edge — this must be green BEFORE the release PR merges.',
        );
      }
    } else note('telemetry schema hash matches the deployed Worker');
  } else {
    warnLine(`${hashScript} not found — skipping the telemetry gate`);
  }

  // 5. no GitHub magic-close syntax anywhere (ADR-416)
  const magic = /\b(closes|fixes|resolves)\s+#\d+/i;
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const msgs = git('log', '--format=%B', range).stdout;
  if (magic.test(msgs)) {
    problems.push(`a commit message in ${range} contains \`Closes/Fixes/Resolves #NNN\` — GitHub executes that on merge and silently closes the reporter's issue. Reword it (\`(#NNN)\`, \`addresses #NNN\`).`);
  } else note(`no magic-close syntax in commit messages (${range})`);

  const pr = findPr(state, flags, { optional: true });
  if (pr) {
    const body = gh('pr', 'view', String(pr), '--json', 'body', '-q', '.body').stdout;
    if (magic.test(body)) {
      problems.push(`PR #${pr}'s body contains \`Closes/Fixes/Resolves #NNN\` — edit it out before merging (\`gh pr edit ${pr} --body ...\`).`);
    } else note(`PR #${pr} body is free of magic-close syntax`);
  } else {
    warnLine('no PR resolved yet — re-run preflight after `gh pr create`, or pass --pr <N>, to get the PR body checked');
    out.push('WARN PR body not checked (no PR resolved)');
  }

  if (problems.length) fail(`preflight found ${problems.length} blocking problem(s):\n\n- ${problems.join('\n\n- ')}`);
  return out.join('\n');
}

// ── phase: review (recorded, not performed — the reviewer is an Opus agent) ───
async function phaseReview(state, flags) {
  if (!flags.verdict) {
    fail(
      'the Opus code-review gate is recorded here, not performed here.\n'
      + 'Run the review (RELEASE.md step 2), then record its outcome:\n'
      + `  node scripts/release.mjs review --version ${state.version} --verdict "<what the reviewer found / that it is clear to proceed>"`,
    );
  }
  state.notes.reviewVerdict = flags.verdict;
  saveState(state);
  return `review verdict recorded:\n${flags.verdict}`;
}

// ── phase: prepare ───────────────────────────────────────────────────────────
async function phasePrepare(state, flags) {
  const version = state.version;
  const out = [];
  const note = (s) => { out.push(s); step(s); };

  const base = state.notes.baseVersion || npmLatest();
  note(`base version from npm: ${base} → releasing ${version}`);

  // package.json (+ wrapper in lockstep: the desktop app compares its OWN version
  // against the published release, so a drifted wrapper believes it is ahead)
  for (const p of [daemonPkgPath(), wrapperPkgPath()]) {
    if (!existsSync(p)) { warnLine(`${p} not present — skipping`); continue; }
    const raw = readFileSync(p, 'utf8');
    const next = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
    if (next === raw && !new RegExp(`"version"\\s*:\\s*"${version.replace(/\./g, '\\.')}"`).test(raw)) {
      fail(`could not rewrite the "version" field in ${p}`);
    }
    if (next !== raw) writeFileSync(p, next);
    note(`${p.replace(REPO, '.')} → ${version}`);
  }

  // changelog gate — the AI writes it, the script refuses to continue without it
  const section = changelogSection(version);
  if (!section || !section.notes) {
    fail(
      `turbollm/CHANGELOG.md has no non-empty \`## [${version}]\` section.\n`
      + 'Move `## [Unreleased]` into a dated section first (RELEASE.md step 4d), leaving `_Nothing yet._` behind.',
    );
  }
  if (!section.discord) {
    fail(
      `the \`## [${version}]\` changelog section has no non-empty \`### Discord\` subsection.\n`
      + 'Step 10 posts that subsection verbatim; write 2–4 user-facing bullets before continuing.',
    );
  }
  note('changelog section + ### Discord subsection present');

  // README mirror (canonical is turbollm/README.md; root is a byte-identical copy)
  const canonical = join(REPO, 'turbollm', 'README.md');
  const mirror = join(REPO, 'README.md');
  if (existsSync(canonical)) {
    const a = readFileSync(canonical);
    if (!existsSync(mirror) || !readFileSync(mirror).equals(a)) {
      writeFileSync(mirror, a);
      note('root README.md regenerated from turbollm/README.md');
    } else note('root README.md already byte-identical');
    if (!readFileSync(mirror).equals(readFileSync(canonical))) fail('README mirror still differs after regeneration');
  }

  // web bundle — the persona KB and every UI change get baked into src/webdist here
  if (flags['dry-run']) {
    note('[dry-run] skipped `npm --prefix turbollm/web run build`');
  } else {
    step('building the web bundle (npm --prefix turbollm/web run build)…');
    const b = runNpm(['--prefix', 'turbollm/web', 'run', 'build']);
    if (b.code !== 0) fail(`web build failed:\n${tailOf(b.out, 60)}`);
    note('web bundle built');
  }

  // commit + push
  const dirty = mustGit('status', '--porcelain').stdout;
  if (!dirty) {
    note('nothing to commit — prepare is already applied (idempotent re-run)');
  } else if (flags['dry-run']) {
    note(`[dry-run] would commit + push:\n${dirty}`);
  } else {
    mustGit('add', '-A');
    // No Co-Authored-By / AI attribution, ever (CLAUDE.md hard rule 1).
    const subject = `chore(release): v${version}${flags.summary ? ` — ${flags.summary}` : ''}`;
    mustGit('commit', '-m', subject);
    mustGit('push');
    note(`committed + pushed \`${subject}\``);
  }

  return out.join('\n');
}

// ── phase: verify (CI on the PR) ─────────────────────────────────────────────
const RUNNER_INFRA = /not acquired by Runner|runner of type|infrastructure fail/i;

function findPr(state, flags, { optional = false } = {}) {
  if (flags.pr) { state.notes.pr = Number(flags.pr); return Number(flags.pr); }
  if (state.notes.pr) return state.notes.pr;
  const r = gh('pr', 'view', '--json', 'number', '-q', '.number');
  if (r.code === 0 && /^\d+$/.test(r.stdout)) {
    state.notes.pr = Number(r.stdout);
    return state.notes.pr;
  }
  if (optional) return null;
  fail('could not resolve the release PR — pass --pr <N> (or run from the release branch after `gh pr create`).');
}

async function phaseVerify(state, flags) {
  const pr = findPr(state, flags);
  const out = [];
  step(`checking CI on PR #${pr}…`);

  let checks = gh('pr', 'checks', String(pr));
  out.push(tailOf(checks.out, 30));
  if (checks.code !== 0 && RUNNER_INFRA.test(checks.out)) {
    warnLine('runner-acquisition/infra failure — re-running the failed jobs once (the documented one-shot retry)');
    const runId = latestPrRunId(pr);
    if (runId) {
      gh('run', 'rerun', String(runId), '--failed');
      await waitForRun(runId, 25 * 60_000);
      checks = gh('pr', 'checks', String(pr));
      out.push('--- after one-shot rerun ---');
      out.push(tailOf(checks.out, 30));
    }
  }
  if (checks.code !== 0) {
    fail(
      `CI is not green on PR #${pr}. This is release-blocking — fix and push, then re-run \`verify\`.\n${tailOf(checks.out, 40)}`,
    );
  }
  okLine(`CI green on PR #${pr}`);
  saveState(state);
  return out.join('\n');
}

function latestPrRunId(pr) {
  const headRef = gh('pr', 'view', String(pr), '--json', 'headRefName', '-q', '.headRefName').stdout;
  if (!headRef) return null;
  const r = gh('run', 'list', '--branch', headRef, '--limit', '1', '--json', 'databaseId', '-q', '.[0].databaseId');
  return /^\d+$/.test(r.stdout) ? Number(r.stdout) : null;
}

async function waitForRun(runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = gh('run', 'view', String(runId), '--json', 'status,conclusion', '-q', '.status + " " + (.conclusion // "")');
    const [status, conclusion] = r.stdout.split(/\s+/);
    if (status === 'completed') return conclusion || 'unknown';
    if (Date.now() > deadline) return 'timed_out';
    await sleep(20_000);
  }
}

// ── phase: merge (gated) ─────────────────────────────────────────────────────
async function phaseMerge(state, flags) {
  requireApproval(flags, 'merging the release PR to main');
  if (!state.notes.reviewVerdict) fail('no Opus review verdict recorded — run the `review` phase first.');
  const version = state.version;
  const pr = findPr(state, flags);
  const branch = `release/v${version}`;
  const out = [];

  if (flags['dry-run']) {
    return `[dry-run] would: gh pr merge ${pr} --merge --admin; delete ${branch} local+remote; poll the post-merge main run`;
  }

  step(`merging PR #${pr}…`);
  let m = gh('pr', 'merge', String(pr), '--merge');
  if (m.code !== 0 && /BLOCKED|review|approv|not mergeable|branch policy/i.test(m.out)) {
    // Branch protection wants a review, GitHub forbids self-approval, and every
    // release PR is self-authored. --admin overrides THAT and nothing else —
    // `verify` already proved CI green.
    warnLine('merge blocked by the self-approval rule — retrying with --admin (CI was already verified green)');
    m = gh('pr', 'merge', String(pr), '--merge', '--admin');
  }
  if (m.code !== 0) fail(`merge failed:\n${tailOf(m.out, 30)}`);
  out.push(`merged PR #${pr}`);
  okLine(`merged PR #${pr}`);

  mustGit('checkout', 'main');
  mustGit('pull');
  const del = git('branch', '-d', branch);
  out.push(del.code === 0 ? `deleted local ${branch}` : `local ${branch}: ${del.out}`);
  const delRemote = git('push', 'origin', '--delete', branch);
  out.push(delRemote.code === 0 ? `deleted remote ${branch}` : `remote ${branch}: ${delRemote.out}`);

  step('polling the post-merge main run…');
  const idRes = gh('run', 'list', '--branch', 'main', '--limit', '1', '--json', 'databaseId', '-q', '.[0].databaseId');
  if (!/^\d+$/.test(idRes.stdout)) {
    warnLine('could not find the post-merge main run — check it by hand before publishing');
    out.push('WARN post-merge main run not found');
    return out.join('\n');
  }
  const runId = Number(idRes.stdout);
  let conclusion = await waitForRun(runId, 30 * 60_000);
  if (conclusion !== 'success') {
    const view = gh('run', 'view', String(runId), '--log-failed');
    if (RUNNER_INFRA.test(view.out)) {
      warnLine('post-merge run failed on runner acquisition — one re-run, as documented');
      gh('run', 'rerun', String(runId), '--failed');
      conclusion = await waitForRun(runId, 30 * 60_000);
    }
  }
  if (conclusion !== 'success') {
    fail(
      `the post-merge run on main concluded \`${conclusion}\`. A red main is a broken main — STOP.\n`
      + `Do not tag or publish on top of it. \`gh run view ${runId} --log-failed\`.`,
    );
  }
  out.push(`post-merge main run ${runId}: success`);
  okLine(`post-merge main run ${runId} green`);
  return out.join('\n');
}

// ── npm token plumbing (A.4) ─────────────────────────────────────────────────
// The token is a granular automation token scoped to the `turbollm` package.
// The FOUNDER creates it at npmjs.com — this script only ever consumes one that
// already exists on disk or in the environment.
const TOKEN_FILE = () => join(homedir(), '.turbollm-release', 'npm-token');

// OIDC trusted publishing (npm-publish.yml) is the primary path — see phasePublish.
// This local-token path only exists as a bridge/fallback: a release whose GitHub
// Release predates npm-publish.yml, or a one-off manual re-run. npm deprecates
// direct-publish for 2FA-bypass tokens around January 2027, so this is not meant
// to become the steady-state mechanism — pass {optional:true} to check without
// failing when there's nothing to fall back to.
function resolveNpmToken(opts = {}) {
  const env = (process.env.TURBOLLM_NPM_TOKEN || '').trim();
  if (env) return { token: env, source: 'env TURBOLLM_NPM_TOKEN' };
  const f = TOKEN_FILE();
  if (existsSync(f)) {
    const t = readFileSync(f, 'utf8').trim();
    if (t) return { token: t, source: f };
  }
  if (opts.optional) return null;
  fail(
    'no npm token found, and no npm-publish.yml OIDC run to fall back on.\n'
    + `Expected $TURBOLLM_NPM_TOKEN or a token file at ${f} (mode 600).\n\n`
    + 'The token has to be created by a human in the npmjs.com UI — this script cannot create credentials:\n'
    + '  npmjs.com → avatar → Access Tokens → Generate New Token → Granular Access Token\n'
    + `  · Packages: only \`${PKG}\` · Permissions: Read and write · Expiry: 90 days\n`
    + '  Docs: https://docs.npmjs.com/creating-and-viewing-access-tokens\n'
    + 'Never commit it, never put it in an .npmrc git can see.\n'
    + '(Prefer setting up the npm-publish.yml Trusted Publisher instead — see docs/RELEASE.md.)',
  );
}

// Publish with a throwaway userconfig so the token never lands in a persistent
// .npmrc. Always removed in the finally.
function npmPublishWithToken(token, { dryRun }) {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-npmrc-'));
  const rc = join(dir, '.npmrc');
  try {
    writeFileSync(rc, `//registry.npmjs.org/:_authToken=${token}\nregistry=https://registry.npmjs.org/\n`, { mode: 0o600 });

    const who = runNpm(['whoami', '--userconfig', rc]);
    if (who.code !== 0) fail(`\`npm whoami\` failed with the supplied token — it may be expired or wrong-scoped.\n${who.out}`);
    okLine(`publishing as npm user: ${bold(who.stdout)}`);

    const args = ['publish', '--userconfig', rc];
    if (dryRun) args.push('--dry-run');
    const p = runNpm(args, { cwd: join(REPO, 'turbollm') });
    if (p.code !== 0) fail(`npm publish failed:\n${tailOf(p.out, 60)}`);
    return { whoami: who.stdout, out: tailOf(p.out, 30) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pollNpmVersion(version, timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = runNpm(['view', PKG, 'version']);
    const live = r.code === 0 ? r.stdout.split(/\r?\n/).pop().trim() : '';
    if (live === version) return true;
    if (Date.now() > deadline) {
      fail(`npm accepted the upload but \`npm view ${PKG} version\` still reports \`${live || 'unknown'}\` after ${Math.round(timeoutMs / 1000)}s. A 200 from the registry is not proof it went live — check manually before announcing.`);
    }
    step(`npm still reports ${live || '?'}, waiting for ${version}…`);
    await sleep(15_000);
  }
}

// ── phase: publish (gated) ───────────────────────────────────────────────────
async function phasePublish(state, flags) {
  const version = state.version;
  const tag = `v${version}`;
  const out = [];
  const note = (s) => { out.push(s); step(s); };

  const section = changelogSection(version);
  if (!section) fail(`no \`## [${version}]\` section in turbollm/CHANGELOG.md to use as release notes.`);

  const onDisk = readJson(daemonPkgPath()).version;
  if (onDisk !== version) fail(`turbollm/package.json says ${onDisk}, releasing ${version} — run \`prepare\` first.`);

  // tag (idempotent)
  if (git('rev-parse', '-q', '--verify', `refs/tags/${tag}`).code === 0) {
    note(`tag ${tag} already exists locally`);
  } else if (flags['dry-run']) {
    note(`[dry-run] would create tag ${tag}`);
  } else {
    mustGit('tag', tag);
    note(`tagged ${tag}`);
  }
  if (!flags['dry-run']) {
    const push = git('push', 'origin', tag);
    note(push.code === 0 ? `pushed ${tag}` : `push ${tag}: ${tailOf(push.out, 5)}`);
  }

  // GitHub release (idempotent) — publishing it is what triggers desktop-release.yml
  const exists = gh('release', 'view', tag, '--json', 'tagName').code === 0;
  if (exists) {
    note(`GitHub release ${tag} already exists`);
  } else if (flags['dry-run']) {
    note(`[dry-run] would \`gh release create ${tag}\` with the changelog section`);
  } else {
    const notesFile = join(mkdtempSync(join(tmpdir(), 'turbollm-notes-')), 'notes.md');
    writeFileSync(notesFile, `${section.notes}\n`);
    try {
      mustGh('release', 'create', tag, '--title', tag, '--notes-file', notesFile);
    } finally {
      rmSync(dirname(notesFile), { recursive: true, force: true });
    }
    note(`created GitHub release ${tag}`);
  }

  // npm publish — the irreversible bit. OIDC trusted publishing (npm-publish.yml,
  // triggered by the `release: published` event above) does the actual `npm
  // publish` inside GitHub Actions — no stored token, nothing here to leak. This
  // phase just confirms that workflow ran and the version actually landed;
  // `npm view` is the only thing that counts as proof, same as before.
  const live = npmLatest();
  if (live === version) {
    note(`npm already has ${version} — publish is idempotent, skipping`);
  } else if (flags['dry-run']) {
    note(`[dry-run] would wait for npm-publish.yml on ${tag}, then poll npm view ${PKG} version`);
  } else {
    requireApproval(flags, `publishing ${PKG}@${version} to npm (via npm-publish.yml / OIDC)`);
    // A GitHub Release that already existed BEFORE npm-publish.yml was added
    // (or a rerun) won't have fired the `release: published` event for it —
    // legacyToken() is the local fallback for that one-off case only.
    const legacy = resolveNpmToken({ optional: true });
    if (legacy) {
      warnLine(`falling back to the local token (${legacy.source}) — npm-publish.yml did not pick up this release, or you're re-running after it was added later`);
      const res = npmPublishWithToken(legacy.token, { dryRun: false });
      note(`npm publish (legacy token path) as ${res.whoami}`);
    } else {
      note('waiting for the npm-publish.yml workflow (OIDC trusted publishing)…');
      const runId = await waitForWorkflowRun('npm-publish.yml', tag, 5 * 60_000);
      if (runId == null) {
        fail(
          `no npm-publish.yml run found for ${tag} after 5 minutes.\n`
          + `  Either it hasn't started yet (check https://github.com/mohitsoni48/TurboLLM/actions/workflows/npm-publish.yml),\n`
          + `  or the Trusted Publisher isn't configured yet on npmjs.com (package turbollm → Settings → Trusted Publisher → GitHub Actions → this repo + npm-publish.yml).\n`
          + `  You can also dispatch it manually: \`gh workflow run npm-publish.yml -f tag=${tag}\`.`,
        );
      }
      const conclusion = await waitForRun(runId, 10 * 60_000);
      if (conclusion !== 'success') {
        fail(`npm-publish.yml run ${runId} did not succeed (${conclusion}) — check https://github.com/mohitsoni48/TurboLLM/actions/runs/${runId}`);
      }
      note(`npm-publish.yml run ${runId} succeeded`);
    }
    await pollNpmVersion(version);
    note(`npm view ${PKG} version == ${version}`);
    okLine(`${PKG}@${version} is live on npm`);
  }

  // desktop installers — CI builds them on `release: published`; verify the set
  if (!flags['dry-run']) {
    const assets = await waitForDesktopAssets(tag, flags['skip-desktop'] ? 0 : 20 * 60_000);
    if (assets.missing.length) {
      const msg = `desktop assets missing from release ${tag}: ${assets.missing.join(', ')} (present: ${assets.present.join(', ') || 'none'})`;
      if (flags['skip-desktop']) { warnLine(msg); out.push(`WARN ${msg}`); } else {
        fail(`${msg}\nCheck the "Desktop release" workflow run for ${tag}. If Actions is down, build locally (see RELEASE.md's manual fallback) and \`gh release upload ${tag} <file> --clobber\`, then re-run with --skip-desktop to record the phase.`);
      }
    } else {
      note(`desktop assets present: ${assets.present.join(', ')}`);
    }
  }

  return out.join('\n');
}

// Finds the most recent run of a given workflow file whose event was `release`
// (or `workflow_dispatch`, for a manual re-run) and that started after `tag`'s
// GitHub Release was created — so an unrelated older run for the same workflow
// file never gets mistaken for this release's run. Returns the run id, or null
// if none shows up before the timeout (e.g. the Trusted Publisher isn't
// configured yet, so the workflow never got dispatched to begin with).
async function waitForWorkflowRun(workflowFile, tag, timeoutMs) {
  const releaseAt = gh('release', 'view', tag, '--json', 'createdAt', '-q', '.createdAt').stdout;
  const since = releaseAt ? Date.parse(releaseAt) : 0;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = gh(
      'run', 'list', '--workflow', workflowFile, '--limit', '5',
      '--json', 'databaseId,event,createdAt',
    );
    if (r.code === 0) {
      try {
        const runs = JSON.parse(r.stdout || '[]');
        // 60s clock-skew grace on the lower bound only.
        const match = runs.find((x) =>
          (x.event === 'release' || x.event === 'workflow_dispatch')
          && Date.parse(x.createdAt) >= since - 60_000);
        if (match) return match.databaseId;
      } catch { /* fall through to retry */ }
    }
    if (Date.now() > deadline) return null;
    step(`waiting for ${workflowFile} to start for ${tag}…`);
    await sleep(15_000);
  }
}

async function waitForDesktopAssets(tag, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = gh('release', 'view', tag, '--json', 'assets', '-q', '.assets[].name');
    const present = r.code === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    const missing = DESKTOP_ASSETS.filter((a) => !present.includes(a));
    if (!missing.length || Date.now() > deadline) {
      return { present: present.filter((p) => DESKTOP_ASSETS.includes(p)), missing };
    }
    step(`waiting for CI-built installers (${missing.join(', ')} still missing)…`);
    await sleep(30_000);
  }
}

// ── phase: android (optional, gated) ─────────────────────────────────────────
// Mirrors docs/RELEASE.md's Android section exactly — same commands, same
// order. Different flow from the npm/desktop cycle by explicit founder
// direction (ADR-411): local build, no CI of its own, no Opus review gate.
// `requires: ['verify']` (not merge/publish) is the "runs once CI is green"
// placement — it does not wait on the npm publish, since the two ship
// independently. Gated behind --approved: publishReleaseBundle/promote hit
// the real Play Console the moment they run — same bar as npm publish.
const ANDROID_DIR = () => join(REPO, 'TurboLLM Android');
const GRADLEW = WIN ? 'gradlew.bat' : './gradlew';

async function phaseAndroid(state, flags) {
  const dir = ANDROID_DIR();
  const out = [];
  const note = (s) => { out.push(s); step(s); };

  if (!existsSync(dir)) {
    warnLine(`"${dir}" not found — skipping (this checkout doesn't have the private Android repo)`);
    return 'skipped: TurboLLM Android/ not present in this checkout';
  }
  if (!existsSync(join(dir, GRADLEW))) {
    warnLine(`${GRADLEW} not found in "${dir}" — skipping`);
    return `skipped: ${GRADLEW} not present`;
  }

  if (!flags['dry-run']) {
    requireApproval(flags, 'publishing the Android app to Play Console (internal + alpha + beta, real users)');
  }

  const vulkan = !flags['skip-vulkan-engine'];
  const vulkanFlag = vulkan ? ['-PturbollmVulkanEngine=true'] : [];

  // 1. Vulkan engine — only buildable inside WSL2/Linux (docs/RELEASE.md
  //    Android §2). A founder running this from plain Windows PowerShell is
  //    a real, expected case — warn and ship CPU-only rather than fail, same
  //    as the runbook's own guidance.
  if (vulkan) {
    if (WIN) {
      warnLine(
        'Windows host — the Vulkan engine step needs WSL2. Run `bash "TurboLLM Android/scripts/build-vulkan-engine.sh"` '
        + 'and `stage-vulkan-engine.sh` there first, or pass --skip-vulkan-engine to ship CPU-only on purpose.',
      );
      out.push('WARN vulkan engine not built from this host — ships whatever .so (if any) is already staged, or CPU-only');
    } else if (flags['dry-run']) {
      note('[dry-run] would build + stage the Vulkan engine');
    } else {
      step('building + staging the Vulkan engine (WSL2/Linux)…');
      mustRun('bash', [join(dir, 'scripts', 'build-vulkan-engine.sh')], { cwd: dir });
      mustRun('bash', [join(dir, 'scripts', 'stage-vulkan-engine.sh')], { cwd: dir });
      note('Vulkan engine built + staged');
    }
  } else {
    note('--skip-vulkan-engine passed — building CPU-only on purpose');
  }

  if (flags['dry-run']) {
    return `${out.join('\n')}\n[dry-run] would: bundleRelease, publishReleaseBundle → internal, promote → alpha + beta, publishReleaseListing`;
  }

  // 2. Signed release bundle (signing + service-account creds already wired
  //    through the gitignored local.properties — no extra setup here).
  step('building the signed release bundle…');
  mustRun(GRADLEW, ['bundleRelease', ...vulkanFlag], { cwd: dir });
  note('release bundle built (composeApp-release.aab)');

  // 3. Upload once to internal (cheapest, always accepts a fresh version
  //    code), then PROMOTE that same version code — never re-run
  //    publishReleaseBundle per track (Play's version code is strictly
  //    increasing across every track combined, not per-track; ADR-412).
  step('uploading to Play Console (track: internal)…');
  mustRun(GRADLEW, ['publishReleaseBundle', ...vulkanFlag, '-PturbollmPlayTrack=internal'], { cwd: dir });
  note('uploaded to internal');

  for (const track of ['alpha', 'beta']) {
    step(`promoting internal → ${track}…`);
    mustRun(GRADLEW, ['promoteReleaseArtifact', '--from-track', 'internal', '--promote-track', track], { cwd: dir });
    note(`promoted to ${track}`);
  }

  // 4. Store listing — fully automated (ADR-413), reads play-store-assets/
  //    every run, so it always matches whatever that currently says.
  step('syncing the store listing (publishReleaseListing)…');
  mustRun(GRADLEW, ['publishReleaseListing'], { cwd: dir });
  note('store listing synced');

  okLine('Android release published (internal + alpha + beta), listing synced');
  return out.join('\n');
}

// ── phase: announce ──────────────────────────────────────────────────────────
// Dry-run by default; posting needs --approved. The helper is local-only
// (docs/ is gitignored from this repo), so its absence is not fatal in a fresh
// clone — it is only fatal when actually asked to post.
async function phaseAnnounce(state, flags) {
  const version = state.version;
  const helper = join(REPO, 'docs', 'scripts', 'announce-discord.mjs');
  const post = !!flags.approved && !flags['dry-run'];
  if (!existsSync(helper)) {
    const msg = `Discord helper not found at ${helper} (docs/ is local-only).`;
    if (post) fail(msg);
    warnLine(`${msg} Recording announce as a dry-run.`);
    return `SKIPPED post — ${msg}`;
  }
  const args = [helper, `v${version}`];
  if (!post) args.push('--dry-run');
  const r = run(process.execPath, args);
  if (r.code !== 0) fail(`announce-discord.mjs failed:\n${tailOf(r.out, 40)}`);
  log(r.out);
  if (!post) {
    warnLine('dry-run only — nothing posted. Re-run with --approved once the exact text is signed off.');
    return `dry-run preview:\n${tailOf(r.out, 30)}`;
  }
  okLine('posted to Discord');
  return `posted:\n${tailOf(r.out, 30)}`;
}

// ── phase: docs-drain ────────────────────────────────────────────────────────
// The docs live in a separate, local-only git. The script validates the outcome
// rather than writing prose: the top of docs/CHANGELOG.md must be this version,
// and docs/TODO.md must not still describe it as open work.
async function phaseDocsDrain(state) {
  const version = state.version;
  const out = [];
  const problems = [];

  const cl = join(REPO, 'docs', 'CHANGELOG.md');
  if (!existsSync(cl)) {
    warnLine(`${cl} not present (docs/ is local-only) — nothing to validate here.`);
    return 'docs/ not present in this checkout — validation skipped';
  }
  const first = readFileSync(cl, 'utf8').split(/\r?\n/).find((l) => /^##\s+v?\d+\.\d+\.\d+/.test(l));
  if (!first) problems.push('docs/CHANGELOG.md has no `## vX.Y.Z` section at all');
  else if (!first.includes(version)) problems.push(`docs/CHANGELOG.md's newest section is \`${first.trim()}\` — expected one for v${version}. Add it (newest first) before calling the release done.`);
  else out.push(`docs/CHANGELOG.md top section is v${version}`);

  const todo = join(REPO, 'docs', 'TODO.md');
  if (existsSync(todo)) {
    const hits = readFileSync(todo, 'utf8').split(/\r?\n/)
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => l.includes(version));
    if (hits.length) {
      warnLine(`docs/TODO.md still mentions ${version} on ${hits.length} line(s) — shipped work must not remain in TODO.md:`);
      for (const [n, l] of hits) log(dim(`    TODO.md:${n}: ${l.trim()}`));
      out.push(`WARN docs/TODO.md mentions ${version} on lines ${hits.map(([n]) => n).join(', ')}`);
    } else out.push('docs/TODO.md has no lines naming this version');
  }

  if (problems.length) fail(`docs drain incomplete:\n- ${problems.join('\n- ')}`);
  return out.join('\n');
}

// ── report ───────────────────────────────────────────────────────────────────
function phaseReport(state) {
  const icon = { ok: green('✅'), failed: red('❌'), skipped: yellow('⏭️'), started: yellow('⏳') };
  log('');
  log(bold(`Release receipt — v${state.version}`));
  log(dim(statePath(state.version)));
  log('');
  const missing = [];
  for (const p of PHASES) {
    const rec = state.phases[p.name];
    const status = rec?.status;
    const mark = status ? (icon[status] || '?') : dim('⬜');
    const when = rec?.finishedAt ? dim(` ${rec.finishedAt}`) : '';
    const req = p.mandatory ? '' : dim(' (optional)');
    log(`  ${mark} ${p.name.padEnd(11)}${req}${when}`);
    if (rec?.tail) for (const l of String(rec.tail).split('\n').slice(-4)) log(dim(`        ${l}`));
    if (p.mandatory && status !== 'ok') missing.push(`${p.name} (${status || 'never ran'})`);
  }
  log('');
  if (state.notes.pr) log(dim(`  PR: #${state.notes.pr}`));
  if (state.notes.reviewVerdict) log(dim(`  review: ${String(state.notes.reviewVerdict).split('\n')[0].slice(0, 100)}`));
  log('');
  if (missing.length) {
    log(red(`INCOMPLETE — mandatory phase(s) not ok: ${missing.join(', ')}`));
    return 1;
  }
  log(green(`COMPLETE — every mandatory phase for v${state.version} is recorded ok.`));
  return 0;
}

// ── driver ───────────────────────────────────────────────────────────────────
const RUNNERS = {
  preflight: phasePreflight,
  review: phaseReview,
  prepare: phasePrepare,
  verify: phaseVerify,
  merge: phaseMerge,
  publish: phasePublish,
  android: phaseAndroid,
  announce: phaseAnnounce,
  'docs-drain': phaseDocsDrain,
};

const USAGE = `TurboLLM release driver — see docs/RELEASE.md

  node scripts/release.mjs <phase> [options]

Phases, in order:
  preflight    clean tree · on release/vX.Y.Z · npm-vs-tag · telemetry hash gate · no Closes #NNN
  review       record the Opus code-review verdict (--verdict "…")
  prepare      version bump (daemon + wrapper) · changelog gate · README mirror · web build · commit + push
  verify       gh pr checks, with the one-shot rerun on a runner-acquisition failure
  merge        gh pr merge --admin · delete the branch · poll the post-merge main run   [--approved]
  publish      tag · gh release create · wait for npm-publish.yml (OIDC) or fall back to token · poll npm view · check CI installers  [--approved]
  android      optional: TurboLLM Android/ — Vulkan build (WSL2) · bundleRelease · publish internal → promote alpha+beta · sync listing  [--approved]
  announce     Discord post — --dry-run by default, posting needs --approved
  docs-drain   validate docs/CHANGELOG.md top == this version and TODO.md is drained
  report       print the receipt; exits non-zero if a mandatory phase never completed

Options:
  --version X.Y.Z   the version being released (required unless it is already the only run in .omc/release)
  --approved        the human gate for merge / npm publish / Android publish / the Discord post — never inferred
  --dry-run         do everything read-only that can be; print what would happen for the rest
  --pr <N>          the release PR number (otherwise resolved from the current branch)
  --verdict "…"     review only: the recorded review outcome
  --skip-vulkan-engine   android only: ship CPU-only on purpose instead of building the WSL2 Vulkan engine
  --summary "…"     prepare only: the one-line summary in the release commit message
  --skip-desktop    publish only: warn instead of failing when CI installers are missing
  --resume          re-run a phase already recorded ok (otherwise it is reported and skipped)
`;

function resolveVersion(flags) {
  if (flags.version) {
    const v = String(flags.version).replace(/^v/, '');
    if (!parseSemver(v)) fail(`--version ${flags.version} is not X.Y.Z`);
    return v;
  }
  // fall back to the release branch name, then to a single existing run state
  const b = git('rev-parse', '--abbrev-ref', 'HEAD').stdout;
  const m = /^release\/v(\d+\.\d+\.\d+)$/.exec(b);
  if (m) return m[1];
  fail('no --version given, and the current branch is not `release/vX.Y.Z`. Pass --version X.Y.Z (the script never guesses the bump).');
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        version: { type: 'string' },
        approved: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        resume: { type: 'boolean', default: false },
        'skip-desktop': { type: 'boolean', default: false },
        'skip-vulkan-engine': { type: 'boolean', default: false },
        pr: { type: 'string' },
        verdict: { type: 'string' },
        summary: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (e) {
    log(USAGE);
    fail(e.message);
  }

  const phase = parsed.positionals[0];
  const flags = parsed.values;
  if (!phase || flags.help) { log(USAGE); return phase ? 0 : 1; }
  if (phase !== 'report' && !PHASE_NAMES.includes(phase)) {
    log(USAGE);
    fail(`unknown phase \`${phase}\`. Known: ${[...PHASE_NAMES, 'report'].join(', ')}`);
  }

  const version = resolveVersion(flags);
  const state = loadState(version);

  if (phase === 'report') return phaseReport(state);

  if (state.phases[phase]?.status === 'ok' && !flags.resume) {
    okLine(`phase \`${phase}\` is already recorded ok for v${version} — nothing to do (pass --resume to force a re-run).`);
    return 0;
  }

  assertOrder(state, phase);

  log(bold(`\n▸ ${phase}  ·  v${version}${flags['dry-run'] ? dim('  [dry-run]') : ''}`));
  recordPhase(state, phase, 'started');
  try {
    const tail = await RUNNERS[phase](state, flags);
    recordPhase(state, phase, 'ok', { tail: tailOf(tail), dryRun: !!flags['dry-run'] });
    okLine(`phase \`${phase}\` ok`);
    return 0;
  } catch (e) {
    recordPhase(state, phase, 'failed', { tail: tailOf(e.message) });
    throw e;
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    log('');
    log(red(err instanceof ReleaseError ? `✖ ${err.message}` : `✖ ${err.stack || err.message}`));
    process.exit(1);
  },
);
