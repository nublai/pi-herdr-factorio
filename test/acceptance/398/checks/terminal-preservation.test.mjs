import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world, labeled, runOf, blockedClaim, statuses, relabel } from '../../../../test/src/controller/orchestrator-fixtures.ts';
import { parseMarker, formatMarker } from '../../../../src/trust/markers.ts';
import { digestOf } from '../../../../src/core/run.ts';
import { READY_LABEL } from '../../../../src/trust/policy.ts';

async function admitted() {
  const ctx = world();
  const issue = ctx.github.add(labeled(14));
  await ctx.start().tick();
  const parsed = parseMarker(ctx.github.markers(14).at(-1) ?? '');
  assert.equal(parsed.kind, 'marker');
  return { ctx, issue, marker: parsed.marker };
}

for (const status of ['released', 'failed', 'budget_exhausted']) {
  test(`active claim rejects mismatching ${status}`, async () => {
    const { ctx, issue, marker } = await admitted();
    issue.comments = [];
    ctx.github.comment(issue, formatMarker({ ...marker, seq: 3, status, workflowDigest: digestOf('different workflow') }));
    const report = await ctx.start().tick();
    assert.deepEqual(report.corrupt, [{ issue: 14, defect: 'record_mismatch' }]);
    assert.deepEqual(ctx.files.claims.get(runOf(14)), blockedClaim(14, 2));
    assert.deepEqual(statuses(ctx.github, 14), [`3:${status}`]);
  });
  for (const absent of [false, true]) {
    test(`matching ${status}, admission absent=${absent}`, async () => {
      const { ctx, issue, marker } = await admitted();
      if (absent) ctx.store.records.clear();
      issue.comments = [];
      ctx.github.comment(issue, formatMarker({ ...marker, seq: 3, status }));
      const report = await ctx.start().tick();
      assert.deepEqual(report.corrupt, []);
      assert.equal(ctx.files.claims.get(runOf(14))?.status, status);
      assert.equal(ctx.files.claims.get(runOf(14))?.seq, 3);
    });
  }
}

test('unreadable admission does not authorize rewriting an active claim', async () => {
  const { ctx, issue, marker } = await admitted();
  const before = structuredClone(ctx.files.claims.get(runOf(14)));
  ctx.store.read = async () => ({ kind: 'unreadable' });
  issue.comments = [];
  ctx.github.comment(issue, formatMarker({ ...marker, seq: 3, status: 'released' }));
  const launches = ctx.executor.launches.length;
  await ctx.start().tick();
  assert.deepEqual(ctx.files.claims.get(runOf(14)), before);
  assert.equal(ctx.executor.launches.length, launches);
});

test('nonterminal admission disagreement remains corrupt', async () => {
  const { ctx, issue, marker } = await admitted();
  issue.comments = [];
  ctx.github.comment(issue, formatMarker({ ...marker, seq: 3, status: 'blocked', workflowDigest: digestOf('different workflow') }));
  const report = await ctx.start().tick();
  assert.deepEqual(report.corrupt, [{ issue: 14, defect: 'record_mismatch' }]);
  assert.deepEqual(ctx.files.claims.get(runOf(14)), blockedClaim(14, 2));
});

test('older ended event stays ended when a newer event has the highest record', async () => {
  const { github, executor, start } = world();
  const issue = github.add(labeled(14));
  const first = [...issue.timeline];
  await start().tick();
  relabel(github, issue);
  await start().tick();
  issue.labels = [];
  await start().tick();
  assert.deepEqual(statuses(github, 14), ['1:claimed', '2:blocked', '3:released', '4:claimed', '5:blocked', '6:released']);
  const launches = executor.launches.length;
  issue.labels = [READY_LABEL];
  issue.timeline = first;
  issue.comments = issue.comments.filter(comment => !comment.body.includes(runOf(14)));
  issue.updatedAt = '2026-10-29T02:40:00Z';
  const report = await start().tick();
  assert.deepEqual(report.runs, []);
  assert.equal(executor.launches.length, launches);
  assert.deepEqual(statuses(github, 14), ['4:claimed', '5:blocked', '6:released']);
});
// factory-holdout-3d197e53692c5f17d0cca3dc0771bcc08ddc0824ebb877685e283dd453a07526
