import test from 'node:test';
import assert from 'node:assert/strict';
import { world, labeled, runOf, statuses } from '../../../../test/src/controller/orchestrator-fixtures.ts';

for (const reason of ['closed', 'unlabeled']) {
  test(`stale candidates cannot authorize an unmarked ${reason} admission`, async () => {
    const { github, clock, files, wire, executor, logs, start } = world();
    const issue = github.add(labeled(14));
    github.posts = ['lost'];
    await start().tick();
    assert.equal(files.claims.get(runOf(14))?.seq, null);
    assert.deepEqual(statuses(github, 14), []);
    const reads = [];
    wire.intercept = async (...args) => {
      if (/issues\/14(?:["?\s]|$)/.test(JSON.stringify(args))) {
        reads.push([...statuses(github, 14)]);
        if (reason === 'closed') issue.state = 'closed';
        else issue.labels = [];
      }
      return github.exec(...args);
    };
    clock.t += 30_000;
    await start().tick();
    assert.ok(reads.length > 0, 'eligibility must be read directly');
    assert.deepEqual(reads[0], [], 'direct read must precede the first claimed marker');
    assert.deepEqual(statuses(github, 14), ['1:released']);
    assert.equal(executor.launches.length, 0);
    assert.ok(logs.some(entry => entry.event === 'claim_released' && entry.fields.issue === 14 && entry.fields.why === reason));
  });
}
// factory-holdout-30449df218baac007322944fd7064464075541c12fcbcd76b64eeb2ea2823cd7
