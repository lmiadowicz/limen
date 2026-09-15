import { activateFeature } from "../features.ts";
import { limenRoot } from "../git.ts";

export async function activateCommand(args: readonly string[], cwd: string): Promise<void> {
	const feature = args[0];
	if (!feature || args.length !== 1) throw new Error("activate requires a feature like F012");
	console.log((await activateFeature(limenRoot(cwd), feature)).message);
}
