import { execFile } from "node:child_process";

export type ExecutionResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export function executeWithClaude(prompt: string, options: { command?: string; timeoutMs?: number } = {}): Promise<ExecutionResult> {
  const command = options.command ?? process.env.TRUNK_CLAUDE_BIN ?? "claude";
  const timeout = options.timeoutMs ?? 10 * 60 * 1000;

  return new Promise((resolve) => {
    execFile(command, ["-p", prompt], { timeout, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      const exitCode = typeof (error as { code?: unknown } | null)?.code === "number"
        ? (error as { code: number }).code
        : error
          ? 1
          : 0;
      resolve({
        ok: !error,
        stdout,
        stderr,
        exitCode,
      });
    });
  });
}

export function formatExecutionReply(result: ExecutionResult): string {
  const sections = [
    result.ok ? "Execution completed." : `Execution failed with exit code ${result.exitCode ?? "unknown"}.`,
    result.stdout.trim() ? `stdout:\n${clip(result.stdout.trim())}` : "",
    result.stderr.trim() ? `stderr:\n${clip(result.stderr.trim())}` : "",
  ].filter(Boolean);
  return sections.join("\n\n");
}

function clip(value: string): string {
  const max = 5000;
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}
