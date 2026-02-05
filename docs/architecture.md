# Architecture

XCI is structured as a small set of composable layers with strict dependency direction:

```
core -> engine + store -> cli + tui
```

## Modules

- `src/core/`: workflow discovery and parsing into internal models.
- `src/engines/`: engine adapters (v1: act). Plan commands and spawn processes.
- `src/store/`: run persistence (run metadata + log paths) under `.xci/runs/<run-id>/`.
- `src/cli/`: argument parsing and command wiring, including non-interactive usage.
- `src/tui/`: Ink UI; consumes core + engine + store; never imported by core/engine.

## Key flows

1. CLI parses args and resolves workflow/job selection.
2. Core plans run + job order.
3. Engine adapter plans deterministic command args and executes.
4. Store persists runtime events to `run.json` and logs.
5. TUI or CLI output renders state/logs.

## Constraints

- Keep boundaries clean; no UI imports in core/engine.
- Do not re-implement GitHub Actions semantics; delegate to engine.
- Treat `act --matrix` as a pass-through filter.
