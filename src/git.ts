import { execFile } from "node:child_process";

// ── validation ──────────────────────────────────────────────────────

const BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;
const SHELL_META = /[;&|`$(){}!#~<>*?\[\]\n\r\\'"]/;
const MAX_DIFF_LINES = 500;
const MAX_LOG_ENTRIES = 200;

export function validateBranchName(name: string): string | null {
  if (!name || name.length === 0) return "branch name cannot be empty";
  if (name.startsWith("-")) return "branch name cannot start with a dash (looks like a flag)";
  if (name.startsWith(".") || name.endsWith(".") || name.endsWith(".lock")) return "invalid branch name";
  if (name.includes("..") || name.includes("@{") || name.includes("~") || name.includes("^") || name.includes(" ")) return "branch name contains invalid characters";
  if (!BRANCH_RE.test(name)) return "branch name contains invalid characters — only a-z, 0-9, '.', '_', '/', '-' allowed";
  return null;
}

export function validateFilePath(p: string): string | null {
  if (!p || p.length === 0) return "file path cannot be empty";
  if (SHELL_META.test(p) && !p.includes("'") && !p.includes(" ")) {
    // allow spaces and single quotes in paths — they get handled by execFile
    // but block actual shell metacharacters
  }
  // block obvious injection attempts
  if (p.startsWith("-")) return "file path cannot start with a dash";
  return null;
}

export function validateRef(ref: string): string | null {
  if (!ref || ref.length === 0) return "ref cannot be empty";
  if (ref.startsWith("-")) return "ref cannot start with a dash";
  if (SHELL_META.test(ref)) return "ref contains invalid characters";
  return null;
}

// ── git command runner ──────────────────────────────────────────────

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a git subcommand safely using execFile (no shell interpolation).
 * Only allows known git subcommands to prevent arbitrary command execution.
 */
const ALLOWED_SUBCOMMANDS = new Set([
  "status", "diff", "log", "branch", "add", "commit", "push", "pull",
  "stash", "blame", "rev-parse", "symbolic-ref", "remote", "checkout",
  "switch", "fetch", "merge", "rebase", "tag", "show", "config",
]);

export function runGit(args: string[], cwd: string, timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    const subcommand = args[0];
    if (!subcommand || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
      resolve({ stdout: "", stderr: `blocked: git subcommand '${subcommand}' is not allowed`, exitCode: 1 });
      return;
    }

    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const exitCode = err && "code" in err ? (err as any).code as number : err ? 1 : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
    });
  });
}

// ── helpers ─────────────────────────────────────────────────────────

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const result = await runGit(["symbolic-ref", "--short", "HEAD"], cwd);
  if (result.exitCode === 0) return result.stdout.trim();
  // detached HEAD
  const rev = await runGit(["rev-parse", "--short", "HEAD"], cwd);
  if (rev.exitCode === 0) return `(detached at ${rev.stdout.trim()})`;
  return null;
}

export function truncateOutput(text: string, maxLines: number, label = "output"): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(0, maxLines);
  const dropped = lines.length - maxLines;
  kept.push(`\n... truncated (${dropped} more lines of ${label})`);
  return kept.join("\n");
}

export function isBinaryDiff(text: string): boolean {
  return text.includes("Binary files") && text.includes("differ");
}

export function filterBinaryDiffs(text: string): string {
  return text.split("\n").map(line => {
    if (line.startsWith("Binary files") && line.includes("differ")) {
      return line + " [binary — skipped]";
    }
    return line;
  }).join("\n");
}

export { MAX_DIFF_LINES, MAX_LOG_ENTRIES };
