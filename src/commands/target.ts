import { limenRoot } from "../git.ts";
import { readTarget, writeTarget } from "../project-config.ts";

export async function targetCommand(args: readonly string[], cwd: string): Promise<void> {
	const root = limenRoot(cwd);
	if (args.length === 0) {
		const value = await readTarget(root);
		console.log(value === undefined ? "TARGET unset" : `TARGET ${value}`);
		return;
	}
	if (args.length !== 1) throw new Error("usage: limen target [N]");
	const raw = args[0] ?? "";
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("TARGET must be a non-negative integer");
	await writeTarget(root, value);
	console.log(`TARGET ${value}`);
}
