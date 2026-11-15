import test from 'node:test';
import assert from 'node:assert/strict';
import { world, labeled, runOf, statuses } from '../../../../test/src/controller/orchestrator-fixtures.ts';

test('fresh admission and marked restart preserve sequence and ownership', async () => {
  const { github, clock, files, start } = world();
  github.add(labeled(14));
  await start().tick();
  const markers = [...statuses(github, 14)];
  assert.equal(markers[0], '1:claimed');
  assert.ok(files.claims.get(runOf(14)));
  clock.t += 30_000;
  await start().tick();
  assert.deepEqual(statuses(github, 14), markers, 'restart does not duplicate marked admission');
  assert.ok(files.claims.has(runOf(14)));
});

test('lost first marker retains the original admission through recovery', async () => {
  const { github, clock, files, start } = world();
  github.add(labeled(14));
  github.posts = ['lost'];
  await start().tick();
  const original = files.claims.get(runOf(14));
  assert.ok(original);
  assert.equal(original.seq, null);
  assert.deepEqual(statuses(github, 14), []);
  clock.t += 30_000;
  await start().tick();
  assert.equal(statuses(github, 14)[0], '1:claimed');
  const recovered = files.claims.get(runOf(14));
  assert.ok(recovered);
  for (const key of Object.keys(original)) {
    if (/snapshot|workflow|eventId|runId|admission/i.test(key)) {
      assert.deepEqual(recovered[key], original[key], `preserve ${key}`);
    }
  }
});
// factory-holdout-30449df218baac007322944fd7064464075541c12fcbcd76b64eeb2ea2823cd7
