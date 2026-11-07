// Tests for the release driver's guards — the four failures v1.13.6 hit.
//   node --test scripts/release.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INDEPENDENT_PATHS,
  PREPARE_PATHS,
  alreadyRecordedOk,
  androidEngineProblem,
  assertOrder,
  isCliEntry,
  magicCloseCommits,
  localPublishProblem,
  splitDirtyPaths,
  splitPreflightDirty,
  stageReleasePaths,
  syncMainFastForward,
  waitForCommitRun,
  waitForWorkflowRun,
} from './release.mjs';

const RELEASE_URL = new URL('./release.mjs', import.meta.url).href;

const gitIn = (cwd) => (...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  return { code: r.status ?? 1, stdout, stderr, out: [stdout, stderr].filter(Boolean).join('\n') };
};

function must(g, ...args) {
  const r = g(...args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}):\n${r.out}`);
  return r;
}

function put(root, rel, body) {
  const p = join(root, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
}

function identify(g) {
  must(g, 'config', 'user.email', 'release-test@example.invalid');
  must(g, 'config', 'user.name', 'release test');
  must(g, 'config', 'commit.gpgsign', 'false');
  must(g, 'config', 'pull.rebase', 'true');
}

// A bare origin plus a clone of it, seeded with one release-owned file and one
// file no release has any business touching.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'turbollm-release-test-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const outside = gitIn(root);
  must(outside, 'init', '--bare', '--initial-branch=main', origin);
  must(outside, 'clone', origin, work);
  const g = gitIn(work);
  identify(g);
  put(work, 'turbollm/package.json', '{\n  "version": "1.0.0"\n}\n');
  put(work, 'signup-worker/index.ts', 'export const a = 1;\n');
  must(g, 'add', '-A');
  must(g, 'commit', '-m', 'init');
  must(g, 'push', '-u', 'origin', 'main');
  return { root, origin, work, g, outside };
}

function upstreamCommit(s, rel, body) {
  const other = join(s.root, `other-${Math.random().toString(36).slice(2, 8)}`);
  must(s.outside, 'clone', s.origin, other);
  const o = gitIn(other);
  identify(o);
  put(other, rel, body);
  must(o, 'add', '-A');
  must(o, 'commit', '-m', `upstream ${rel}`);
  must(o, 'push');
  return must(o, 'rev-parse', 'HEAD').stdout;
}

const cleanup = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 5 });

test('ff-only sync fast-forwards main and leaves an unrelated dirty file alone', () => {
  const s = sandbox();
  try {
    const upstream = upstreamCommit(s, 'turbollm/CHANGELOG.md', '## [1.0.1]\n');
    put(s.work, 'signup-worker/index.ts', 'export const a = 2;\n');

    // the old `git pull` is what broke: rebase mode refuses ANY dirty tree
    assert.notEqual(s.g('pull').code, 0, 'plain `git pull` should refuse the dirty tree');

    const notes = syncMainFastForward(s.g).join('\n');

    assert.equal(must(s.g, 'rev-parse', 'HEAD').stdout, upstream);
    assert.match(notes, /origin\/main/);
    assert.equal(readFileSync(join(s.work, 'signup-worker', 'index.ts'), 'utf8'), 'export const a = 2;\n');
    assert.match(must(s.g, 'status', '--porcelain').stdout, /signup-worker\/index\.ts/);
  } finally {
    cleanup(s.root);
  }
});

test('ff-only sync fails loudly when main cannot fast-forward', () => {
  const s = sandbox();
  try {
    upstreamCommit(s, 'turbollm/CHANGELOG.md', '## [1.0.1]\n');
    put(s.work, 'local-only.txt', 'diverged\n');
    must(s.g, 'add', '-A');
    must(s.g, 'commit', '-m', 'local divergence');

    assert.throws(() => syncMainFastForward(s.g), /fast-forward/i);
  } finally {
    cleanup(s.root);
  }
});

test('prepare stages release files and never an unrelated dirty file', () => {
  const s = sandbox();
  try {
    put(s.work, 'turbollm/package.json', '{\n  "version": "1.0.1"\n}\n');
    put(s.work, 'signup-worker/index.ts', 'export const a = 2;\n');

    const { release, unrelated } = splitDirtyPaths(s.g);
    assert.deepEqual(release, ['turbollm/package.json']);
    assert.deepEqual(unrelated, ['signup-worker/index.ts']);

    must(s.g, 'add', '--', ...release);
    const staged = must(s.g, 'diff', '--cached', '--name-only').stdout.split(/\r?\n/).filter(Boolean);
    assert.deepEqual(staged, ['turbollm/package.json']);
  } finally {
    cleanup(s.root);
  }
});

// preflight used to fail on ANY dirty file, so another session's half-finished edit to a
// separately deployed Worker blocked a release that never reads or ships it.
test('preflight tolerates an independent deployable and still blocks anything a release ships', () => {
  // run() trims stdout, so the first line arrives without its leading status space
  const porcelain = ['M signup-worker/README.md', ' M signup-worker/src/index.ts', ' M turbollm/src/x.ts', '?? scripts/new.mjs'].join('\n');
  const { blocking, tolerated } = splitPreflightDirty(porcelain);
  assert.deepEqual(tolerated, ['signup-worker/README.md', 'signup-worker/src/index.ts']);
  assert.deepEqual(blocking, ['turbollm/src/x.ts', 'scripts/new.mjs']);
});

test('preflight: an empty status is clean, and a look-alike directory name is not independent', () => {
  assert.deepEqual(splitPreflightDirty(''), { blocking: [], tolerated: [] });
  const { blocking, tolerated } = splitPreflightDirty(' M signup-worker-old/a.ts\n M signup-workerX/b.ts');
  assert.deepEqual(tolerated, []);
  assert.deepEqual(blocking, ['signup-worker-old/a.ts', 'signup-workerX/b.ts']);
});

test('preflight fails closed: a file-type change or a line it cannot parse blocks instead of reading as clean', () => {
  // ` T` (a file that became a symlink or back) is a real porcelain status a release must not ignore
  assert.deepEqual(splitPreflightDirty(' T turbollm/src/api/routes.ts'), { blocking: ['turbollm/src/api/routes.ts'], tolerated: [] });
  assert.deepEqual(splitPreflightDirty('T  turbollm/src/api/routes.ts').blocking, ['turbollm/src/api/routes.ts']);
  // git printing something this parser does not know about must never be dropped on the floor
  assert.deepEqual(splitPreflightDirty('warning: something odd'), { blocking: ['warning: something odd'], tolerated: [] });
});

test('preflight: a rename that crosses out of an independent directory still blocks', () => {
  const { blocking, tolerated } = splitPreflightDirty('R  signup-worker/a.ts -> turbollm/src/a.ts\nR  signup-worker/b.ts -> signup-worker/c.ts');
  assert.deepEqual(blocking, ['signup-worker/a.ts -> turbollm/src/a.ts']);
  assert.deepEqual(tolerated, ['signup-worker/b.ts -> signup-worker/c.ts']);
});

test('the tolerated set names only directories no release phase reads', () => {
  assert.deepEqual(INDEPENDENT_PATHS, ['signup-worker/']);
  for (const p of PREPARE_PATHS) {
    assert.ok(!INDEPENDENT_PATHS.some((d) => p.startsWith(d)), `${p} is release-owned and must never be tolerated`);
  }
});

// wrapper/ is gitignored in this repo yet its package.json is tracked (force-added). `git add -- <path>`
// exits 1 for a path inside an ignored directory even when the file is tracked, which killed the first
// scoped `prepare`; the old `git add -A` never named the path, so it never noticed.
test('staging stages a tracked release file that sits inside a gitignored directory', () => {
  const s = sandbox();
  try {
    put(s.work, '.gitignore', '/wrapper/\n');
    put(s.work, 'wrapper/package.json', '{\n  "version": "1.0.0"\n}\n');
    must(s.g, 'add', '.gitignore');
    must(s.g, 'add', '-f', 'wrapper/package.json');
    must(s.g, 'commit', '-m', 'wrapper is ignored but tracked');

    put(s.work, 'turbollm/package.json', '{\n  "version": "1.0.1"\n}\n');
    put(s.work, 'wrapper/package.json', '{\n  "version": "1.0.1"\n}\n');
    put(s.work, 'signup-worker/index.ts', 'export const a = 2;\n');

    stageReleasePaths(['turbollm/package.json', 'wrapper/package.json'], s.g);

    const staged = must(s.g, 'diff', '--cached', '--name-only').stdout.split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(staged, ['turbollm/package.json', 'wrapper/package.json']);
  } finally {
    cleanup(s.root);
  }
});

test('staging reports a real git failure instead of swallowing it', () => {
  const failing = () => ({ code: 1, stdout: '', stderr: 'fatal: boom', out: 'fatal: boom' });
  assert.throws(() => stageReleasePaths(['turbollm/package.json'], failing), /boom/);
});

test('PREPARE_PATHS names the release files and not the gitignored web bundle', () => {
  for (const p of [
    'README.md',
    'telemetry-worker/deployed.schema.sha256',
    'turbollm/CHANGELOG.md',
    'turbollm/package.json',
    'wrapper/package.json',
    // RELEASE.md step 4 has the human edit the persona knowledge base and leave it for `prepare` to
    // commit; leaving it out would ship a web bundle whose source was never committed.
    'turbollm/web/src/lib/personas.ts',
  ]) assert.ok(PREPARE_PATHS.includes(p), `${p} missing from PREPARE_PATHS`);
  assert.ok(!PREPARE_PATHS.some((p) => p.includes('webdist')), 'webdist is gitignored — git add would refuse it');
});

test('a dry-run record neither short-circuits a real run nor satisfies requires', () => {
  assert.equal(alreadyRecordedOk({ status: 'ok' }, {}), true);
  assert.equal(alreadyRecordedOk({ status: 'ok', dryRun: true }, {}), false);
  assert.equal(alreadyRecordedOk({ status: 'ok' }, { resume: true }), false);
  assert.equal(alreadyRecordedOk({ status: 'failed' }, {}), false);
  assert.equal(alreadyRecordedOk(undefined, {}), false);

  const state = (publish) => ({ version: '9.9.9', notes: {}, phases: { publish } });
  assert.throws(() => assertOrder(state({ status: 'ok', dryRun: true }), 'announce'), /dry-run/i);
  assert.doesNotThrow(() => assertOrder(state({ status: 'ok' }), 'announce'));
});

test('android refuses to ship when the Vulkan engine was requested but is not staged', () => {
  const enginePath = join('jniLibs', 'arm64-v8a', 'libllama_server_vk.so');
  assert.equal(androidEngineProblem({ vulkanRequested: false, enginePresent: false, enginePath }), null);
  assert.equal(androidEngineProblem({ vulkanRequested: true, enginePresent: true, enginePath }), null);

  const problem = androidEngineProblem({ vulkanRequested: true, enginePresent: false, enginePath });
  assert.match(problem, /libllama_server_vk\.so/);
  assert.match(problem, /build-static-engine\.sh/);
  assert.match(problem, /--skip-vulkan-engine/);
  assert.doesNotMatch(problem, /then copy/i, 'build-static-engine.sh copies the engine into jniLibs itself');
  assert.doesNotMatch(problem, /build-vulkan-engine\.sh|stage-vulkan-engine\.sh/);
});

test('importing the module does not run the CLI', () => {
  assert.equal(isCliEntry(RELEASE_URL, fileURLToPath(RELEASE_URL)), true);
  assert.equal(isCliEntry(RELEASE_URL, join(tmpdir(), 'somewhere-else.mjs')), false);
  assert.equal(isCliEntry(RELEASE_URL, undefined), false);
});

test('isCliEntry: a symlinked path to the script still runs the CLI', { skip: process.platform === 'win32' && 'file symlinks need privileges on Windows' }, () => {
  // Node resolves the main module's real path but leaves argv[1] as typed (macOS /tmp → /private/tmp,
  // a symlinked checkout): comparing them as-is made the script exit 0 having done nothing.
  const root = mkdtempSync(join(tmpdir(), 'turbollm-release-link-'));
  try {
    const link = join(root, 'release.mjs');
    symlinkSync(fileURLToPath(RELEASE_URL), link);
    assert.equal(isCliEntry(RELEASE_URL, link), true);
  } finally {
    cleanup(root);
  }
});

test('merge polls the ci.yml run for the merge commit, waiting for GitHub to create it', async () => {
  const sha = 'a'.repeat(40);
  const calls = [];
  const answers = ['', '', '4242'];
  const fakeGh = (...args) => {
    calls.push(args);
    return { code: 0, stdout: answers.shift() ?? '', stderr: '', out: '' };
  };

  assert.equal(await waitForCommitRun('ci.yml', sha, 60_000, fakeGh, 1), 4242);
  assert.equal(calls.length, 3, 'a run that does not exist yet is waited for, not replaced by the newest one');
  for (const args of calls) {
    assert.equal(args[args.indexOf('--workflow') + 1], 'ci.yml');
    assert.equal(args[args.indexOf('--commit') + 1], sha);
    assert.ok(!args.includes('--branch'), 'the branch alone also matches the previous main run');
  }
});

test('merge gives up on the post-merge run at the deadline instead of picking another run', async () => {
  const none = () => ({ code: 0, stdout: '', stderr: '', out: '' });
  assert.equal(await waitForCommitRun('ci.yml', 'b'.repeat(40), 0, none, 1), null);
});

// gh exits non-zero with nothing on stdout on any error, which read as "the run does not exist
// yet": a gh without `run list --commit` polled the full 5 minutes after every merge, then warned
// that the run was not found.
test('merge stops at once when gh run list fails instead of polling it as a missing run', async () => {
  const calls = [];
  const oldGh = (...args) => {
    calls.push(args);
    const stderr = 'unknown flag: --commit\n\nUsage:  gh run list [flags]';
    return { code: 1, stdout: '', stderr, out: stderr };
  };
  await assert.rejects(waitForCommitRun('ci.yml', 'c'.repeat(40), 60_000, oldGh, 1), /no `run list --commit`: update gh/);
  assert.equal(calls.length, 1, 'no second poll');

  const loggedOut = () => ({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login', out: 'To get started with GitHub CLI, please run:  gh auth login' });
  await assert.rejects(waitForCommitRun('ci.yml', 'c'.repeat(40), 60_000, loggedOut, 1), (e) => /failed \(exit 4\)/.test(e.message) && /gh auth login/.test(e.message));
});

// A GitHub Release older than npm-publish.yml never fires it, so every later release's run passed
// the "created after this release" check: publish waited on another tag's run (which succeeded)
// instead of reaching the local-token fallback, then failed polling npm for its own version.
test('publish waits only for the npm-publish.yml run of its own tag', async () => {
  const ghWith = (runs) => (...args) => {
    const stdout = args[0] === 'release' ? '2025-01-01T00:00:00Z' : JSON.stringify(runs);
    return { code: 0, stdout, stderr: '', out: stdout };
  };
  const later = { createdAt: '2026-06-01T00:00:00Z' };
  const otherTag = { databaseId: 7, event: 'release', headBranch: 'v1.2.0', ...later };

  assert.equal(await waitForWorkflowRun('npm-publish.yml', 'v1.0.1', 0, ghWith([otherTag]), 1), null,
    'no run for v1.0.1 is what lets publish fall back to the local token');
  assert.equal(await waitForWorkflowRun('npm-publish.yml', 'v1.0.1', 0, ghWith([otherTag, { databaseId: 8, event: 'release', headBranch: 'v1.0.1', ...later }]), 1), 8);
  // A dispatched run carries the branch it was dispatched from, not the tag; it still counts.
  assert.equal(await waitForWorkflowRun('npm-publish.yml', 'v1.0.1', 0, ghWith([{ databaseId: 9, event: 'workflow_dispatch', headBranch: 'main', ...later }]), 1), 9);
});

// A release's createdAt is the tagged commit's date, not when the release was made, so it never
// excluded an earlier attempt's run for the same tag: after the release was deleted and recreated,
// the first poll (before GitHub lists the new run) returned the old failed run and publish failed on it.
test('publish does not take an earlier attempt\'s run for a recreated release', async () => {
  const release = { createdAt: '2026-10-04T12:00:00Z', publishedAt: '2026-10-04T13:00:00Z' };
  const oldRun = { databaseId: 111, event: 'release', headBranch: 'v1.0.1', createdAt: '2026-10-04T12:10:00Z' };
  const newRun = { databaseId: 222, event: 'release', headBranch: 'v1.0.1', createdAt: '2026-10-04T13:00:02Z' };
  const ghWith = (runs) => (...args) => {
    const stdout = args[0] === 'release' ? (release[args[args.indexOf('--json') + 1]] ?? '') : JSON.stringify(runs);
    return { code: 0, stdout, stderr: '', out: stdout };
  };

  assert.equal(await waitForWorkflowRun('npm-publish.yml', 'v1.0.1', 0, ghWith([oldRun]), 1), null);
  assert.equal(await waitForWorkflowRun('npm-publish.yml', 'v1.0.1', 0, ghWith([newRun, oldRun]), 1), 222);
});

// A failing `gh run list` read as "no run yet": after 5 minutes of polling it, publish fell back to a
// local `npm publish` with the token, racing the npm-publish.yml run the release had just fired.
test('publish stops at once when gh fails instead of reading it as no npm-publish.yml run', async () => {
  const calls = [];
  const loggedOut = (...args) => {
    calls.push(args);
    if (args[0] === 'release') return { code: 0, stdout: '2026-10-04T13:00:00Z', stderr: '', out: '2026-10-04T13:00:00Z' };
    const stderr = 'To get started with GitHub CLI, please run:  gh auth login';
    return { code: 4, stdout: '', stderr, out: stderr };
  };
  await assert.rejects(waitForWorkflowRun('npm-publish.yml', 'v1.0.1', 60_000, loggedOut, 1),
    (e) => /`gh run list --workflow npm-publish\.yml` failed \(exit 4\)/.test(e.message) && /gh auth login/.test(e.message) && /Nothing was published/.test(e.message));
  assert.equal(calls.filter((a) => a[0] === 'run').length, 1, 'no second poll');

  // A failed release view read as "published at the epoch", so an earlier attempt's run matched.
  const oldRun = { databaseId: 111, event: 'release', headBranch: 'v1.0.1', createdAt: '2026-10-04T12:10:00Z' };
  const noView = (...args) => {
    if (args[0] === 'release') return { code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials', out: 'HTTP 401: Bad credentials' };
    return { code: 0, stdout: JSON.stringify([oldRun]), stderr: '', out: '' };
  };
  await assert.rejects(waitForWorkflowRun('npm-publish.yml', 'v1.0.1', 60_000, noView, 1),
    (e) => /`gh release view v1\.0\.1` failed \(exit 1\)/.test(e.message) && /Bad credentials/.test(e.message));
});

// The local-token fallback runs `npm publish` in turbollm/, whose prepublishOnly builds what is on
// disk: it uploaded uncommitted edits and untracked files, at whatever commit HEAD was, as the tag.
test('the local npm fallback publishes only a checkout that is exactly the tag', () => {
  const s = sandbox();
  try {
    must(s.g, 'tag', 'v1.0.1');
    assert.equal(localPublishProblem('v1.0.1', s.g), null, 'HEAD at the tag with a clean turbollm/');

    // Someone else's edit outside the package changes nothing npm publish builds.
    put(s.work, 'signup-worker/index.ts', 'export const a = 2;\n');
    assert.equal(localPublishProblem('v1.0.1', s.g), null);
    must(s.g, 'checkout', '--', 'signup-worker/index.ts');

    put(s.work, 'turbollm/package.json', '{\n  "version": "1.0.1",\n  "private": false\n}\n');
    assert.match(localPublishProblem('v1.0.1', s.g) ?? '', /turbollm\/ holds changes that v1\.0\.1 does not[^]*M turbollm\/package\.json/);
    must(s.g, 'checkout', '--', 'turbollm/package.json');

    put(s.work, 'turbollm/src/new.ts', 'export {};\n');
    assert.match(localPublishProblem('v1.0.1', s.g) ?? '', /\?\? turbollm\/src\/new\.ts/, 'an untracked file is built too');
    rmSync(join(s.work, 'turbollm', 'src'), { recursive: true });

    // bin/ ships as it is, so a file git ignores there is uploaded as well (*.bin and *.local are
    // ignored here, as in the root .gitignore).
    put(s.work, '.gitignore', '*.bin\n*.local\n');
    must(s.g, 'add', '.gitignore');
    must(s.g, 'commit', '-m', 'ignore');
    must(s.g, 'tag', '-f', 'v1.0.1');
    put(s.work, 'turbollm/bin/stale.bin', 'x');
    assert.match(localPublishProblem('v1.0.1', s.g) ?? '', /!! turbollm\/bin\/stale\.bin/);
    rmSync(join(s.work, 'turbollm', 'bin'), { recursive: true });
    // So is one in web/public/: vite copies it verbatim into the web build, which ships in dist/.
    put(s.work, 'turbollm/web/public/brand/old.bin', 'x');
    assert.match(localPublishProblem('v1.0.1', s.g) ?? '', /!! turbollm\/web\/public\/brand\/old\.bin/);
    rmSync(join(s.work, 'turbollm', 'web', 'public'), { recursive: true });
    // And an ignored web/.env*.local: vite loads it into the build with no import naming it.
    put(s.work, 'turbollm/web/.env.production.local', 'NODE_ENV=development\n');
    assert.match(localPublishProblem('v1.0.1', s.g) ?? '', /!! turbollm\/web\/\.env\.production\.local/);
    rmSync(join(s.work, 'turbollm', 'web'), { recursive: true });
    assert.equal(localPublishProblem('v1.0.1', s.g), null);

    put(s.work, 'turbollm/README.md', 'later\n');
    must(s.g, 'add', '-A');
    must(s.g, 'commit', '-m', 'after the tag');
    assert.match(localPublishProblem('v1.0.1', s.g) ?? '', /HEAD \([0-9a-f]{7}\) is not the tagged commit v1\.0\.1/);
    assert.match(localPublishProblem('v9.9.9', s.g) ?? '', /could not both be resolved/, 'a missing tag fails closed');
  } finally {
    cleanup(s.root);
  }
});

// ── the real CLI, against stub `gh` / `npm` ──────────────────────────────────
// The stubs are sh scripts, and spawnSync without a shell finds only .exe files on Windows.
const POSIX_ONLY = { skip: process.platform === 'win32' && 'the gh/npm stubs are sh scripts' };

// Serialized into the sandbox as the stub's source: logs every call to calls.log and answers from
// rules.json, the first rule whose `when` is part of the command line. `out` may be a list, answered
// in order across repeated calls (the last one repeats).
function stubMain() {
  const { appendFileSync, readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const [dir, tool, ...args] = process.argv.slice(2);
  const line = [tool, ...args].join(' ');
  let seen = [];
  try { seen = readFileSync(join(dir, 'calls.log'), 'utf8').split('\n'); } catch { /* first call */ }
  appendFileSync(join(dir, 'calls.log'), `${line}\n`);
  const rule = JSON.parse(readFileSync(join(dir, 'rules.json'), 'utf8')).find((r) => line.includes(r.when)) || {};
  const outs = [].concat(rule.out ?? []);
  if (outs.length) {
    const n = seen.filter((l) => l.includes(rule.when)).length;
    process.stdout.write(`${outs[Math.min(n, outs.length - 1)]}\n`);
  }
  process.exit(rule.code ?? 0);
}

// The sandbox repo with this release.mjs in it, a release branch tracking origin, run state with
// `phases` recorded ok, and the stubs first on PATH. HOME points into the sandbox so a real
// ~/.turbollm-release token is never picked up.
function cliSandbox({ version, phases, notes = {}, rules = [] }) {
  const s = sandbox();
  put(s.work, 'scripts/release.mjs', readFileSync(fileURLToPath(RELEASE_URL)));
  put(s.work, '.gitignore', '.omc/\n');
  put(s.work, 'turbollm/CHANGELOG.md', `## [${version}]\n\n- a fix\n\n### Discord\n\n- a fix\n`);
  must(s.g, 'add', '-A');
  must(s.g, 'commit', '-m', 'release tooling');
  must(s.g, 'push');
  must(s.g, 'checkout', '-b', `release/v${version}`);
  must(s.g, 'push', '-u', 'origin', `release/v${version}`);

  put(s.work, `.omc/release/${version}.json`, JSON.stringify({
    version, createdAt: new Date().toISOString(), updatedAt: null, notes,
    phases: Object.fromEntries(phases.map((p) => [p, { status: 'ok' }])),
  }));

  const stubDir = join(s.root, 'stub');
  const bin = join(stubDir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(stubDir, 'rules.json'), JSON.stringify(rules));
  writeFileSync(join(stubDir, 'stub.cjs'), `(${stubMain.toString()})();\n`);
  for (const tool of ['gh', 'npm']) {
    const p = join(bin, tool);
    writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${join(stubDir, 'stub.cjs')}" "${stubDir}" ${tool} "$@"\n`);
    chmodSync(p, 0o755);
  }

  const release = (args, env = {}) => {
    const r = spawnSync(process.execPath, [join(s.work, 'scripts', 'release.mjs'), ...args, '--version', version], {
      cwd: s.work,
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: s.root, USERPROFILE: s.root,
        NO_COLOR: '1', TURBOLLM_NPM_TOKEN: '', ...env,
      },
    });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
  };
  const calls = () => {
    try { return readFileSync(join(stubDir, 'calls.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  };
  return { ...s, release, calls };
}

const BEFORE_PUBLISH = ['preflight', 'review', 'prepare', 'verify', 'merge'];

// The merge commit's sha came from `gh pr view` with its exit code unread: a failing gh (a lost login,
// a network error) gave no sha, which read as "no post-merge run to find". The phase warned, skipped
// the CI check on main and recorded the merge ok, and publish could then tag a red main.
test('merge stops when gh pr view fails instead of skipping the post-merge CI check', POSIX_ONLY, () => {
  const s = cliSandbox({
    version: '1.0.1',
    phases: ['preflight', 'review', 'prepare', 'verify'],
    notes: { reviewVerdict: 'approve', pr: 7 },
    rules: [{ when: 'pr view 7 --json mergeCommit', code: 1, out: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' }],
  });
  try {
    const r = s.release(['merge', '--approved']);

    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /`gh pr view 7 --json mergeCommit` failed \(exit 1\)/);
    assert.match(r.out, /Bad credentials/);
    assert.match(r.out, /The PR is merged/);
    assert.doesNotMatch(r.out, /could not find the post-merge main run/);
    assert.equal(JSON.parse(readFileSync(join(s.work, '.omc', 'release', '1.0.1.json'), 'utf8')).phases.merge.status, 'failed');
    assert.deepEqual(s.calls().filter((c) => c.startsWith('gh run list')), []);
  } finally {
    cleanup(s.root);
  }
});

// The gate used to sit at the npm step, after the tag, the push and `gh release create`, and creating
// the release is itself what fires npm-publish.yml.
test('publish without --approved stops before the tag, the push and the GitHub Release', POSIX_ONLY, () => {
  const s = cliSandbox({
    version: '1.0.1',
    phases: BEFORE_PUBLISH,
    rules: [{ when: '--json tagName', code: 1 }, { when: 'npm view turbollm version', out: '1.0.0' }],
  });
  try {
    put(s.work, 'turbollm/package.json', '{\n  "version": "1.0.1"\n}\n');

    const r = s.release(['publish']);

    assert.notEqual(r.code, 0);
    assert.match(r.out, /--approved/);
    assert.deepEqual(s.calls().filter((c) => c.startsWith('gh release create')), []);
    assert.equal(must(s.g, 'tag', '--list', 'v1.0.1').stdout, '');
    assert.equal(must(s.g, 'ls-remote', '--tags', 'origin').stdout, '');
  } finally {
    cleanup(s.root);
  }
});

test('publish leaves npm to the OIDC workflow it triggered, even when a local token exists', POSIX_ONLY, () => {
  const s = cliSandbox({
    version: '1.0.1',
    phases: BEFORE_PUBLISH,
    rules: [
      { when: '--json tagName', code: 1 },
      { when: '--json publishedAt', out: '2026-01-01T00:00:00Z' },
      { when: 'run list --workflow npm-publish.yml', out: '[{"databaseId":42,"event":"release","headBranch":"v1.0.1","createdAt":"2026-01-01T00:00:05Z"}]' },
      { when: 'run view 42', out: 'completed success' },
      { when: 'npm view turbollm version', out: ['1.0.0', '1.0.1'] },
      { when: '--json assets', out: 'TurboLLM-Setup-x64.exe\nTurboLLM-x86_64.AppImage\nTurboLLM-arm64.dmg' },
    ],
  });
  try {
    put(s.work, 'turbollm/package.json', '{\n  "version": "1.0.1"\n}\n');

    const r = s.release(['publish', '--approved'], { TURBOLLM_NPM_TOKEN: 'npm_local_token' });

    assert.equal(r.code, 0, r.out);
    assert.ok(s.calls().some((c) => c.startsWith('gh release create v1.0.1')));
    assert.deepEqual(s.calls().filter((c) => /^npm (publish|whoami)/.test(c)), [], 'a local publish races npm-publish.yml for the same version');
    assert.ok(s.calls().some((c) => c.startsWith('gh run view 42')), 'the workflow run is what gets waited on');
  } finally {
    cleanup(s.root);
  }
});

// A failed tag push was only noted. `gh release create` then made the missing tag itself, from the
// default branch's tip, which is not this commit if main moved during the post-merge CI wait, and
// npm-publish.yml published from that tag while the phase recorded ok.
test('publish stops when the tag push fails, and the release never creates its own tag', POSIX_ONLY, () => {
  const s = cliSandbox({
    version: '1.0.1',
    phases: BEFORE_PUBLISH,
    rules: [
      { when: '--json tagName', code: 1 },
      { when: '--json publishedAt', out: '2026-01-01T00:00:00Z' },
      { when: 'run list --workflow npm-publish.yml', out: '[{"databaseId":42,"event":"release","headBranch":"v1.0.1","createdAt":"2026-01-01T00:00:05Z"}]' },
      { when: 'run view 42', out: 'completed success' },
      { when: 'npm view turbollm version', out: ['1.0.0', '1.0.1'] },
    ],
  });
  try {
    put(s.work, 'turbollm/package.json', '{\n  "version": "1.0.1"\n}\n');
    must(s.g, 'remote', 'set-url', 'origin', join(s.root, 'unreachable.git'));

    const r = s.release(['publish', '--approved', '--skip-desktop']);

    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /could not push tag v1\.0\.1/);
    assert.deepEqual(s.calls().filter((c) => c.startsWith('gh release create')), []);
    assert.equal(JSON.parse(readFileSync(join(s.work, '.omc', 'release', '1.0.1.json'), 'utf8')).phases.publish.status, 'failed');

    // And with the push working, the release is told to use the pushed tag, never to make one.
    must(s.g, 'remote', 'set-url', 'origin', s.origin);
    const again = s.release(['publish', '--approved', '--skip-desktop']);
    assert.equal(again.code, 0, again.out);
    assert.equal(must(s.g, 'ls-remote', '--tags', 'origin', 'v1.0.1').stdout.split(/\s+/)[0], must(s.g, 'rev-parse', 'HEAD').stdout);
    assert.ok(s.calls().some((c) => c.startsWith('gh release create v1.0.1') && c.split(' ').includes('--verify-tag')));
  } finally {
    cleanup(s.root);
  }
});

// On a drifted telemetry schema, --approved redeployed the production Worker whether or not --dry-run
// was also given, and the phase was then recorded as a dry run.
test('preflight --dry-run --approved does not redeploy the telemetry Worker', POSIX_ONLY, () => {
  const s = cliSandbox({ version: '1.0.1', phases: [], rules: [{ when: 'npm view turbollm version', out: '1.0.0' }] });
  try {
    put(s.work, 'turbollm/package.json', '{\n  "version": "1.0.1"\n}\n');
    put(s.work, 'telemetry-worker/scripts/schema-hash.mjs', "process.exit(process.argv[2] === 'check' ? 1 : 0);\n");
    must(s.g, 'add', '-A');
    must(s.g, 'commit', '-m', 'drift');
    const deploys = () => s.calls().filter((c) => c.startsWith('npm run deploy'));

    const dry = s.release(['preflight', '--dry-run', '--approved']);

    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /\[dry-run\] .*would redeploy/);
    assert.deepEqual(deploys(), []);

    const real = s.release(['preflight', '--approved']);
    assert.equal(deploys().length, 1, real.out);
  } finally {
    cleanup(s.root);
  }
});

// The telemetry gate redeployed the production Worker the moment it saw drift: before the checks after
// it ran, and whatever the ones before it had found. On a dirty tree that shipped uncommitted Worker
// code, and preflight then failed on the very problems that should have stopped the deploy.
test('preflight --approved redeploys the telemetry Worker only once every blocking check passes', POSIX_ONLY, () => {
  const s = cliSandbox({ version: '1.0.1', phases: [], rules: [{ when: 'npm view turbollm version', out: '1.0.0' }] });
  try {
    put(s.work, 'turbollm/package.json', '{\n  "version": "1.0.1"\n}\n');
    put(s.work, 'telemetry-worker/scripts/schema-hash.mjs', "process.exit(process.argv[2] === 'check' ? 1 : 0);\n");
    must(s.g, 'add', '-A');
    must(s.g, 'commit', '-m', 'drift');
    const deploys = () => s.calls().filter((c) => c.startsWith('npm run deploy'));

    // A check that runs before the gate: an uncommitted Worker change.
    put(s.work, 'telemetry-worker/src/index.ts', 'export default {};\n');
    const dirty = s.release(['preflight', '--approved']);
    assert.deepEqual(deploys(), [], 'the uncommitted Worker code went to production');
    assert.notEqual(dirty.code, 0, dirty.out);
    assert.match(dirty.out, /working tree is not clean/);
    assert.match(dirty.out, /telemetry Worker was not redeployed/);

    // A check that runs after it: magic-close syntax in a commit message.
    must(s.g, 'add', '-A');
    must(s.g, 'commit', '-m', 'worker change, closes #12');
    const magic = s.release(['preflight', '--approved']);
    assert.deepEqual(deploys(), [], magic.out);
    assert.notEqual(magic.code, 0, magic.out);
    assert.match(magic.out, /Closes\/Fixes\/Resolves #NNN/);

    must(s.g, 'commit', '--amend', '-m', 'worker change (#12)');
    const clean = s.release(['preflight', '--approved']);
    assert.equal(deploys().length, 1, clean.out);
  } finally {
    cleanup(s.root);
  }
});

// A dry run set the new version in turbollm/package.json and wrapper/package.json and regenerated the
// root README.md in place: the preview left the tree holding the release's own edits, uncommitted.
test('prepare --dry-run writes nothing and lists what a real run would commit', POSIX_ONLY, () => {
  const s = cliSandbox({ version: '1.0.1', phases: ['preflight', 'review'], notes: { baseVersion: '1.0.0' } });
  try {
    put(s.work, 'turbollm/README.md', '# TurboLLM\n\nnew\n');
    put(s.work, 'README.md', '# TurboLLM\n\nold\n');
    must(s.g, 'add', '-A');
    must(s.g, 'commit', '-m', 'readme');
    must(s.g, 'push');
    const head = must(s.g, 'rev-parse', 'HEAD').stdout;

    const r = s.release(['prepare', '--dry-run']);

    assert.equal(r.code, 0, r.out);
    assert.equal(must(s.g, 'status', '--porcelain').stdout, '', 'the dry run edited tracked files');
    assert.match(r.out, /\[dry-run\] would set \.\/turbollm\/package\.json → 1\.0\.1/);
    assert.match(r.out, /\[dry-run\] would regenerate the root README\.md/);
    assert.match(r.out, /\[dry-run\] would commit \+ push:\nREADME\.md\nturbollm\/package\.json\n/);
    assert.equal(must(s.g, 'rev-parse', 'HEAD').stdout, head);
  } finally {
    cleanup(s.root);
  }
});

// A push that failed after the commit left nothing to commit on the re-run, which then recorded ok
// without pushing: `verify` checked a PR head without the release commit, and `merge` merged it.
test('prepare re-run after a failed push pushes the release commit', POSIX_ONLY, () => {
  const s = cliSandbox({ version: '1.0.1', phases: ['preflight', 'review'], notes: { baseVersion: '1.0.0' } });
  try {
    must(s.g, 'remote', 'set-url', 'origin', join(s.root, 'unreachable.git'));
    const first = s.release(['prepare']);
    assert.notEqual(first.code, 0, 'the push must fail while origin is unreachable');
    must(s.g, 'remote', 'set-url', 'origin', s.origin);

    const second = s.release(['prepare']);

    assert.equal(second.code, 0, second.out);
    const head = must(s.g, 'rev-parse', 'HEAD').stdout;
    assert.match(must(s.g, 'log', '-1', '--format=%s').stdout, /^chore\(release\): v1\.0\.1/);
    assert.equal(must(s.g, 'ls-remote', 'origin', 'refs/heads/release/v1.0.1').stdout.split(/\s+/)[0], head);
  } finally {
    cleanup(s.root);
  }
});

// ── magic-close scan: flags a commit that would close an issue, except ones acknowledged by full SHA ──────────
// b387a903 quotes the syntax while describing the check (`closes #12`, a PR, so it closed nothing) and sits on main:
// history cannot be reworded, so a SHA allowlist is the only way past it that does not weaken the scan.
const entry = (sha, body) => `${sha}\x1f${body}\x1e`;

test('magicCloseCommits: flags Closes/Fixes/Resolves #N in any capitalization, naming the short sha', () => {
  const log = entry('a'.repeat(40), 'fix(x): y\n\nCloses #5')
    + entry('b'.repeat(40), 'docs: z\n\nsee (#7), addresses #8')
    + entry('c'.repeat(40), 'fix: q\n\nresolves #9');
  assert.deepEqual(magicCloseCommits(log, new Set()), ['aaaaaaaa', 'cccccccc']);
});

test('magicCloseCommits: a commit acknowledged by its full SHA is skipped, another with the same text is not', () => {
  const known = 'b'.repeat(40);
  const log = entry(known, 'quotes `closes #12` while describing the check') + entry('d'.repeat(40), 'closes #12');
  assert.deepEqual(magicCloseCommits(log, new Set([known])), ['dddddddd']);
  assert.deepEqual(magicCloseCommits('', new Set()), []);
});
