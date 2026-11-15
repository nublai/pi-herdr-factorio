import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world, labeled, statuses } from '../../../../test/src/controller/orchestrator-fixtures.ts';
import { parseMarker, formatMarker } from '../../../../src/trust/markers.ts';
import { digestOf } from '../../../../src/core/run.ts';

for (const status of ['released', 'failed', 'budget_exhausted']) {
  test(`missing local claim does not excuse ${status} admission mismatch`, async () => {
    const ctx = world();
    const issue = ctx.github.add(labeled(14));
    await ctx.start().tick();
    const parsed = parseMarker(ctx.github.markers(14).at(-1) ?? '');
    assert.equal(parsed.kind, 'marker');
    assert.ok(ctx.store.records.size > 0);
    ctx.files.claims.clear();
    issue.comments = [];
    ctx.github.comment(issue, formatMarker({ ...parsed.marker, seq: 3, status, workflowDigest: digestOf('different workflow') }));
    const launches = ctx.executor.launches.length;
    const report = await ctx.start().tick();
    assert.deepEqual(report.corrupt, [{ issue: 14, defect: 'record_mismatch' }]);
    assert.equal(ctx.files.claims.size, 0, 'invalid terminal evidence must not create a claim');
    assert.equal(ctx.executor.launches.length, launches);
    assert.deepEqual(statuses(ctx.github, 14), [`3:${status}`]);
  });
}
// factory-holdout-3d197e53692c5f17d0cca3dc0771bcc08ddc0824ebb877685e283dd453a07526
