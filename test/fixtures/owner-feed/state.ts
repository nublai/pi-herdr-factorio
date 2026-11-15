import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
	fileAdmissionStore,
	snapshotDigest,
} from "../../../src/trust/admission.ts";
import { type Digest, digestOf, runIdOf } from "../../../src/core/run.ts";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import { fileArtifacts } from "../../../src/contract/artifacts.ts";
import {
	type Contract,
	contractBytes,
	contractDigestOf,
} from "../../../src/contract/contract.ts";
import { validationDir } from "../../../src/candidate/validation.ts";
import { type GenerationRef, refOf } from "../../../src/candidate/state.ts";
import { isGitSha } from "../../../src/config/schema.ts";
import { isRepoSlug } from "../../../src/trust/platform.ts";
import type { JsonValue } from "../../../src/core/json.ts";
import { candidateLifecycleFixture } from "../../helpers.ts";
import { parseCandidateState } from "../../../src/candidate/codec.ts";
import {
	candidateUsage,
	candidateProjection,
} from "../../../src/candidate/handoff.ts";

const slug = "giuseppecrj/pi-herdr-factorio";

function fixtureSha(text: string) {
	assert.ok(isGitSha(text));

	return text;
}

const sha = fixtureSha("a".repeat(40));

assert.ok(isRepoSlug(slug));

export const repo = slug;
export const now = Date.parse("2026-11-09T18:00:00Z");

export async function save(root: string, parts: string[], value: JsonValue) {
	const path = join(root, ...parts);
	await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
	await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

export async function addRun(
	root: string,
	issue: number,
	status: string,
	options: {
		title?: string;
		body?: string;
		enteredAt?: number;
		stage?: string;
		eventId?: string;
		seq?: number;
		handoff?: JsonValue;
	} = {},
) {
	const eventId = options.eventId ?? "1";
	const runId = runIdOf({ repo, issue, eventId });

	const snapshot = {
		title: options.title ?? `Ticket ${issue}`,
		body: options.body ?? "Fixture only.",
	};

	await fileAdmissionStore(root).record(
		{
			repo,
			issue,
			issueUrl: `https://github.com/${repo}/issues/${issue}`,
			decision: "admitted",
			reasons: [],
			eventId,
			eventAt: new Date(now - 86_400_000).toISOString().replace(".000Z", "Z"),
			actor: "owner",
			actorPermission: "write",
			snapshotDigest: snapshotDigest(snapshot),
			snapshotSource: "unedited",
			baseSha: sha,
			workflowDigest: digestOf("workflow"),
		},
		snapshot,
	);

	const record = {
		runId,
		issue,
		eventId,
		seq: options.seq ?? 1,
		status,
		stage: options.stage ?? "specify",
		enteredAt: options.enteredAt ?? now - 1000,
		usage: 1234,
		attempt: 1,
		round: 0,
	};

	if (options.handoff === undefined)
		await save(root, ["claims", `${runId}.json`], record);
	else {
		const book = parseCandidateState(options.handoff);
		assert.ok(book !== null);
		await save(root, ["claims", `${runId}.json`], {
			...record,
			handoff: options.handoff,
			usage: candidateUsage(book),
		});
	}

	return runId;
}

/** A published PR that is certified and waiting for the owner's review. */
function waitingBook(acceptanceDigest?: Digest) {
	const refreshing = candidateLifecycleFixture(
		acceptanceDigest === undefined ? {} : { acceptanceDigest },
	);

	assert.ok(refreshing.kind === "selected");

	const certified = refreshing.history.find(
		(entry) => entry.intent.digest === refreshing.published?.promoted.digest,
	);

	assert.ok(
		certified?.certification !== null &&
			certified !== undefined &&
			refreshing.published !== null,
	);

	const ready = {
		...refreshing,
		current: certified,
		history: refreshing.history.filter((entry) => entry !== certified),
		published: {
			...refreshing.published,
			readiness: { kind: "ready", since: now - 4 * 86_400_000 },
		},
		work: { kind: "waiting" },
	};

	const book = parseCandidateState(JSON.parse(JSON.stringify(ready)));
	assert.ok(book !== null);

	return { book, projection: candidateProjection(book) };
}

/**
 * A run whose certified PR waits for the owner, which is the pr_review kind.
 * The candidate book is pinned to issue 1, so the run must be issue 1.
 */
export async function addWaitingRun(
	root: string,
	title: string,
	acceptanceDigest?: Digest,
) {
	const { book, projection } = waitingBook(acceptanceDigest);

	return addRun(root, 1, projection.status, {
		title,
		stage: projection.stage,
		enteredAt: now - 4 * 86_400_000,
		handoff: JSON.parse(JSON.stringify(book)),
	});
}

/**
 * Holds the waiting run on issue 1 as `review_unverifiable`, with these
 * code-review judgments on its current review. Calling it again replaces them.
 * Returns the held generation's reference.
 */
export async function holdUnverifiable(
	root: string,
	runId: string,
	judgments: readonly { scenario: string; reason: string }[],
): Promise<GenerationRef> {
	const path = join(root, "claims", `${runId}.json`);
	const claim = JSON.parse(await readFile(path, "utf8"));
	const review = claim.handoff.current.certification.review;
	const reason = "review_unverifiable";

	await save(root, ["claims", `${runId}.json`], {
		...claim,
		status: "blocked",
		handoff: {
			...claim.handoff,
			current: {
				...claim.handoff.current,
				review: {
					...review,
					blocking: true,
					seats: review.seats.map((seat: { seat: string }) =>
						seat.seat === "code-review"
							? {
									...seat,
									judgments: judgments.map((j) => ({
										...j,
										outcome: "unverifiable",
									})),
								}
							: seat,
					),
				},
			},
			published: {
				...claim.handoff.published,
				readiness: { kind: "not_ready", reason, since: now },
			},
			work: { kind: "held", reason, since: now },
		},
	});

	const book = parseCandidateState(claim.handoff);
	assert.ok(book?.kind === "selected");

	return refOf(book.current.intent);
}

/**
 * Saves the trusted gate receipt and CI report of the run's current
 * generation, matching its stored verdict, so `trustedEvidence` accepts them.
 */
export async function saveTrustedRecords(root: string, runId: string) {
	const claim = JSON.parse(
		await readFile(join(root, "claims", `${runId}.json`), "utf8"),
	);

	const book = parseCandidateState(claim.handoff);
	assert.ok(book?.kind === "selected");
	const { intent, verdict, report } = book.current;
	assert.ok(verdict !== null && report !== null);

	const dir = relative(
		root,
		validationDir(root, runId, intent.round, intent.generation),
	).split(sep);

	await save(root, [...dir, "report.json"], report);
	await save(root, [...dir, "receipt.json"], {
		version: 2,
		status: "passed",
		modelCalls: 0,
		candidateSha: verdict.candidateSha,
		gateSha: verdict.gateSha,
		heldoutDigest: verdict.heldoutDigest,
		nonce: report.nonce,
		requiredChecks: [...verdict.requiredChecks],
		heldoutFailures: [],
		heldoutCounts: { "test/acceptance/1/checks/a.test.ts": 1 },
		checks: verdict.requiredChecks.map((name) => ({
			name,
			exitCode: 0,
			durationMs: 1000,
			signal: null,
		})),
	});
}

/**
 * Stores a contract and an acceptance suite for issue 1's run: S1 is checked,
 * and each `judges` entry is a judge-only scenario. Returns the suite's
 * acceptance digest.
 */
export async function saveJudgeSuite(
	root: string,
	judges: Readonly<Record<string, string>>,
): Promise<Digest> {
	const runId = runIdOf({ repo, issue: 1, eventId: "1" });

	const contract: Contract = {
		version: 2,
		runId,
		issue: 1,
		base: { repo, sha },
		snapshot: {
			digest: digestOf("snapshot"),
			source: "unedited",
			eventId: "1",
			eventAt: new Date(now - 86_400_000).toISOString(),
		},
		link: null,
		summary: "Change a",
		behavior: ["Return 2"],
		acceptance: [{ id: "A1", kind: "new_behavior", text: "Return 2" }],
		exclusions: [],
		compatibility: [],
		limits: [],
		files: ["src/a.ts"],
		evidence: [],
	};

	const bytes = contractBytes(contract);
	const contractDigest = contractDigestOf(bytes);
	assert.ok(
		await fileRunFiles(root).writeContract({
			contract,
			bytes,
			digest: contractDigest,
		}),
	);

	const stored = await fileArtifacts(root).store({
		contract,
		contractDigest,
		suite: {
			version: 2,
			scenarios: [
				{
					id: "S1",
					kind: "new_behavior",
					criteria: ["A1"],
					checks: ["a.test.ts"],
					judge: null,
				},
				...Object.entries(judges).map(([id, judge]) => ({
					id,
					kind: "new_behavior" as const,
					criteria: ["A1"],
					checks: [],
					judge,
				})),
			],
			files: [
				{
					path: "a.test.ts",
					type: "node:test",
					content: "import {test} from 'node:test'; test('a',()=>{});",
				},
			],
		},
		model: "openai/gpt-6.1-sol",
		observed: null,
	});

	assert.ok(stored.kind === "found");

	return stored.receipt.acceptanceDigest;
}

/** A run that continues an answered question, which is the question_answered kind. */
export async function addAnsweredRun(
	root: string,
	issue: number,
	title: string,
) {
	const runId = await addRun(root, issue, "running", {
		title,
		stage: "specify",
		eventId: "2",
	});

	await save(root, ["links", `${runId}.json`], {
		version: 1,
		prevRunId: runIdOf({ repo, issue, eventId: "1" }),
		questionsDigest: digestOf("questions"),
		answersDigest: digestOf("answers"),
	});

	return runId;
}

/** A run the controller stopped with a recorded failure, which is the failed kind. */
export async function addFailedRun(root: string, issue: number, title: string) {
	const failed = await addRun(root, issue, "failed", { title, stage: "land" });

	await save(root, ["ledger", failed, "terminal.json"], {
		v: 5,
		repo,
		runId: failed,
		terminalObservedAt: new Date(now - 1000).toISOString(),
		outcome: {
			kind: "failed",
			stage: "land",
			cause: { kind: "known", value: "input_refused" },
		},
		failure: {
			kind: "known",
			value: {
				stage: "review",
				class: "input",
				reason: "review_input_too_large",
				failedVisibleChecks: [],
				retainedPatch: null,
			},
		},
	});

	return failed;
}

/** The minimal controller state a feed read needs, with no runs. */
export async function emptyState(root: string) {
	await mkdir(join(root, "claims"), { mode: 0o700, recursive: true });
	await save(root, ["status.json"], {
		repo,
		at: new Date(now - 12_000).toISOString(),
	});
}

export async function ownerState(root: string) {
	await mkdir(join(root, "claims"), { mode: 0o700, recursive: true });
	await save(root, ["status.json"], {
		repo,
		at: new Date(now - 12_000).toISOString(),
		corrupt: [{ issue: 99, defect: "duplicate_seq" }],
	});
	await save(root, ["metrics.json"], {
		durableUsage: { kind: "lower_bound", total: 5200000 },
	});

	const waiting = await addWaitingRun(
		root,
		"Let the owner review the dashboard",
	);

	await addRun(root, 2, "blocked", {
		title: "Check the saved input",
		enteredAt: now - 7 * 3_600_000,
	});
	await addRun(root, 3, "budget_exhausted", {
		title: "Stop when the token budget is used",
	});

	const failed = await addFailedRun(
		root,
		4,
		"Review a change that is too large",
	);

	await addRun(root, 5, "running", {
		title: "Build the next small feature",
		stage: "build",
	});

	const landed = await addRun(root, 6, "landed", {
		title: "Keep token accounting honest",
		stage: "land",
		enteredAt: now - 86_400_000,
	});

	await addRun(root, 7, "released", {
		title: "An older closed ticket",
		enteredAt: now - 8 * 86_400_000,
	});
	await addRun(root, 8, "needs_info", {
		title: "Ask before changing the product",
	});
	await addRun(root, 99, "retrying", {
		title: "Unreadable run must not count as working",
	});

	return { waiting, failed, landed };
}
