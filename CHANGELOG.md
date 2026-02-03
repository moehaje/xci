# Changelog

All notable changes to this project will be documented in this file.

## [0.1.5] - 2026-02-03

### Added
- Add card-based DAG summary rendering and details/summary navigation improvements in the run view.
- Add Homebrew release metadata generation and packed CLI smoke testing in CI.
- Add richer CLI banner/badge output and stronger preflight image validation.

### Changed
- Improve matrix handling and runner label platform resolution in `xci run`.
- Reorganize run-view modules into layered entrypoints for maintainability.
- Update README install/usage guidance and demo coverage.

### Fixed
- Prevent duplicate redraw when toggling step logs in details view.
- Normalize streamed `act` output into GitHub-style step/group lines for cleaner logs.

## [0.1.4] - 2026-01-29

### Added
- Add `xci init` to insert `.xci` into `.gitignore`.
- Automatically add `.xci` to `.gitignore` on first TTY run.

## [0.1.3] - 2026-01-29

### Changed
- Rename npm package to `@artsnlabs/xci`.
- Add explicit ESM `exports.import` condition.

## [0.1.1] - 2026-01-29

### Added
- Publishable CLI packaging and policies.
- Biome linting and formatting.
- Engine preflight improvements and CLI validation.

### Changed
- TUI run view enhancements with better status rendering.
