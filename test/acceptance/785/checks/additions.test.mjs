import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { collectPatch, trustedVisiblePlan } from '../../../../src/candidate/build.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'accept-added-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, 'base'), workspace = join(root, 'work');
  mkdirSync(base); mkdirSync(workspace);
  return { base, workspace };
}
function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
for (const path of ['test/new.ts', 'tests/new.test.ts', 'src/new.test.ts']) {
  test(`candidate-only ${path} is visible in collectPatch metadata`, async (t) => {
    const f = fixture(t);
    put(f.workspace, path, 'export const regression = true;\n');
    const patch = await collectPatch(f);
    assert.equal(patch.kind, 'collected');
    assert.deepEqual(patch.changedPaths, [path]);
    assert.equal(patch.testInputsChanged, true);
  });
  test(`candidate-only ${path} is visible in trusted plan metadata`, (t) => {
    const f = fixture(t);
    put(f.workspace, path, 'export const regression = true;\n');
    const plan = trustedVisiblePlan(f.base, f.workspace, 'node --test');
    assert.equal(plan.testInputsChanged, true);
    assert.equal(readFileSync(join(f.workspace, path), 'utf8'), 'export const regression = true;\n');
  });
}
for (const path of ['test/new.ts', 'tests/new.test.ts', 'src/new.test.ts']) {
  test(`authorization of another path does not hide addition ${path}`, (t) => {
    const f = fixture(t);
    put(f.base, 'test/replaced.ts', 'old\n');
    put(f.workspace, 'test/replaced.ts', 'replacement\n');
    put(f.workspace, path, 'new regression\n');
    const plan = trustedVisiblePlan(f.base, f.workspace, 'node --test', [{ path: 'test/replaced.ts' }]);
    assert.equal(plan.testInputsChanged, true);
    assert.equal(readFileSync(join(f.workspace, 'test/replaced.ts'), 'utf8'), 'replacement\n');
    assert.equal(readFileSync(join(f.workspace, path), 'utf8'), 'new regression\n');
  });
}
// factory-holdout-cefe87092adb4db3ca3846b0a7326b6a1630344ac1e209763ae1beec1088ee6d
