import { isGitSha, isModelId } from "../config/schema.ts";
import {
	fieldOf,
	hasDuplicateKey,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "../core/json.ts";
import { isDigest } from "../core/run.ts";
import { literal, oneOf, record } from "../ledger/schema.ts";

function digest(value: JsonValue | undefined) {
	const text = textOf(value);

	if (text === null || !isDigest(text))
		throw new Error("invalid_variant_digest");

	return text;
}

const model = (value: JsonValue | undefined) => {
	const text = textOf(value);

	if (text === null || !isModelId(text))
		throw new Error("invalid_variant_model");

	return text;
};

const modelChange = record({
	kind: literal("model"),
	stage: oneOf("build", "review"),
	model,
});

const revisionChange = record({
	kind: literal("buildRevision"),
	value: oneOf("on", "off"),
});

const skillChange = record({
	kind: literal("skill"),
	path: (value) => {
		const text = textOf(value);

		if (
			text === null ||
			!/^skills\/[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9._-]+$/.test(text) ||
			text.endsWith("/..")
		)
			throw new Error("invalid_variant_skill");

		return text;
	},
	file: (value) => {
		const text = textOf(value);

		if (text === null || text.length === 0 || text.includes("\0"))
			throw new Error("invalid_skill_file");

		return text;
	},
	digest,
});

const variantCodec = record({
	version: literal(1),
	kind: literal("factory_benchmark_variant"),
	name: (value) => {
		const text = textOf(value);

		if (text === null || !/^[a-zA-Z0-9_-]{1,80}$/.test(text))
			throw new Error("invalid_variant_name");

		return text;
	},
	pins: record({
		bundleDigest: digest,
		factoryRevision: (value) => {
			const text = textOf(value);

			if (text === null || !isGitSha(text))
				throw new Error("invalid_factory_revision");

			return text;
		},
		assetsDigest: digest,
		workflowDigest: digest,
		tariffDigest: digest,
	}),
	change: (value) => {
		switch (fieldOf(objectOf(value), "kind")) {
			case "model":
				return modelChange(value);
			case "skill":
				return skillChange(value);
			case "buildRevision":
				return revisionChange(value);
			case "respec":
				return record({ kind: literal("respec"), value: literal("on") })(value);
			default:
				throw new Error("declare_exactly_one_variant_dimension");
		}
	},
});

export type BenchVariant = ReturnType<typeof variantCodec>;

export function parseBenchVariant(text: string): BenchVariant {
	if (hasDuplicateKey(text)) throw new Error("duplicate_variant_key");

	return variantCodec(parseJson(text));
}
