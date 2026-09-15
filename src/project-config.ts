import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Keepers = {
	readonly features: readonly string[];
	readonly issues: readonly string[];
	readonly raw: readonly string[];
};

export async function readTarget(root: string): Promise<number | undefined> {
	const raw = (await text(`${root}/.limen/target`)).trim();
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`.limen/target must be a non-negative integer (got ${JSON.stringify(raw)})`);
	return value;
}

export async function writeTarget(root: string, value: number): Promise<void> {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("TARGET must be a non-negative integer");
	await mkdir(`${root}/.limen`, { recursive: true });
	await writeFile(`${root}/.limen/target`, `${value}\n`, { flush: true });
}

export function parseKeepersList(input: string): Keepers {
	const tokens = input
		.split(/[,\s]+/)
		.map((token) => token.trim())
		.filter(Boolean);
	const features: string[] = [];
	const issues: string[] = [];
	const ordered: string[] = [];
	const seen = new Set<string>();
	for (const token of tokens) {
		const key = token.toUpperCase();
		if (seen.has(key)) continue;
		seen.add(key);
		if (/^F\d{3,}$/i.test(token)) {
			const feature = token.toUpperCase();
			features.push(feature);
			ordered.push(feature);
		} else if (/^#\d+$/.test(token)) {
			issues.push(token);
			ordered.push(token);
		} else throw new Error(`keepers entry ${JSON.stringify(token)} must look like F007 or #225`);
	}
	return { features, issues, raw: ordered };
}

export async function readKeepers(root: string): Promise<Keepers> {
	const raw = await text(`${root}/.limen/keepers`);
	if (!raw.trim()) return { features: [], issues: [], raw: [] };
	return parseKeepersList(raw.replace(/\n/g, ","));
}

export async function writeKeepers(root: string, input: string): Promise<Keepers> {
	const keepers = parseKeepersList(input);
	await mkdir(`${root}/.limen`, { recursive: true });
	await writeFile(`${root}/.limen/keepers`, `${keepers.raw.join(",")}\n`, { flush: true });
	return keepers;
}

async function text(path: string): Promise<string> {
	return readFile(path, "utf8").then(
		(value) => value,
		() => "",
	);
}

export async function ensureParent(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
}
