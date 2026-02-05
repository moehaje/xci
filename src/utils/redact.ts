export type RedactRule = {
	flag: string;
	redactNext: boolean;
};

const DEFAULT_RULES: RedactRule[] = [
	{ flag: "--secret-file", redactNext: true },
	{ flag: "--env-file", redactNext: true },
	{ flag: "--var-file", redactNext: true },
];

export function redactArgs(args: string[], rules: RedactRule[] = DEFAULT_RULES): string[] {
	const redacted = [...args];
	const redactNext = new Set(rules.filter((rule) => rule.redactNext).map((rule) => rule.flag));

	for (let i = 0; i < redacted.length; i += 1) {
		const current = redacted[i];
		if (redactNext.has(current) && i + 1 < redacted.length) {
			redacted[i + 1] = "<redacted>";
			i += 1;
			continue;
		}
		for (const rule of rules) {
			if (current.startsWith(`${rule.flag}=`)) {
				redacted[i] = `${rule.flag}=<redacted>`;
				break;
			}
		}
	}

	return redacted;
}
