import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Walk up from a module URL until the published package root (has bin/limen + package.json). */
export function packageRoot(from = import.meta.url): string {
	let dir = dirname(fileURLToPath(from));
	for (let i = 0; i < 8; i += 1) {
		if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "bin/limen"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("limen package root not found");
}

export function packageHookDir(from = import.meta.url): string {
	return join(packageRoot(from), "hook");
}

export function packageBin(from = import.meta.url): string {
	return join(packageRoot(from), "bin/limen");
}

export function packagePidinfoHelper(from = import.meta.url): string {
	const root = packageRoot(from);
	const fromSrc = join(root, "src/proc-pidinfo.rb");
	if (existsSync(fromSrc)) return fromSrc;
	const beside = join(dirname(fileURLToPath(from)), "proc-pidinfo.rb");
	if (existsSync(beside)) return beside;
	return fromSrc;
}
