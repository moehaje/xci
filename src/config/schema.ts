import { z } from "zod";

export const PresetSchema = z.object({
  jobs: z.array(z.string()).default([]),
  event: z
    .object({
      name: z.string(),
      payloadPath: z.string().optional()
    })
    .optional(),
  matrix: z.record(z.unknown()).optional()
});

export const ConfigSchema = z.object({
  engine: z.string().default("act"),
  runtime: z
    .object({
      container: z.enum(["docker", "podman"]).default("docker"),
      architecture: z.string().default("amd64"),
      image: z.record(z.string()).default({})
    })
    .default({
      container: "docker",
      architecture: "amd64",
      image: {}
    }),
  env: z.record(z.string()).default({}),
  vars: z.record(z.string()).default({}),
  secrets: z.record(z.string()).default({}),
  presets: z.record(PresetSchema).default({})
});

export type XciConfig = z.infer<typeof ConfigSchema>;
