import process from "node:process";
import { render } from "ink";
import { App } from "../tui/app.js";

export async function runCli(): Promise<void> {
  const isTty = Boolean(process.stdout.isTTY);
  if (!isTty) {
    process.stderr.write("Non-interactive mode is not implemented yet.\n");
    process.exitCode = 2;
    return;
  }

  render(<App />);
}
