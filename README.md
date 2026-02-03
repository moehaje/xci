# XCI

XCI is a local GitHub Actions runner UX that delegates execution to an engine (v1: `act`) and focuses on a high-quality terminal experience and orchestration.

## Features

- Discover workflows under `.github/workflows/*.yml`
- Interactive selection of workflows and jobs
- Non-interactive `xci run` usage with flags
- Local runs via `act` with Docker/Podman
- Run history and logs under `.xci/runs/<run-id>/`

## Requirements

- Node.js 18+
- `act` installed and available on PATH
- Docker or Podman running

## Install

```bash
npm install --save-dev @artsnlabs/xci
```

Homebrew (tap, available now):

```bash
brew tap moehaje/tap
brew install xci
```

Tap installs `xci` with `act`; Docker or Podman still needs to be running.

Homebrew one-command install:

```bash
brew install moehaje/tap/xci
```

For release/update flow, see `docs/homebrew-core.md`.

## Usage

```bash
npx xci run
npx xci run --workflow ci.yml --event push --job build-and-test
npx xci run --workflow ci.yml --all --json
```

## Configuration

Create a `.xci.yml` at the repo root:

```yml
engine: act
runtime:
  container: docker
  architecture: amd64
  image:
    ubuntu-latest: ghcr.io/catthehacker/ubuntu:act-latest
presets:
  quick:
    jobs: [build-and-test, code-quality]
```

## Development

```bash
npm install
npm run build
npm run type-check
```

## License

MIT
