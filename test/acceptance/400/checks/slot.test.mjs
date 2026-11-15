import test from 'node:test';
import assert from 'node:assert/strict';
import { world, labeled, runOf, statuses } from '../../../../test/src/controller/orchestrator-fixtures.ts';

for (const reason of ['closed', 'unlabeled']) {
  test(`an ineligible ${reason} recovery leaves the remaining slot for healthy work`, async () => {
    const { github, clock, files, wire, start } = world();
    github.add(labeled(13));
    const controller = start();
    await controller.tick();
    assert.equal(statuses(github, 13)[0], '1:claimed');
    const issue = github.add(labeled(14));
    github.posts = ['lost'];
    clock.t += 30_000;
    await controller.tick();
    assert.equal(files.claims.get(runOf(14))?.seq, null);
    github.add(labeled(15));
    wire.intercept = async (...args) => {
      if (/issues\/14(?:["?\s]|$)/.test(JSON.stringify(args))) {
        if (reason === 'closed') issue.state = 'closed';
        else issue.labels = [];
      }
      return github.exec(...args);
    };
    clock.t += 30_000;
    await start().tick();
    assert.ok(statuses(github, 15).includes('1:claimed'), 'released recovery must leave the remaining slot available in this tick');
  });
}
// factory-holdout-30449df218baac007322944fd7064464075541c12fcbcd76b64eeb2ea2823cd7
