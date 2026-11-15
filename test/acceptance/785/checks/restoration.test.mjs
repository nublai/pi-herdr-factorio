import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { collectPatch, trustedVisiblePlan } from '../../../../src/candidate/build.ts';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'accept-restore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, 'base'), workspace = join(root, 'work');
  mkdirSync(base); mkdirSync(workspace);
  return { base, workspace };
}
function put(root, path, text, mode = 0o644) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text); chmodSync(join(root, path), mode);
}
for (const path of ['test/original.ts', 'tests/original.test.ts', 'src/original.test.ts']) {
  for (const change of ['bytes', 'mode', 'deletion']) {
    test(`${change} to unauthorized ${path} is reported and restored`, async (t) => {
      const f = fixture(t);
      put(f.base, path, 'baseline\n');
      if (change !== 'deletion') put(f.workspace, path, change === 'bytes' ? 'candidate\n' : 'baseline\n', change === 'mode' ? 0o755 : 0o644);
      const patch = await collectPatch(f);
      assert.equal(patch.kind, 'collected');
      assert.equal(patch.testInputsChanged, true);
      const plan = trustedVisiblePlan(f.base, f.workspace, 'node --test');
      assert.equal(plan.testInputsChanged, true);
      assert.equal(readFileSync(join(f.workspace, path), 'utf8'), 'baseline\n');
      assert.equal(statSync(join(f.workspace, path)).mode & 0o777, 0o644);
    });
  }
}
test('restoration retains additions and freezes base scripts without discarding other manifest fields', (t) => {
  const f = fixture(t);
  const scripts = { test: 'node --test test/*.test.js', pretest: 'echo baseline' };
  put(f.base, 'package.json', JSON.stringify({ name: 'base', scripts }));
  put(f.workspace, 'package.json', JSON.stringify({ name: 'candidate', scripts: { test: 'exit 0', pretest: 'echo changed' } }));
  put(f.base, 'test/changed.test.js', 'base bytes\n');
  put(f.workspace, 'test/changed.test.js', 'changed bytes\n');
  put(f.base, 'test/deleted.test.js', 'deleted baseline\n');
  put(f.workspace, 'test/added.test.js', 'new regression\n');
  const plan = trustedVisiblePlan(f.base, f.workspace, 'npm test');
  assert.equal(plan.command, scripts.test);
  assert.equal(plan.scriptsChanged, true);
  assert.equal(plan.testInputsChanged, true);
  assert.equal(readFileSync(join(f.workspace, 'test/changed.test.js'), 'utf8'), 'base bytes\n');
  assert.equal(readFileSync(join(f.workspace, 'test/deleted.test.js'), 'utf8'), 'deleted baseline\n');
  assert.equal(readFileSync(join(f.workspace, 'test/added.test.js'), 'utf8'), 'new regression\n');
  const manifest = JSON.parse(readFileSync(join(f.workspace, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.scripts, scripts);
  assert.equal(manifest.name, 'candidate');
});
// factory-holdout-cefe87092adb4db3ca3846b0a7326b6a1630344ac1e209763ae1beec1088ee6d
