import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world, labeled, runOf } from '../../../../test/src/controller/orchestrator-fixtures.ts';
import { parseMarker, formatMarker } from '../../../../src/trust/markers.ts';
import { digestOf } from '../../../../src/core/run.ts';

for (const status of ['released', 'failed', 'budget_exhausted']) {
  test(`already ended claim is not rewritten by mismatching ${status}`, async () => {
    const ctx = world();
    const issue = ctx.github.add(labeled(14));
    await ctx.start().tick();
    issue.labels = [];
    await ctx.start().tick();
    const before = structuredClone(ctx.files.claims.get(runOf(14)));
    assert.ok(before);
    assert.equal(before.status, 'released');
    const parsed = parseMarker(ctx.github.markers(14).at(-1) ?? '');
    assert.equal(parsed.kind, 'marker');
    issue.comments = [];
    ctx.github.comment(issue, formatMarker({ ...parsed.marker, seq: parsed.marker.seq + 1, status, workflowDigest: digestOf('different workflow') }));
    const report = await ctx.start().tick();
    assert.deepEqual(report.corrupt, [{ issue: 14, defect: 'record_mismatch' }]);
    assert.deepEqual(ctx.files.claims.get(runOf(14)), before);
  });
}
// factory-holdout-3d197e53692c5f17d0cca3dc0771bcc08ddc0824ebb877685e283dd453a07526
