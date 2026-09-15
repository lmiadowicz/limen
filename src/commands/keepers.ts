import { limenRoot } from "../git.ts";
import { readKeepers, writeKeepers } from "../project-config.ts";

export async function keepersCommand(args: readonly string[], cwd: string): Promise<void> {
	const root = limenRoot(cwd);
	if (args.length === 0) {
		const keepers = await readKeepers(root);
		console.log(keepers.raw.length ? keepers.raw.join(",") : "keepers unset");
		return;
	}
	if (args[0] === "set") {
		const raw = args.slice(1).join(",");
		if (!raw.trim()) throw new Error("usage: limen keepers set F007,#225,F012");
		const keepers = await writeKeepers(root, raw);
		console.log(`keepers ${keepers.raw.join(",")}`);
		return;
	}
	if (args.length === 1 && args[0]?.includes(",")) {
		const keepers = await writeKeepers(root, args[0] ?? "");
		console.log(`keepers ${keepers.raw.join(",")}`);
		return;
	}
	throw new Error("usage: limen keepers | limen keepers set F007,#225,F012");
}
