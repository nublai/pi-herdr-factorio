import { isGitSha } from "../config/schema.ts";
import {
	type JsonValue,
	arrayOf,
	hasDuplicateKey,
	parseJson,
	textOf,
} from "../core/json.ts";
import { type Digest, digestOf, isDigest } from "../core/run.ts";
import { count, literal, positive, record } from "../ledger/schema.ts";
import { isRepoSlug } from "../trust/platform.ts";

function digest(value: JsonValue | undefined): Digest {
	const text = textOf(value);

	if (text === null || !isDigest(text)) throw new Error("invalid_digest");

	return text;
}

const taskCodec = record({
	version: literal(1),
	kind: literal("factory_benchmark_task"),
	runId: digest,
	repo: (value) => {
		const text = textOf(value);

		if (text === null || !isRepoSlug(text)) throw new Error("invalid_repo");

		return text;
	},
	issue: positive,
	snapshotDigest: digest,
	contractDigest: digest,
	acceptanceDigest: digest,
	base: record({
		sha: (value) => {
			const text = textOf(value);

			if (text === null || !isGitSha(text)) throw new Error("invalid_base");

			return text;
		},
		archive: literal("builder/base.tar"),
		digest,
	}),
	builderInput: literal("builder/input.json"),
	oracle: literal("oracle/"),
	original: literal("original/row.json"),
});

export type TaskBundle = ReturnType<typeof taskCodec>;

export const BUILDER_INPUT = {
	version: 1,
	issue: "builder/issue.json",
	contract: "builder/contract.json",
	base: "builder/base.tar",
	workflow: "builder/WORKFLOW.md",
} as const;

export type BundleFile = {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: Digest;
};

export type BundleManifest = {
	readonly version: 1;
	readonly files: readonly BundleFile[];
};

export const BUNDLE_INDEX = ["manifest.json", "manifest.sha256"] as const;

type BundleJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly BundleJsonValue[]
	| { readonly [key: string]: BundleJsonValue };

export function bundleJson(value: BundleJsonValue): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function isBundlePath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.includes("\\") &&
		[...path].every(
			(char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
		) &&
		path
			.split("/")
			.every((part) => part !== "" && part !== "." && part !== "..")
	);
}

export function createManifest(
	files: ReadonlyMap<string, Uint8Array>,
): BundleManifest {
	return {
		version: 1,
		files: [...files]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([path, bytes]) => {
				if (!isBundlePath(path) || BUNDLE_INDEX.some((name) => name === path))
					throw new Error(`invalid_manifest_path: ${path}`);

				return { path, bytes: bytes.byteLength, sha256: digestOf(bytes) };
			}),
	};
}

const fileCodec = record({
	path: (value) => {
		const text = textOf(value);

		if (text === null || !isBundlePath(text))
			throw new Error("invalid_manifest_path");

		return text;
	},
	bytes: count,
	sha256: digest,
});

const manifestCodec = record({
	version: literal(1),
	files: (value) => {
		const items = arrayOf(value);

		if (items === null || items.length === 0)
			throw new Error("invalid_manifest_files");

		return items.map(fileCodec);
	},
});

export function parseTaskBundle(text: string): TaskBundle {
	if (hasDuplicateKey(text)) throw new Error("duplicate_task_key");

	return taskCodec(parseJson(text));
}

export function verifyManifest(files: ReadonlyMap<string, Uint8Array>): Digest {
	const manifestBytes = files.get("manifest.json");
	const expected = files.get("manifest.sha256");

	if (manifestBytes === undefined || expected === undefined)
		throw new Error("manifest_missing");
	const manifestDigest = digestOf(manifestBytes);

	if (Buffer.from(expected).toString("utf8") !== `${manifestDigest}\n`)
		throw new Error("manifest_digest_mismatch");
	const text = Buffer.from(manifestBytes).toString("utf8");

	if (hasDuplicateKey(text)) throw new Error("duplicate_manifest_key");
	const manifest = manifestCodec(parseJson(text));

	if (bundleJson(manifest) !== text) throw new Error("manifest_not_canonical");
	let previous = "";

	for (const entry of manifest.files) {
		if (
			entry.path <= previous ||
			BUNDLE_INDEX.some((name) => name === entry.path)
		)
			throw new Error(`invalid_manifest_path: ${entry.path}`);
		previous = entry.path;
		const bytes = files.get(entry.path);

		if (bytes === undefined) throw new Error(`file_missing: ${entry.path}`);

		if (bytes.byteLength !== entry.bytes || digestOf(bytes) !== entry.sha256)
			throw new Error(`file_digest_mismatch: ${entry.path}`);
	}

	if (files.size !== manifest.files.length + BUNDLE_INDEX.length)
		throw new Error("unlisted_bundle_file");

	return manifestDigest;
}

export function verifyTaskBundle(files: ReadonlyMap<string, Uint8Array>) {
	const manifestDigest = verifyManifest(files);
	const bytes = files.get("task.json");

	if (bytes === undefined) throw new Error("task_missing");
	const task = parseTaskBundle(Buffer.from(bytes).toString("utf8"));
	const base = files.get(task.base.archive);

	if (base === undefined || digestOf(base) !== task.base.digest)
		throw new Error("base_tree_digest_mismatch: builder/base.tar");
	const input = files.get(task.builderInput);

	if (
		input === undefined ||
		Buffer.from(input).toString("utf8") !== bundleJson(BUILDER_INPUT)
	)
		throw new Error("invalid_builder_input");

	for (const path of [
		BUILDER_INPUT.issue,
		BUILDER_INPUT.contract,
		BUILDER_INPUT.base,
		BUILDER_INPUT.workflow,
		"original/row.json",
		"original/contract-receipt.json",
		"original/admission.json",
		"original/models.json",
		"policy/gates.json",
		"oracle/suite.json",
		"oracle/receipt.json",
		"oracle/canary.txt",
		"oracle/manifest.json",
	]) {
		if (!files.has(path)) throw new Error(`file_missing: ${path}`);
	}

	return { task, manifestDigest };
}
