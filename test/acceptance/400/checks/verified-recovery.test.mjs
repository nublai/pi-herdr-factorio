import test from 'node:test';
import assert from 'node:assert/strict';
import { world, labeled, runOf, statuses, runIssues } from '../../../../test/src/controller/orchestrator-fixtures.ts';
import { FAKE_REPO, networkError } from '../../../../test/fake-ticket-adapter.ts';

test('a verified unmarked recovery reads before claiming and reuses that read', async () => {
  const { github, clock, files, wire, start } = world();
  github.add(labeled(14));
  github.posts = ['lost'];
  await start().tick();
  assert.equal(files.claims.get(runOf(14))?.seq, null);
  const reads = [];
  wire.intercept = async (...args) => {
    if (/issues\/14(?:["?\s]|$)/.test(JSON.stringify(args))) reads.push([...statuses(github, 14)]);
    return github.exec(...args);
  };
  clock.t += 30_000;
  const report = await start().tick();
  assert.equal(reads.length, 1, 'one direct readiness read per recovery tick');
  assert.deepEqual(reads[0], [], 'read precedes first claimed POST');
  assert.equal(statuses(github, 14)[0], '1:claimed');
  assert.ok(runIssues(report).includes(14));
  assert.ok(files.claims.has(runOf(14)));
});

test('failed pre-marker reads defer recovery and later verification permits recovery', async () => {
  const { github, clock, files, wire, executor, start } = world();
  github.add(labeled(14));
  github.posts = ['lost'];
  await start().tick();
  assert.equal(files.claims.get(runOf(14))?.seq, null);
  github.failures.set(`repos/${FAKE_REPO}/issues/14`, networkError());
  clock.t += 30_000;
  const controller = start();
  await controller.tick();
  assert.deepEqual(statuses(github, 14), [], 'unverified recovery must not post claimed');
  assert.equal(executor.launches.length, 0);
  assert.equal(files.claims.get(runOf(14))?.seq, null);
  github.failures.clear();
  const reads = [];
  wire.intercept = async (...args) => {
    if (/issues\/14(?:["?\s]|$)/.test(JSON.stringify(args))) reads.push([...statuses(github, 14)]);
    return github.exec(...args);
  };
  clock.t += 30_000;
  await controller.tick();
  assert.equal(statuses(github, 14)[0], '1:claimed');
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0], [], 'successful retry verifies eligibility before claiming');
  assert.ok(files.claims.has(runOf(14)));
});
// factory-holdout-30449df218baac007322944fd7064464075541c12fcbcd76b64eeb2ea2823cd7
