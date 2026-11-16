import { execFileSync } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	BUILDER_INPUT,
	type TaskBundle,
	bundleJson,
	createManifest,
	isBundlePath,
	verifyTaskBundle,
} from "../../src/bench/bundle.ts";
import { readPatch } from "../../src/candidate/build.ts";
import { parseWorkflow } from "../../src/config/parse.ts";
import { WORKFLOW_PATH, type EnvLookup } from "../../src/config/schema.ts";
import {
	acceptanceDigestOf,
	acceptanceEntries,
	CANARY,
	readAcceptanceSuite,
} from "../../src/contract/acceptance.ts";
import {
	fileArtifacts,
	parseStoredContract,
	readStoredContract,
	regularBytes,
} from "../../src/contract/artifacts.ts";
import { contractBytes } from "../../src/contract/contract.ts";
import { fieldOf, objectOf, parseJson, textOf } from "../../src/core/json.ts";
import { type Digest, digestOf } from "../../src/core/run.ts";
import { frozenRowOf } from "../../src/ledger/schema.ts";
import {
	fileAdmissionStore,
	parseRecord,
	snapshotDigest,
} from "../../src/trust/admission.ts";
import type { PlatformProfile } from "../../src/trust/platform.ts";

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const GATE_POLICY = ".github/factory/gates/gates.json";

function git(repository: string, args: readonly string[]): Buffer {
	return execFileSync("git", ["-C", repository, ...args], {
		maxBuffer: MAX_FILE_BYTES,
		timeout: 30_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function bundleFiles(root: string): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	let total = 0;

	const walk = (prefix: string): void => {
		const dir = join(root, prefix);
		const info = lstatSync(dir);

		if (!info.isDirectory() || (info.mode & 0o777) !== 0o700)
			throw new Error(`unsafe_bundle_directory: ${prefix || "."}`);

		for (const name of readdirSync(dir).sort()) {
			const path = prefix === "" ? name : `${prefix}/${name}`;

			if (!isBundlePath(path)) throw new Error(`invalid_bundle_path: ${path}`);
			const entry = lstatSync(join(root, path));

			if (entry.isDirectory()) walk(path);
			else {
				if (
					!entry.isFile() ||
					(entry.mode & 0o777) !== 0o600 ||
					entry.size > MAX_FILE_BYTES
				)
					throw new Error(`unsafe_bundle_file: ${path}`);
				total += entry.size;

				if (total > MAX_BUNDLE_BYTES) throw new Error("bundle_too_large");
				files.set(path, readFileSync(join(root, path)));
			}
		}
	};

	walk("");

	return files;
}

function verifyEvidence(files: ReadonlyMap<string, Buffer>) {
	const verified = verifyTaskBundle(files);
	const { task } = verified;

	const bytes = (path: string): Buffer => {
		const value = files.get(path);

		if (value === undefined) throw new Error(`file_missing: ${path}`);

		return value;
	};

	const text = (path: string) => bytes(path).toString("utf8");
	const row = frozenRowOf(bytes(task.original))?.row;

	if (
		row === undefined ||
		row.runId !== task.runId ||
		row.repo !== task.repo ||
		row.issue !== task.issue ||
		row.snapshotDigest !== task.snapshotDigest ||
		row.originalBase !== task.base.sha
	)
		throw new Error("original_row_binding_mismatch");

	const stored = parseStoredContract(
		text(BUILDER_INPUT.contract),
		text("original/contract-receipt.json"),
		task.runId,
	);

	if (
		stored.kind !== "found" ||
		stored.digest !== task.contractDigest ||
		stored.contract.base.sha !== task.base.sha ||
		stored.contract.base.repo !== task.repo ||
		stored.contract.issue !== task.issue ||
		stored.contract.snapshot.digest !== task.snapshotDigest ||
		stored.contract.snapshot.eventId !== row.eventId
	)
		throw new Error("contract_binding_mismatch");
	const issue = objectOf(parseJson(text(BUILDER_INPUT.issue)));
	const title = textOf(fieldOf(issue, "title"));
	const body = textOf(fieldOf(issue, "body"));

	const admission = parseRecord(
		parseJson(text("original/admission.json")),
		row,
	);

	if (
		title === null ||
		body === null ||
		snapshotDigest({ title, body }) !== task.snapshotDigest ||
		admission === null ||
		admission.snapshotDigest !== task.snapshotDigest
	)
		throw new Error("issue_snapshot_mismatch");
	const kept = objectOf(parseJson(text("oracle/suite.json")));

	if (kept === null) throw new Error("invalid_oracle_suite");
	const { canary: rawCanary, ...suiteBody } = kept;
	const canary = textOf(rawCanary);
	const suite = readAcceptanceSuite(suiteBody, stored.contract);

	if (
		suite.kind !== "suite" ||
		canary === null ||
		!CANARY.test(canary) ||
		acceptanceDigestOf(suite.suite, canary) !== task.acceptanceDigest
	)
		throw new Error("oracle_digest_mismatch");
	const expectedOracle = new Set(["oracle/receipt.json"]);

	for (const [path, content] of acceptanceEntries(suite.suite, canary)) {
		const name = `oracle/${path}`;
		expectedOracle.add(name);

		if (digestOf(bytes(name)) !== digestOf(content))
			throw new Error(`oracle_file_mismatch: ${name}`);
	}

	for (const path of files.keys()) {
		if (path.startsWith("oracle/") && !expectedOracle.has(path))
			throw new Error(`unexpected_oracle_file: ${path}`);
	}

	const receipt = objectOf(parseJson(text("oracle/receipt.json")));

	if (
		fieldOf(receipt, "runId") !== task.runId ||
		fieldOf(receipt, "contractDigest") !== task.contractDigest ||
		fieldOf(receipt, "acceptanceDigest") !== task.acceptanceDigest ||
		fieldOf(receipt, "baseSha") !== task.base.sha
	)
		throw new Error("oracle_receipt_mismatch");

	if (
		("contractDigest" in row.artifacts &&
			row.artifacts.contractDigest !== task.contractDigest) ||
		("acceptanceDigest" in row.artifacts &&
			row.artifacts.acceptanceDigest !== task.acceptanceDigest)
	)
		throw new Error("ledger_artifact_mismatch");

	return verified;
}

export function verifyBundle(root: string) {
	return verifyEvidence(bundleFiles(resolve(root)));
}

export async function exportBundle(input: {
	readonly stateDir: string;
	readonly runId: Digest;
	readonly out: string;
	readonly repository: string;
	readonly platform: PlatformProfile;
	readonly env: EnvLookup;
}) {
	const stateDir = resolve(input.stateDir);
	const out = resolve(input.out);

	const outputRelativeToState = relative(stateDir, out);

	if (
		outputRelativeToState !== ".." &&
		!outputRelativeToState.startsWith("../")
	)
		throw new Error("output_inside_state_directory");

	const rowBytes = regularBytes(
		join(stateDir, "ledger", input.runId, "row.json"),
		MAX_FILE_BYTES,
	);

	const frozen = frozenRowOf(rowBytes);

	if (frozen === null || frozen.row.runId !== input.runId)
		throw new Error("finished_run_missing_or_invalid");
	const { row } = frozen;
	const stored = readStoredContract(stateDir, input.runId);

	if (stored.kind !== "found") throw new Error(stored.reason);
	const { contract, digest: contractDigest } = stored;

	const acceptance = await fileArtifacts(stateDir).read(
		input.runId,
		contract,
		contractDigest,
	);

	if (acceptance.kind !== "found")
		throw new Error(
			acceptance.kind === "blocked" ? acceptance.reason : "acceptance_missing",
		);
	const admission = await fileAdmissionStore(stateDir).readSnapshot(row);

	if (admission.kind !== "found") throw new Error("issue_snapshot_unavailable");
	const repository = resolve(input.repository);
	const base = git(repository, ["archive", "--format=tar", row.originalBase]);

	const workflow = git(repository, [
		"show",
		`${row.originalBase}:${WORKFLOW_PATH}`,
	]);

	const gates = git(repository, ["show", `${row.originalBase}:${GATE_POLICY}`]);

	const admittedWorkflow = git(repository, [
		"show",
		`${admission.receipt.baseSha}:${WORKFLOW_PATH}`,
	]);

	if (digestOf(admittedWorkflow) !== admission.receipt.workflowDigest)
		throw new Error("admitted_workflow_digest_mismatch");

	const parsed = parseWorkflow({
		text: admittedWorkflow.toString("utf8"),
		repo: row.repo,
		env: input.env,
		platform: input.platform,
	});

	if (parsed.kind !== "valid") throw new Error("admitted_workflow_invalid");

	const task: TaskBundle = {
		version: 1,
		kind: "factory_benchmark_task",
		runId: input.runId,
		repo: row.repo,
		issue: row.issue,
		snapshotDigest: row.snapshotDigest,
		contractDigest,
		acceptanceDigest: acceptance.receipt.acceptanceDigest,
		base: {
			sha: row.originalBase,
			archive: "builder/base.tar",
			digest: digestOf(base),
		},
		builderInput: "builder/input.json",
		oracle: "oracle/",
		original: "original/row.json",
	};

	const files = new Map<string, Buffer>();

	const put = (path: string, text: string | Uint8Array) =>
		files.set(path, Buffer.from(text));

	put("task.json", bundleJson(task));
	put("builder/input.json", bundleJson(BUILDER_INPUT));
	put(BUILDER_INPUT.issue, bundleJson(admission.snapshot));
	put(BUILDER_INPUT.contract, contractBytes(contract));
	put(BUILDER_INPUT.base, base);
	put(BUILDER_INPUT.workflow, workflow);
	put("policy/gates.json", gates);
	put("original/row.json", rowBytes);
	put(
		"original/admission.json",
		bundleJson({ receipt: admission.receipt, snapshot: admission.snapshot }),
	);
	put(
		"original/contract-receipt.json",
		regularBytes(
			join(stateDir, "contracts", input.runId, "receipt.json"),
			MAX_FILE_BYTES,
		),
	);
	put("original/WORKFLOW.md", admittedWorkflow);
	put(
		"original/models.json",
		bundleJson({
			source: "admitted_workflow",
			stages: parsed.config.stages,
			thinking: {
				accept: parsed.config.stages.accept.reasoningEffort,
				otherStages: "unavailable:not_recorded",
			},
			observations: row.models,
		}),
	);
	const oracleDir = join(stateDir, "acceptance", input.runId);

	const canary = regularBytes(join(oracleDir, "canary.txt"), MAX_FILE_BYTES)
		.toString("utf8")
		.trimEnd();

	for (const [path, content] of acceptanceEntries(acceptance.suite, canary))
		put(`oracle/${path}`, content);
	put(
		"oracle/receipt.json",
		regularBytes(join(oracleDir, "receipt.json"), MAX_FILE_BYTES),
	);

	const patch = readPatch(stateDir, {
		runId: input.runId,
		baseSha: contract.base.sha,
		contractDigest,
		acceptanceDigest: acceptance.receipt.acceptanceDigest,
		round: 0,
	});

	if (patch.kind === "blocked") throw new Error(patch.reason);

	if (patch.kind === "found") {
		put("original/patch.diff", patch.patch);
		put("original/patch-receipt.json", bundleJson(patch.receipt));
	}

	const manifest = bundleJson(createManifest(files));
	put("manifest.json", manifest);
	put("manifest.sha256", `${digestOf(manifest)}\n`);
	const verified = verifyEvidence(files);
	mkdirSync(out, { mode: 0o700 });

	try {
		for (const [path, bytes] of files) {
			mkdirSync(dirname(join(out, path)), { recursive: true, mode: 0o700 });
			writeFileSync(join(out, path), bytes, { flag: "wx", mode: 0o600 });
		}

		verifyBundle(out);

		return verified;
	} catch (error) {
		rmSync(out, { recursive: true, force: true });
		throw error;
	}
}
