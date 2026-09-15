import { closeFeatureToDone } from "../features.ts";
import { limenRoot } from "../git.ts";
import { closeFeatureTabs } from "../herdr.ts";

export async function closeCommand(args: readonly string[], cwd: string): Promise<void> {
	const feature = args[0];
	if (!feature || args.length !== 1) throw new Error("close requires a feature like F012");
	const root = limenRoot(cwd);
	const move = await closeFeatureToDone(root, feature);
	const lines = [move.message];
	try {
		lines.push(await closeFeatureTabs({ root, feature }));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/herdr is not available/i.test(message)) {
			lines.push(`tabs not closed: ${message}`);
			console.log(lines.join("\n"));
			return;
		}
		console.log(lines.join("\n"));
		throw error;
	}
	console.log(lines.join("\n"));
}
