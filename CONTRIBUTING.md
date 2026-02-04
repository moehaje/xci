# Contributing

Thanks for contributing to XCI.

## Setup

```bash
npm install
npm run build
npm run type-check
```

## Project Structure

- `src/core`: workflow discovery and parsing
- `src/engines`: engine adapters (act)
- `src/store`: run metadata and logs
- `src/tui`: Ink UI components
- `src/cli`: CLI command wiring

## Guidelines

- Keep changes focused and typed
- Prefer small modules with named exports
- Do not add new logging frameworks
- Avoid `any` and `@ts-ignore`

## Tests

Run type checking before opening a PR:

```bash
npm run type-check
```

## Homebrew Releases

To prepare Homebrew formula updates for `xci`, use:

```bash
npm run release:homebrew-metadata
```

Tap updates are automated on GitHub Release publish via
`.github/workflows/release.yml`.

See `docs/homebrew-core.md` for the tap-now/core-later release flow.
