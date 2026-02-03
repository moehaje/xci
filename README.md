# XCI

[![npm version](https://img.shields.io/npm/v/%40artsnlabs%2Fxci)](https://www.npmjs.com/package/@artsnlabs/xci)
[![npm downloads](https://img.shields.io/npm/dm/%40artsnlabs%2Fxci)](https://www.npmjs.com/package/@artsnlabs/xci)
[![license](https://img.shields.io/npm/l/%40artsnlabs%2Fxci)](LICENSE)
[![CI](https://github.com/moehaje/xci/actions/workflows/ci.yml/badge.svg)](https://github.com/moehaje/xci/actions/workflows/ci.yml)

XCI is a local GitHub Actions runner UX for running workflows locally with a polished terminal experience, delegating execution to `act`.

## Features

- Discover workflows under `.github/workflows/*.yml`
- Interactive selection of workflows and jobs
- Non-interactive usage with flags
- Local runs via `act` with Docker/Podman
- Run history and logs under `.xci/runs/<run-id>/`

## Demo

![XCI demo placeholder](.github/assets/xci-demo.gif)

## Requirements

- Node.js 18+
- `act` installed and available on PATH
- Docker or Podman running

## Install

```bash
npm i -g @artsnlabs/xci
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

Examples below use both `xci` and `xci run` forms.

Global install:

```bash
xci
xci run
xci run --workflow ci.yml --event push --job build-and-test
xci run --workflow ci.yml --all --json
```

Without global install:

```bash
npx xci
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

## Project Health

- [CI workflow](.github/workflows/ci.yml)
- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)
- [Versioning policy](VERSIONING.md)

## Development

```bash
npm install
npm run build
npm run type-check
```

## License

MIT
