// Tests for the release driver's guards — the four failures v1.13.6 hit.
//   node --test scripts/release.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INDEPENDENT_PATHS,
  PREPARE_PATHS,
  alreadyRecordedOk,
  androidEngineProblem,
  assertOrder,
  isCliEntry,
  splitDirtyPaths,
  splitPreflightDirty,
  syncMainFastForward,
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
