import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
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
import { fieldOf, objectOf, parseJson, textOf } from "../../src/core/json.ts";
import { digestOf, type Digest } from "../../src/core/run.ts";
import { parseRecord, snapshotDigest } from "../../src/trust/admission.ts";
import { controllerDraftChecker } from "../controller/checkers.ts";
import {
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
} from "../sandbox/receipts.ts";
import { runStage, type StageHost } from "../sandbox/run-stage.ts";
import { runSpecify } from "../sandbox/specify.ts";

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

function keep(path: string, text: string): void {
	if (!publishFile(path, text))
		throw new Error("respec_artifact_publish_failed");
}

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
	readonly task: TaskBundle;
	readonly id: Digest;
	readonly assets: string;
	readonly archive: Buffer;
	readonly config: WorkflowConfig;
	readonly guidance: Guidance;
	readonly metadata: { -readonly [K in keyof BenchRespec]: BenchRespec[K] };
	readonly remaining: () => number;
	readonly host: (
		name: string,
		stage: "specify" | "accept",
		tools: readonly string[],
		attempt?: number,
	) => StageHost;
	readonly stage: <T>(name: string, run: () => Promise<T>) => Promise<T>;
}) {
	const { task, metadata } = input;

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
		tools: SPECIFY_TOOLS,
		skills: SPECIFY_SKILLS,
		settings: {
			model: specify.model,
			fallback: specify.fallbackModel,
			budget: specify.budget,
			maxTokens: null,
		},
		remainingRunTokens: input.remaining(),
		signal: new AbortController().signal,
		progress: () => {},
	};

	await input.stage("specify", async () => {
		const result = await runSpecify(
			request,
			join(input.state, "runtime/specify"),
			(dir, tools) =>
				input.host(`specify/${dir.split("/").at(-1)}`, "specify", tools),
		);

		if (result.kind !== "passed")
			throw new Error(
				result.kind === "budget_exhausted"
					? "budget_exhausted"
					: `specify_${result.kind}`,
			);
	});

	const parsed = parseSpecifyOutput(
		regularText(join(input.state, "runtime/specify/output.txt"), 256 * 1024),
		set,
	);

	if (parsed.kind !== "contract")
		throw new Error(
			parsed.kind === "questions"
				? "specify_questions"
				: `specify_${parsed.reason}`,
		);

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
		renderSummary({ runId: input.id, contract: parsed.draft, digest }) === null
	)
		throw new Error("specify_too_large_to_post");
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
	const acceptStarted = Date.now();
	const deadline = acceptStarted + accept.budget.wallMs;
	let spent = 0;
	let feedback: RetryFeedback | undefined;
	let previousSuite: AcceptanceSuite | undefined;

	for (let attempt = 1; ; attempt++) {
		const name = attempt === 1 ? "accept" : "accept-retry";
		const stageDir = join(input.state, "runtime", name);

		const accepted = await input.stage("accept", async () => {
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
						budget: {
							...accept.budget,
							wallMs: Math.max(0, deadline - Date.now()),
						},
						maxTokens: Math.min(
							ACCEPTANCE_MAX_TOKENS - spent,
							input.remaining(),
						),
					},
					remainingRunTokens: input.remaining(),
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

			if (parsed.kind !== "suite") throw new Error(`accept_${parsed.reason}`);

			return parsed.suite;
		});

		const canary = `factory-holdout-${randomBytes(32).toString("hex")}`;
		const acceptanceDigest = acceptanceDigestOf(accepted, canary);
		metadata.acceptanceDigest = acceptanceDigest;
		const entries = acceptanceEntries(accepted, canary);

		for (const [path, content] of entries) {
			const target = join(privateDir, "acceptance", path);
			mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
			keep(target, content);
		}

		try {
			await input.stage("accept-base", async () => {
				const startedAt = Date.now();
				const boundedDeadline = Math.min(deadline, startedAt + 180_000);

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
			const charge = await executionCharge(stageDir);

			if (
				attempt === 1 &&
				attempt < input.config.retry.maxAttempts &&
				retryableBaseReason(error.failure.reason) &&
				charge !== null &&
				charge.total < ACCEPTANCE_MAX_TOKENS &&
				input.remaining() > 0 &&
				Date.now() < deadline
			) {
				renameSync(
					join(privateDir, "acceptance"),
					join(privateDir, "accept-base-1/acceptance"),
				);
				spent = charge.total;
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
