# Homebrew release flow (tap now, core later)

This document tracks the dual-track Homebrew strategy for XCI:

1. Ship quickly via a custom tap now.
2. Move to `Homebrew/homebrew-core` later.

## Current install path (tap)

Users install with:

```bash
brew tap moehaje/tap
brew install xci
```

One-command alternative:

```bash
brew install moehaje/tap/xci
```

## Source of truth

- npm package: `@artsnlabs/xci`
- Formula source URL: `https://registry.npmjs.org/@artsnlabs/xci/-/xci-<version>.tgz`
- Runtime dependencies: `node`, `act`

## Phase 1: custom tap (active)

### Tap repository

- Repository: `moehaje/homebrew-tap`
- Formula path: `Formula/xci.rb`

### Formula requirements

Use the standard Node formula pattern:

```ruby
class Xci < Formula
  desc "Local GitHub Actions runner UX powered by act"
  homepage "https://github.com/moehaje/xci#readme"
  url "https://registry.npmjs.org/@artsnlabs/xci/-/xci-<version>.tgz"
  sha256 "<sha256>"
  license "MIT"

  depends_on "act"
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/xci --version")
    assert_match "run", shell_output("#{bin}/xci --help")
  end
end
```

### Release workflow (each npm release)

1. Publish npm version first.
2. Run metadata generator in this repo:

```bash
npm run release:homebrew-metadata
```

This prints tarball URL, SHA256, and a formula snippet.

3. Update `Formula/xci.rb` in `moehaje/homebrew-tap`.
4. Commit and push the tap change.

### Local validation

Validate installation from the tap:

```bash
brew tap moehaje/tap
brew install --build-from-source moehaje/tap/xci
brew test xci
```

## Phase 2: Homebrew Core (later)

### Readiness criteria

- Stable release cadence across multiple versions.
- Reliable formula updates and tests.
- Clean audit/test behavior with minimal maintenance burden.
- Demonstrable adoption signals.

### Core submission flow

1. Fork `Homebrew/homebrew-core`.
2. Add `Formula/x/xci.rb` using the same npm tarball approach.
3. Run required local validation (`brew audit` + install/test).
4. Open PR and address maintainer feedback.

### Cutover after Core merge

- Update README to prefer direct install:

```bash
brew install xci
```

- Keep tap formula as temporary mirror for compatibility.
- Announce Core as the preferred long-term channel.
