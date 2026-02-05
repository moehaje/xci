# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-02-05

### Added
- Add engine adapter factory selection from config and event-driven run persistence wiring.
- Add stronger security hardening for path safety and CLI argument redaction.
- Add Vitest baseline coverage across core, CLI, config, adapter, and packaged CLI smoke flows.
- Add docs for architecture, testing workflow, and exit codes.

### Changed
- Refactor CLI run orchestration into focused modules (`select`, `plan-run`, `execute-run`, `output`).
- Improve TUI run-view log parsing/rendering with incremental updates and clearer help states.
- Expand CI quality gates with format check, tests, packaged smoke checks, and pre-commit lint-staged hooks.

### Fixed
- Harden core/engine validation and act process error handling for more deterministic exits.

## [0.1.6] - 2026-02-04

### Added
- Add run-view quit flows for canceling active runs and optionally cleaning run files on exit.
- Add targeted act runtime cleanup command and automatic post-run cleanup handling.
- Add cleanup controls via config and CLI (`runtime.cleanupMode`, `--cleanup-mode`, `--no-cleanup`).
- Add GitHub release workflow naming and Homebrew tap automation updates.

### Changed
- Improve local runner compatibility by skipping unsupported non-Linux jobs when using `act`.
- Default cleanup mode to `fast` to keep `act-toolcache` and images for faster subsequent runs.
- Rename GitHub workflow file to `.github/workflows/release.yml`.

### Fixed
- Avoid stale log-path outro after run-file cleanup in TUI mode.
- Treat interactive cancel exits as clean process exits to avoid lifecycle failure noise.

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
