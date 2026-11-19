import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import type { TaskBundle } from "../../src/bench/bundle.ts";
import type { BenchRespec } from "../../src/bench/trial.ts";
import {
	assessBase,
	baseRetryFeedback,
	retryableBaseReason,
	type BaseReceipt,
	type BaseRefusal,
	type RetryFeedback,
} from "../../src/candidate/diagnosis.ts";
import { trustedTestGlobsOf } from "../../src/candidate/review.ts";
import type { Guidance, WorkflowConfig } from "../../src/config/schema.ts";
import {
	ACCEPTANCE_MAX_TOKENS,
	ACCEPTANCE_SKILLS,
	ACCEPTANCE_TOOLS,
	acceptanceDigestOf,
	acceptanceEntries,
	acceptancePrompt,
	writeAcceptance,
	type AcceptanceSuite,
} from "../../src/contract/acceptance.ts";
import { regularText } from "../../src/contract/artifacts.ts";
import {
	CONTRACT_VERSION,
	contractBytes,
	contractDigestOf,
	type Contract,
	type InlinedFile,
} from "../../src/contract/contract.ts";
import { parseSpecifyOutput } from "../../src/contract/parse.ts";
import {
	INLINE_TOTAL_BYTES,
	NAMED_FILE_BYTES,
	NAMED_FILE_READ_BYTES,
	SPECIFY_SKILLS,
	SPECIFY_TOOLS,
	inlined,
	namedFiles,
	sourceExcerpts,
	sourceFacts,
	specifySourceFacts,
	specifyPrompt,
} from "../../src/contract/prompt.ts";
import { renderSummary } from "../../src/contract/render.ts";
import type { StageLaunchInput } from "../../src/controller/launch.ts";
import { backoffMs } from "../../src/controller/orchestrator.ts";
import {
	acceptRetryUnavailable,
	retryableStageOutcome,
	stageRetryDecision,
} from "../../src/controller/retry.ts";
import { fieldOf, objectOf, parseJson, textOf } from "../../src/core/json.ts";
import { digestOf, type Digest } from "../../src/core/run.ts";
import { parseRecord, snapshotDigest } from "../../src/trust/admission.ts";
import { controllerDraftChecker } from "../controller/checkers.ts";
import {
	checkoutOf,
	checkoutWorkspace,
	type TarballFetch,
} from "../controller/checkout.ts";
import { runHeldoutBase } from "../gates/base.ts";
import { localRunner } from "../gates/runner.ts";
import { scopeOwner, scopeUnit } from "../isolation/scope.ts";
import { withSkills } from "../sandbox/executor.ts";
import {
	boundedText,
	executionCharge,
	publishFile,
	readStageReceipt,
} from "../sandbox/receipts.ts";
import { runStage, type StageHost } from "../sandbox/run-stage.ts";
import { runSpecify } from "../sandbox/specify.ts";
import { stageFailureReason } from "./report.ts";

export function offlineArchiveFetch(
	task: Pick<TaskBundle, "repo" | "base">,
	bytes: Buffer,
): TarballFetch {
	return async (repo, sha, bound) => {
		if (repo !== task.repo || sha !== task.base.sha)
			return { kind: "refused", reason: "offline_archive_binding_mismatch" };

		if (
			bound?.signal?.aborted ||
			(bound?.deadline !== undefined && Date.now() >= bound.deadline)
		)
			return { kind: "timeout" };

		return bytes;
	};
}

export async function respecInputs(tree: string, files: readonly string[]) {
	const checkout = checkoutOf(tree, files);
	const base = { files, readBase: checkout.read };

	if (!files.includes(".github/factory/gates/gates.json"))
		return { base, testFiles: undefined };

	const text = await base.readBase(
		".github/factory/gates/gates.json",
		256 * 1024,
	);

	if (text === null) throw new Error("test_inventory_unavailable");
	const policy = objectOf(parseJson(text));
	const version = fieldOf(policy, "version");
	const globs = trustedTestGlobsOf(fieldOf(policy, "testGlobs"));

	if ((version !== 1 && version !== 2) || globs === null)
		throw new Error("test_inventory_invalid");

	const groups = globs.map((glob) =>
		files.filter(
			(path) =>
				!path.startsWith("test/acceptance/") &&
				!path.startsWith("test/fixtures/") &&
				matchesGlob(path, glob),
		),
	);

	const testFiles = groups.flat().sort();

	if (
		groups.some((files) => files.length === 0) ||
		new Set(testFiles).size !== testFiles.length
	)
		throw new Error("test_inventory_invalid");

	return { base, testFiles };
}

function keep(path: string, text: string): void {
	if (!publishFile(path, text))
		throw new Error("respec_artifact_publish_failed");
}

class FailedAttempt extends Error {}

class RefusedBase extends Error {
	readonly receipt: BaseReceipt;
	readonly failure: BaseRefusal;

	constructor(receipt: BaseReceipt, failure: BaseRefusal) {
		super(failure.reason);
		this.receipt = receipt;
		this.failure = failure;
	}
}

export async function respecBench(input: {
	readonly bundle: string;
	readonly state: string;
	readonly workspace: string;
	readonly base: string;
	readonly task: TaskBundle;
	readonly id: Digest;
	readonly assets: string;
	readonly archive: Buffer;
	readonly config: WorkflowConfig;
	readonly guidance: Guidance;
	readonly metadata: { -readonly [K in keyof BenchRespec]: BenchRespec[K] };
	readonly remaining: () => number;
	readonly tokenCap: number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly host: (
		name: string,
		stage: "specify" | "accept",
		tools: readonly string[],
		attempt?: number,
	) => StageHost;
	readonly stage: <T>(name: string, run: () => Promise<T>) => Promise<T>;
}) {
	const { task, metadata } = input;

	const remainingRunTokens = () =>
		Math.max(
			0,
			Math.min(
				input.remaining(),
				input.config.usage.maxTokensPerRun -
					(input.tokenCap - input.remaining()),
			),
		);

	const retry = async (error: FailedAttempt, attempt: number) => {
		const decision = stageRetryDecision({
			usage: input.tokenCap - input.remaining(),
			charge: 0,
			attempt,
			maxTokensPerRun: Math.min(
				input.tokenCap,
				input.config.usage.maxTokensPerRun,
			),
			maxAttempts: input.config.retry.maxAttempts,
		});

		if (decision.kind === "budget_exhausted")
			throw new Error("budget_exhausted");

		if (decision.kind === "attempts") throw error;
		await input.sleep(backoffMs(attempt, input.config.retry.maxBackoffMs));
	};

	const frozen = parseJson(
		regularText(join(input.bundle, "original/admission.json"), 1024 * 1024),
	);

	const eventId = textOf(
		fieldOf(objectOf(fieldOf(objectOf(frozen), "receipt")), "eventId"),
	);

	const admission =
		eventId === null
			? null
			: parseRecord(frozen, { repo: task.repo, issue: task.issue, eventId });

	const snapshot = objectOf(fieldOf(objectOf(frozen), "snapshot"));
	const title = textOf(snapshot?.title);
	const body = textOf(snapshot?.body);

	if (
		admission === null ||
		title === null ||
		body === null ||
		snapshotDigest({ title, body }) !== task.snapshotDigest ||
		admission.snapshotDigest !== task.snapshotDigest ||
		admission.baseSha !== task.base.sha ||
		admission.workflowDigest !==
			digestOf(
				regularText(join(input.bundle, "original/WORKFLOW.md"), 256 * 1024),
			)
	)
		throw new Error("respec_snapshot_binding_mismatch");

	const privateDir = join(input.state, "respec");
	mkdirSync(privateDir, { recursive: true, mode: 0o700 });
	mkdirSync(input.workspace, { recursive: true, mode: 0o700 });
	const fetch = offlineArchiveFetch(task, input.archive);

	const authoring = await checkoutWorkspace({
		stateDir: privateDir,
		runId: input.id,
		workspace: input.workspace,
		repo: task.repo,
		sha: task.base.sha,
		fetch,
	});

	if (authoring.kind !== "ready")
		throw new Error("respec_authoring_checkout_unavailable");
	const { files } = authoring.checkout;
	const { base, testFiles } = await respecInputs(input.base, files);
	const shown: InlinedFile[] = [];
	const set = new Set(files);
	const readme = files.find((path) => /^readme\.md$/i.test(path));

	const wanted = [
		...(readme === undefined ? [] : [readme]),
		...namedFiles(`${title}\n${body}`, set),
	];

	let budget = INLINE_TOTAL_BYTES;

	for (const path of new Set(wanted)) {
		const text = await boundedText(
			join(input.workspace, path),
			NAMED_FILE_READ_BYTES,
		);

		if (text === null || budget < 1024) continue;
		const file = inlined(path, text, Math.min(NAMED_FILE_BYTES, budget));
		budget -= Buffer.byteLength(file.text, "utf8");
		shown.push(file);
	}

	const specify = input.config.stages.specify;

	const prompt = await withSkills(
		input.assets,
		`${specifyPrompt({
			repo: task.repo,
			baseSha: task.base.sha,
			guidance: input.guidance,
			files,
			inlined: shown,
			title,
			body,
			answers: null,
		})}\n`,
		SPECIFY_SKILLS,
	);

	if (prompt === null) throw new Error("specify_skills_unavailable");

	const request: StageLaunchInput = {
		runId: input.id,
		stage: "specify",
		attempt: 1,
		workspace: input.workspace,
		prompt,
		source: specifySourceFacts(shown),
		specify: { title, body, answers: null, files },
		testFiles,
		tools: SPECIFY_TOOLS,
		skills: SPECIFY_SKILLS,
		settings: {
			model: specify.model,
			fallback: specify.fallbackModel,
			budget: specify.budget,
			maxTokens: null,
		},
		remainingRunTokens: remainingRunTokens(),
		signal: new AbortController().signal,
		progress: () => {},
	};

	const specifyAttempt = async (attempt: number) => {
		const name = attempt === 1 ? "specify" : `specify-${attempt}`;
		const stageDir = join(input.state, "runtime", name);

		return input.stage("specify", async () => {
			const result = await runSpecify(
				{ ...request, attempt, remainingRunTokens: remainingRunTokens() },
				stageDir,
				(dir, tools) =>
					input.host(
						`${name}/${dir.split("/").at(-1)}`,
						"specify",
						tools,
						attempt,
					),
				base,
			);

			if (retryableStageOutcome(result.kind))
				throw new FailedAttempt(stageFailureReason("specify", stageDir));

			if (result.kind !== "passed")
				throw new Error(
					result.kind === "budget_exhausted"
						? "budget_exhausted"
						: `specify_${result.kind}`,
				);

			const parsed = parseSpecifyOutput(
				regularText(join(stageDir, "output.txt"), 256 * 1024),
				set,
			);

			if (parsed.kind === "questions") throw new Error("specify_questions");

			if (parsed.kind !== "contract")
				throw new FailedAttempt(`specify_${parsed.reason}`);

			const contract: Contract = {
				version: CONTRACT_VERSION,
				runId: input.id,
				issue: task.issue,
				base: { repo: task.repo, sha: task.base.sha },
				snapshot: {
					digest: task.snapshotDigest,
					source: admission.snapshotSource,
					eventId: admission.eventId,
					eventAt: admission.eventAt,
				},
				link: null,
				...parsed.draft,
			};

			const bytes = contractBytes(contract);
			const digest = contractDigestOf(bytes);

			if (
				renderSummary({ runId: input.id, contract: parsed.draft, digest }) ===
				null
			)
				throw new FailedAttempt("specify_too_large_to_post");

			return { contract, bytes, digest };
		});
	};

	const specified = async () => {
		for (let attempt = 1; ; attempt++) {
			try {
				return await specifyAttempt(attempt);
			} catch (error) {
				if (!(error instanceof FailedAttempt)) throw error;
				await retry(error, attempt);
			}
		}
	};

	const { contract, bytes, digest } = await specified();
	metadata.contractDigest = digest;
	keep(join(privateDir, "contract.json"), bytes);
	keep(
		join(privateDir, "contract-binding.json"),
		JSON.stringify({
			runId: input.id,
			digest,
			baseSha: task.base.sha,
			snapshotDigest: task.snapshotDigest,
		}),
	);
	const accept = input.config.stages.accept;
	let acceptWallMs = 0;
	let baseWallMs = 0;
	let spent = 0;
	let feedback: RetryFeedback | undefined;
	let previousSuite: AcceptanceSuite | undefined;

	for (let attempt = 1; ; attempt++) {
		const name =
			attempt === 1
				? "accept"
				: attempt === 2
					? "accept-retry"
					: `accept-${attempt}`;

		const stageDir = join(input.state, "runtime", name);

		const wallMs =
			feedback === undefined
				? accept.budget.wallMs
				: accept.budget.wallMs - acceptWallMs - baseWallMs;

		if (
			feedback !== undefined &&
			(spent >= ACCEPTANCE_MAX_TOKENS || wallMs <= 0)
		)
			throw new Error("budget_exhausted");

		const acceptAttempt = () =>
			input.stage("accept", async () => {
				const excerpts = await sourceExcerpts({
					files: contract.files,
					evidence: contract.evidence,
					checkout: {
						files,
						read: (path, cap) => boundedText(join(input.workspace, path), cap),
					},
					identity: `${task.repo}@${task.base.sha}`,
					repair: false,
					accept: true,
				});

				const prompt = await withSkills(
					input.assets,
					`${acceptancePrompt({
						contract,
						files,
						inlined: excerpts,
						guidance: input.guidance,
						feedback,
						previousSuite,
					})}\n`,
					ACCEPTANCE_SKILLS,
				);

				if (prompt === null) throw new Error("accept_skills_unavailable");
				mkdirSync(stageDir, { recursive: true, mode: 0o700 });

				const result = await runStage(
					{
						runId: input.id,
						stage: "accept",
						attempt,
						prompt,
						source: sourceFacts(excerpts),
						settings: {
							model: accept.model,
							fallback: accept.fallbackModel,
							budget: { ...accept.budget, wallMs },
							maxTokens: Math.min(
								ACCEPTANCE_MAX_TOKENS - (feedback === undefined ? 0 : spent),
								remainingRunTokens(),
							),
						},
						remainingRunTokens: remainingRunTokens(),
						signal: new AbortController().signal,
						progress: () => {},
						draftCheck: controllerDraftChecker({
							tooling: "running-product",
							stateDir: input.state,
							stageDir,
							attempt,
							input: {
								contract,
								digest,
								files: set,
								repo: task.repo,
								issue: task.issue,
								baseSha: task.base.sha,
							},
							fetch,
							runner: localRunner,
						}),
					},
					input.host(name, "accept", ACCEPTANCE_TOOLS, attempt),
				);

				if (retryableStageOutcome(result.kind))
					throw new FailedAttempt(stageFailureReason("accept", stageDir));

				if (result.kind !== "passed")
					throw new Error(
						result.kind === "budget_exhausted"
							? "budget_exhausted"
							: `accept_${result.kind}`,
					);

				const parsed = writeAcceptance(
					regularText(join(stageDir, "output.txt"), 256 * 1024),
					contract,
					set,
				);

				if (parsed.kind !== "suite")
					throw new FailedAttempt(`accept_${parsed.reason}`);

				return parsed.suite;
			});

		let accepted: AcceptanceSuite;
		let attemptCharge = 0;

		const charge = async () => {
			attemptCharge = (await executionCharge(stageDir))?.total ?? 0;
			spent += attemptCharge;
			acceptWallMs +=
				(await readStageReceipt(join(stageDir, "receipt.json")))?.wallMs ?? 0;
		};

		try {
			accepted = await acceptAttempt();
		} catch (error) {
			await charge();

			if (!(error instanceof FailedAttempt)) throw error;
			await retry(error, attempt);
			continue;
		}

		await charge();

		const canary = `factory-holdout-${randomBytes(32).toString("hex")}`;
		const acceptanceDigest = acceptanceDigestOf(accepted, canary);
		metadata.acceptanceDigest = acceptanceDigest;
		const entries = acceptanceEntries(accepted, canary);

		for (const [path, content] of entries) {
			const target = join(privateDir, "acceptance", path);
			mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
			keep(target, content);
		}

		const baseStarted = Date.now();

		try {
			await input.stage("accept-base", async () => {
				const startedAt = Date.now();

				const boundedDeadline =
					startedAt +
					Math.min(180_000, accept.budget.wallMs - acceptWallMs - baseWallMs);

				if (boundedDeadline <= startedAt) throw new Error("base_timeout");
				const signal = AbortSignal.timeout(boundedDeadline - startedAt);
				const workDir = join(privateDir, `accept-base-${attempt}`);
				const tree = join(workDir, "source");
				mkdirSync(tree, { recursive: true, mode: 0o700 });

				const checked = await checkoutWorkspace({
					stateDir: workDir,
					runId: input.id,
					workspace: tree,
					repo: task.repo,
					sha: task.base.sha,
					fetch,
					signal,
					deadline: boundedDeadline,
				});

				const binding = {
					runId: input.id,
					repo: task.repo,
					issue: task.issue,
					contractDigest: digest,
					acceptanceDigest,
					baseSha: task.base.sha,
					gateSha: task.base.sha,
				};

				const evidence = await runHeldoutBase({
					tooling: "running-product",
					tree,
					workDir,
					cacheDir: join(input.state, "base-dependencies"),
					binding,
					contract,
					suite: accepted,
					canary,
					startedAt,
					deadline: boundedDeadline,
					signal,
					scope: scopeUnit(
						scopeOwner(input.state),
						input.id,
						"basecheck",
						attempt,
						randomBytes(4).toString("hex"),
					),
					runner: localRunner,
					refused:
						checked.kind === "unavailable"
							? "tree_unavailable"
							: checked.kind === "refused"
								? "tree_refused"
								: checked.omitted !== 0
									? "tree_partial"
									: undefined,
				});

				const { receipt, assessment } = assessBase(evidence);
				const text = JSON.stringify(receipt);
				const receiptDigest = digestOf(text);
				keep(join(workDir, "base-receipt.json"), text);
				keep(join(workDir, "base-receipt.sha256"), `${receiptDigest}\n`);

				if (assessment.kind === "refused")
					throw new RefusedBase(receipt, assessment.failure);

				keep(join(privateDir, "base-receipt.json"), text);
				keep(join(privateDir, "base-receipt.sha256"), `${receiptDigest}\n`);

				if (assessment.proof.receiptDigest !== receiptDigest)
					throw new Error("base_evidence_missing");
				metadata.baseReceiptDigest = receiptDigest;
			});
		} catch (error) {
			if (!(error instanceof RefusedBase)) throw error;
			const refusedWallMs = Date.now() - baseStarted;
			const charge = await executionCharge(stageDir);

			if (charge !== null) spent += Math.max(0, charge.total - attemptCharge);

			if (
				feedback === undefined &&
				retryableBaseReason(error.failure.reason) &&
				acceptRetryUnavailable({
					attempt,
					maxAttempts: input.config.retry.maxAttempts,
					spent: charge === null ? null : spent,
					maxTokens: ACCEPTANCE_MAX_TOKENS,
					remainingRunTokens: remainingRunTokens(),
					baseWallMs: refusedWallMs,
					remainingWallMs: accept.budget.wallMs - acceptWallMs - refusedWallMs,
				}) === null
			) {
				baseWallMs = refusedWallMs;
				renameSync(
					join(privateDir, "acceptance"),
					join(privateDir, `accept-base-${attempt}/acceptance`),
				);
				metadata.baseRetryReason = error.failure.reason;
				feedback = baseRetryFeedback(error.receipt, error.failure);
				previousSuite = accepted;
				continue;
			}

			const text = JSON.stringify(error.receipt);
			keep(join(privateDir, "base-receipt.json"), text);
			keep(join(privateDir, "base-receipt.sha256"), `${digestOf(text)}\n`);
			throw error;
		}

		return {
			contract,
			digest,
			suite: accepted,
			acceptanceDigest,
			checks: entries
				.filter(([path]) => path.startsWith("checks/"))
				.map(([path, content]) => ({
					path: path.slice("checks/".length),
					bytes: Buffer.from(content),
				})),
		};
	}
}
