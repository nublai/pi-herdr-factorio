import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { collectPatch, trustedVisiblePlan } from '../../../../src/candidate/build.ts';
import { digestOf } from '../../../../src/core/run.ts';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'accept-compat-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, 'base'), workspace = join(root, 'work');
  mkdirSync(base); mkdirSync(workspace);
  return { base, workspace };
}
function put(root, path, text, mode = 0o644) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text); chmodSync(join(root, path), mode);
}
test('non-test changes do not affect test-input metadata', async (t) => {
  const f = fixture(t);
  for (const root of [f.base, f.workspace]) {
    for (const path of ['test/fixture.txt', 'tests/stable.ts', 'src/stable.test.ts']) put(root, path, 'unchanged\n');
  }
  put(f.base, 'src/value.ts', 'old\n');
  put(f.workspace, 'src/value.ts', 'new\n');
  const patch = await collectPatch(f);
  assert.equal(patch.kind, 'collected');
  assert.equal(patch.testInputsChanged, false);
  assert.deepEqual(patch.changedPaths, ['src/value.ts']);
  assert.equal(trustedVisiblePlan(f.base, f.workspace, 'node --test').testInputsChanged, false);
});
test('identical trees retain empty-patch compatibility and false plan metadata', async (t) => {
  const f = fixture(t);
  for (const root of [f.base, f.workspace]) put(root, 'test/stable.ts', 'unchanged\n');
  assert.equal(trustedVisiblePlan(f.base, f.workspace, 'node --test').testInputsChanged, false);
  assert.deepEqual(await collectPatch(f), { kind: 'error', reason: 'empty_patch' });
  assert.deepEqual(await collectPatch({ ...f, allowNoChange: true }), {
    kind: 'collected', patch: '', patchDigest: digestOf(''), changedPaths: [], policy: 'clean'
  });
});
for (const change of ['bytes', 'mode', 'deletion']) {
  test(`authorized replacement ${change} is excluded only from visible-plan metadata`, async (t) => {
    const f = fixture(t);
    const path = 'test/replaced.ts';
    put(f.base, path, 'baseline\n');
    if (change !== 'deletion') put(f.workspace, path, change === 'bytes' ? 'replacement\n' : 'baseline\n', change === 'mode' ? 0o755 : 0o644);
    const patch = await collectPatch(f);
    assert.equal(patch.kind, 'collected');
    assert.equal(patch.testInputsChanged, true);
    const plan = trustedVisiblePlan(f.base, f.workspace, 'node --test', [{ path }]);
    assert.equal(plan.testInputsChanged, false);
    if (change === 'deletion') assert.equal(existsSync(join(f.workspace, path)), false);
    else {
      assert.equal(readFileSync(join(f.workspace, path), 'utf8'), change === 'bytes' ? 'replacement\n' : 'baseline\n');
      const after = await collectPatch(f);
      assert.equal(after.kind, 'collected');
      assert.deepEqual(after.patch, patch.patch);
    }
  });
}
// factory-holdout-cefe87092adb4db3ca3846b0a7326b6a1630344ac1e209763ae1beec1088ee6d
