import fs from "node:fs";
import path from "node:path";

const outputPath = path.join(process.cwd(), "dist", "index.js");
if (!fs.existsSync(outputPath)) {
	process.stderr.write(`Missing build output at ${outputPath}\n`);
	process.exit(1);
}

const contents = fs.readFileSync(outputPath, "utf-8");
const shebang = "#!/usr/bin/env node\n";
if (!contents.startsWith(shebang)) {
	fs.writeFileSync(outputPath, shebang + contents);
}
