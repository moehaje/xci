import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
	const options = {
		packageName: undefined,
		version: undefined,
		json: false,
		formula: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--package") {
			options.packageName = argv[index + 1];
			index += 1;
			continue;
		}
		if (token === "--version") {
			options.version = argv[index + 1];
			index += 1;
			continue;
		}
		if (token === "--json") {
			options.json = true;
			continue;
		}
		if (token === "--formula") {
			options.formula = true;
			continue;
		}
		if (token === "--help" || token === "-h") {
			printHelp();
			process.exit(0);
		}
		if (token.startsWith("-")) {
			throw new Error(`Unknown option: ${token}`);
		}
	}

	return options;
}

function printHelp() {
	process.stdout.write(`Usage: node scripts/homebrew-metadata.js [options]\n\n`);
	process.stdout.write(`Options:\n`);
	process.stdout.write(`  --package <name>   npm package name (defaults to package.json name)\n`);
	process.stdout.write(`  --version <semver> Resolve metadata for a specific published version\n`);
	process.stdout.write(`  --json             Emit JSON output\n`);
	process.stdout.write(`  --formula          Include Homebrew formula snippet in output\n`);
	process.stdout.write(`  -h, --help         Show help\n`);
}

function packageNameToClassName(packageName) {
	const baseName = packageName.includes("/")
		? packageName.split("/").at(-1)
		: packageName;
	return baseName
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((part) => part[0].toUpperCase() + part.slice(1))
		.join("");
}

function buildFormulaSnippet(metadata) {
	const className = packageNameToClassName(metadata.packageName);
	const normalizedDescription = metadata.description.replace(/\.$/, "");
	const escapedDescription = normalizedDescription.replace(/"/g, '\\"');
	const escapedHomepage = metadata.homepage.replace(/"/g, '\\"');
	const escapedLicense = metadata.license.replace(/"/g, '\\"');
	return `class ${className} < Formula
  desc "${escapedDescription}"
  homepage "${escapedHomepage}"
  url "${metadata.tarballUrl}"
  sha256 "${metadata.sha256}"
  license "${escapedLicense}"

  depends_on "act"
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/${metadata.binaryName} --version")
    assert_match "run", shell_output("#{bin}/${metadata.binaryName} --help")
  end
end`;
}

async function fetchPackageDocument(packageName) {
	const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
	const response = await fetch(metadataUrl);
	if (!response.ok) {
		throw new Error(`Failed to fetch npm metadata from ${metadataUrl} (status ${response.status})`);
	}
	return response.json();
}

async function fetchSha256(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download tarball from ${url} (status ${response.status})`);
	}
	const content = Buffer.from(await response.arrayBuffer());
	return createHash("sha256").update(content).digest("hex");
}

async function resolveMetadata(options) {
	const packageJsonPath = path.join(process.cwd(), "package.json");
	const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
	const packageName = options.packageName ?? packageJson.name;
	if (!packageName) {
		throw new Error("Package name could not be resolved. Use --package.");
	}

	const document = await fetchPackageDocument(packageName);
	const version = options.version ?? document["dist-tags"]?.latest;
	if (!version) {
		throw new Error("Could not resolve version from npm dist-tags.");
	}

	const release = document.versions?.[version];
	if (!release) {
		throw new Error(`Version ${version} is not published for ${packageName}.`);
	}

	const tarballUrl = release.dist?.tarball;
	if (!tarballUrl) {
		throw new Error(`Tarball URL missing in npm metadata for ${packageName}@${version}.`);
	}

	const sha256 = await fetchSha256(tarballUrl);
	const metadata = {
		packageName,
		version,
		tarballUrl,
		sha256,
		description: release.description ?? packageJson.description ?? "CLI tool",
		homepage:
			release.homepage ?? packageJson.homepage ?? `https://www.npmjs.com/package/${packageName}`,
		license: release.license ?? packageJson.license ?? "MIT",
		binaryName: Object.keys(release.bin ?? packageJson.bin ?? { xci: "dist/index.js" })[0],
	};

	return metadata;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const metadata = await resolveMetadata(options);
	const output = {
		...metadata,
		formula: options.formula ? buildFormulaSnippet(metadata) : undefined,
	};

	if (options.json) {
		process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
		return;
	}

	process.stdout.write(`package=${metadata.packageName}\n`);
	process.stdout.write(`version=${metadata.version}\n`);
	process.stdout.write(`tarball_url=${metadata.tarballUrl}\n`);
	process.stdout.write(`sha256=${metadata.sha256}\n`);
	if (options.formula) {
		process.stdout.write("\n");
		process.stdout.write(`${buildFormulaSnippet(metadata)}\n`);
	}
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : "Unknown error";
	process.stderr.write(`homebrew-metadata: ${message}\n`);
	process.exit(1);
});
