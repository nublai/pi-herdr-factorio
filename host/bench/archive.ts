import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isBundlePath } from "../../src/bench/bundle.ts";

export function unpackBase(archive: Buffer, destination: string): string[] {
	const seen = new Set<string>();
	const files: string[] = [];
	let paxPath: string | null = null;

	const field = (header: Buffer, offset: number, length: number) =>
		header
			.subarray(offset, offset + length)
			.toString("utf8")
			.replace(/\0.*$/s, "");

	for (let at = 0; at + 512 <= archive.length; ) {
		const header = archive.subarray(at, at + 512);

		if (header.every((byte) => byte === 0)) return files.sort();
		const sizeText = field(header, 124, 12).trim();

		if (!/^[0-7]+$/.test(sizeText)) throw new Error("base_archive_header");
		const size = Number.parseInt(sizeText, 8);
		const bytes = archive.subarray(at + 512, at + 512 + size);

		if (bytes.length !== size) throw new Error("base_archive_truncated");
		at += 512 + Math.ceil(size / 512) * 512;
		const type = header[156];

		if (type === 103) continue;

		if (type === 120) {
			let offset = 0;

			while (offset < bytes.length) {
				const space = bytes.indexOf(32, offset);
				const length = Number(bytes.subarray(offset, space).toString());

				if (
					space < offset ||
					!Number.isSafeInteger(length) ||
					length <= 0 ||
					offset + length > bytes.length
				)
					throw new Error("base_archive_pax");
				const entry = bytes.subarray(space + 1, offset + length - 1).toString();

				if (entry.startsWith("path=")) paxPath = entry.slice(5);
				offset += length;
			}

			continue;
		}

		const prefix = field(header, 345, 155);
		const name = field(header, 0, 100);

		const path = (paxPath ?? (prefix ? `${prefix}/${name}` : name)).replace(
			/\/$/,
			"",
		);

		paxPath = null;

		if (
			!isBundlePath(path) ||
			path.split("/").some((part) => part.toLowerCase() === ".git") ||
			seen.has(path)
		)
			throw new Error("unsafe_base_archive_path");
		seen.add(path);

		if (seen.size > 100_000) throw new Error("base_archive_too_large");
		const full = join(destination, path);

		if (type === 53) mkdirSync(full, { recursive: true, mode: 0o700 });
		else if (type === 48 || type === 0) {
			mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
			const mode = Number.parseInt(field(header, 100, 8).trim(), 8);
			writeFileSync(full, bytes, {
				flag: "wx",
				mode: mode & 0o111 ? 0o700 : 0o600,
			});
			files.push(path);
		} else throw new Error("base_tree_unsupported");
	}

	throw new Error("base_archive_truncated");
}
