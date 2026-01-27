import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ConfigSchema, XciConfig } from "./schema.js";

export type ConfigLoadResult = {
  config: XciConfig;
  path?: string;
};

const DEFAULT_CONFIG_PATH = ".xci.yml";

export function loadConfig(repoRoot: string): ConfigLoadResult {
  const configPath = path.join(repoRoot, DEFAULT_CONFIG_PATH);
  if (!fs.existsSync(configPath)) {
    return { config: ConfigSchema.parse({}), path: undefined };
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = YAML.parse(raw);
  return { config: ConfigSchema.parse(parsed ?? {}), path: configPath };
}
