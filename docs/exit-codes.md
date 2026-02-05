# Exit Codes

XCI uses consistent exit codes across CLI and TUI flows.

- `0`: success
- `1`: runtime failure (engine/act failure)
- `2`: usage/validation error (bad args, missing workflow, unrunnable selection)
- `130`: canceled by user or aborted signal
