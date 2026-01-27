import fs from "node:fs";
import path from "node:path";

export type InputFileResult = {
  ok: boolean;
  envFile?: string;
  varsFile?: string;
  secretsFile?: string;
  error?: string;
};

export type InputConfig = {
  env: Record<string, string>;
  vars: Record<string, string>;
  secrets: Record<string, string>;
  envFile?: string;
  varsFile?: string;
  secretsFile?: string;
};

export function prepareInputFiles(runDir: string, config: InputConfig): InputFileResult {
  const inputsDir = path.join(runDir, "inputs");
  fs.mkdirSync(inputsDir, { recursive: true });

  const envFile = buildInputFile(inputsDir, "env", config.envFile, config.env);
  if (!envFile.ok) {
    return envFile;
  }

  const varsFile = buildInputFile(inputsDir, "vars", config.varsFile, config.vars);
  if (!varsFile.ok) {
    return varsFile;
  }

  const secretsFile = buildInputFile(inputsDir, "secrets", config.secretsFile, config.secrets);
  if (!secretsFile.ok) {
    return secretsFile;
  }

  return {
    ok: true,
    envFile: envFile.path,
    varsFile: varsFile.path,
    secretsFile: secretsFile.path
  };
}

type BuiltFile = { ok: boolean; path?: string; error?: string };

function buildInputFile(
  inputsDir: string,
  label: string,
  sourcePath: string | undefined,
  entries: Record<string, string>
): BuiltFile {
  const hasEntries = Object.keys(entries).length > 0;
  if (!sourcePath && !hasEntries) {
    return { ok: true };
  }

  let content = "";
  if (sourcePath) {
    if (!fs.existsSync(sourcePath)) {
      return { ok: false, error: `Configured ${label} file not found: ${sourcePath}` };
    }
    const raw = fs.readFileSync(sourcePath, "utf-8");
    content = raw.endsWith("\n") || raw.length === 0 ? raw : `${raw}\n`;
  }

  if (hasEntries) {
    content += serializeKeyValues(entries);
  }

  const outPath = path.join(inputsDir, `${label}.env`);
  fs.writeFileSync(outPath, content);
  return { ok: true, path: outPath };
}

function serializeKeyValues(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([key, value]) => `${key}=${escapeEnvValue(value)}`)
    .join("\n")
    .concat("\n");
}

function escapeEnvValue(value: string): string {
  return value.replace(/\n/g, "\\n");
}
