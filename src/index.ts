import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resolveConfig, type GitOpsConfig } from "./config.js";
import {
  runGit, isGitRepo, getCurrentBranch, truncateOutput, filterBinaryDiffs,
  validateBranchName, validateFilePath, validateRef, validateRemoteName, validateLogFilter, validateLabel,
  MAX_DIFF_LINES, MAX_LOG_ENTRIES,
  type GitResult,
} from "./git.js";

let cfg: GitOpsConfig;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }], details: {} };
}

function err(s: string) {
  return text(`error: ${s}`);
}

async function requireRepo(cwd: string) {
  if (!(await isGitRepo(cwd))) throw new Error("not a git repository (or any parent up to mount point)");
}

function isProtected(branch: string): boolean {
  return cfg.protectedBranches.includes(branch);
}

const plugin = {
  id: "git-operations",
  name: "Git Operations",
  description: "safe git workflow tools for openclaw agents.",

  register(api: OpenClawPluginApi) {
    cfg = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);
    api.logger.info("git-operations: initialized");

    // ── git_status ──────────────────────────────────────────────────

    api.registerTool(
      {
        name: "git_status",
        label: "Git Status",
        description: "Show working tree status — modified, staged, untracked files, current branch, and whether there are merge conflicts.",
        parameters: Type.Object({
          cwd: Type.Optional(Type.String({ description: "Working directory (default: agent cwd)" })),
          short: Type.Optional(Type.Boolean({ description: "Short format output (default: false)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>, context: any) {
          const cwd = (params.cwd as string) || context?.cwd || process.cwd();
          try { await requireRepo(cwd); } catch (e: any) { return err(e.message); }

          const branch = await getCurrentBranch(cwd);
          const args = ["status"];
          if (params.short) args.push("--short");
          else args.push("--long");

          const result = await runGit(args, cwd);
          if (result.exitCode !== 0) return err(result.stderr);

          let output = `branch: ${branch ?? "unknown"}\n\n${result.stdout}`;

          // detect merge conflicts
          const conflictCheck = await runGit(["diff", "--name-only", "--diff-filter=U"], cwd);
          if (conflictCheck.stdout.trim()) {
            output += `\n\nmerge conflicts:\n${conflictCheck.stdout}`;
          }

          return text(output);
        },
      },
      { name: "git_status" }
    );

    // ── git_diff ────────────────────────────────────────────────────

    api.registerTool(
      {
        name: "git_diff",
        label: "Git Diff",
        description: "Show file changes. Defaults to unstaged changes. Use staged=true for staged changes, or provide two refs to diff between them.",
        parameters: Type.Object({
          cwd: Type.Optional(Type.String()),
          staged: Type.Optional(Type.Boolean({ description: "Show staged changes (default: false)" })),
          ref1: Type.Optional(Type.String({ description: "First ref (commit, branch, tag)" })),
          ref2: Type.Optional(Type.String({ description: "Second ref" })),
          paths: Type.Optional(Type.Array(Type.String(), { description: "Limit diff to these file paths" })),
          nameOnly: Type.Optional(Type.Boolean({ description: "Only show changed file names" })),
        }),
        async execute(_id: string, params: Record<string, unknown>, context: any) {
          const cwd = (params.cwd as string) || context?.cwd || process.cwd();
          try { await requireRepo(cwd); } catch (e: any) { return err(e.message); }

          const args = ["diff"];

          if (params.staged) args.push("--cached");
          if (params.nameOnly) args.push("--name-only");

          if (params.ref1) {
            const v = validateRef(params.ref1 as string);
            if (v) return err(v);
            args.push(params.ref1 as string);
          }
          if (params.ref2) {
            const v = validateRef(params.ref2 as string);
            if (v) return err(v);
            args.push(params.ref2 as string);
          }

          // -- separator before file paths
          const paths = params.paths as string[] | undefined;
          if (paths && paths.length > 0) {
            args.push("--");
            for (const p of paths) {
              const v = validateFilePath(p);
              if (v) return err(`invalid path '${p}': ${v}`);
              args.push(p);
            }
          }

          const result = await runGit(args, cwd);
          if (result.exitCode !== 0) return err(result.stderr);
          if (!result.stdout.trim()) return text("no changes");

          let output = filterBinaryDiffs(result.stdout);
          output = truncateOutput(output, MAX_DIFF_LINES, "diff");
          return text(output);
        },
      },
      { name: "git_diff" }
    );

    // ── git_log ─────────────────────────────────────────────────────

    api.registerTool(
      {
        name: "git_log",
        label: "Git Log",
        description: "Show commit history. Returns recent commits with hash, author, date, and message.",
        parameters: Type.Object({
          cwd: Type.Optional(Type.String()),
          count: Type.Optional(Type.Number({ description: "Number of commits (default: 20, max: 200)", minimum: 1, maximum: 200 })),
          oneline: Type.Optional(Type.Boolean({ description: "One-line format (default: false)" })),
          ref: Type.Optional(Type.String({ description: "Branch, tag, or ref to show log for" })),
          paths: Type.Optional(Type.Array(Type.String(), { description: "Limit to commits touching these paths" })),
          author: Type.Optional(Type.String({ description: "Filter by author" })),
          since: Type.Optional(Type.String({ description: "Show commits after date (e.g. '2 weeks ago', '2026-01-01')" })),
          grep: Type.Optional(Type.String({ description: "Filter commits by message pattern" })),
        }),
        async execute(_id: string, params: Record<string, unknown>, context: any) {
          const cwd = (params.cwd as string) || context?.cwd || process.cwd();
          try { await requireRepo(cwd); } catch (e: any) { return err(e.message); }

          const count = Math.min((params.count as number) ?? 20, MAX_LOG_ENTRIES);
          const args = ["log", `-${count}`];

          if (params.oneline) {
            args.push("--oneline");
          } else {
            args.push("--format=%h %an %ad %s", "--date=short");
          }

          if (params.ref) {
            const v = validateRef(params.ref as string);
            if (v) return err(v);
            args.push(params.ref as string);
          }
          if (params.author) {
            const v = validateLogFilter(params.author as string, "author");
            if (v) return err(v);
            args.push(`--author=${params.author as string}`);
          }
          if (params.since) {
            const v = validateLogFilter(params.since as string, "since");
            if (v) return err(v);
            args.push(`--since=${params.since as string}`);
          }
          if (params.grep) {
            const v = validateLogFilter(params.grep as string, "grep");
            if (v) return err(v);
            args.push(`--grep=${params.grep as string}`);
          }

          const paths = params.paths as string[] | undefined;
          if (paths && paths.length > 0) {
            args.push("--");
            for (const p of paths) {
              const v = validateFilePath(p);
              if (v) return err(`invalid path '${p}': ${v}`);
              args.push(p);
            }
          }

          const result = await runGit(args, cwd);
          if (result.exitCode !== 0) {
            // empty repo — no commits yet
            if (result.stderr.includes("does not have any commits")) return text("no commits yet");
            return err(result.stderr);
          }
          if (!result.stdout.trim()) return text("no commits found");

          return text(truncateOutput(result.stdout, MAX_LOG_ENTRIES, "log"));
        },
      },
      { name: "git_log" }
    );

    // ── git_branch ──────────────────────────────────────────────────

    api.registerTool(
      {
        name: "git_branch",
        label: "Git Branch",
        description: "List, create, switch, or delete branches.",
        parameters: Type.Object({
          cwd: Type.Optional(Type.String()),
          action: Type.Optional(Type.Union([
            Type.Literal("list"),
            Type.Literal("create"),
            Type.Literal("switch"),
            Type.Literal("delete"),
          ], { description: "Action to perform (default: list)" })),
          name: Type.Optional(Type.String({ description: "Branch name (required for create/switch/delete)" })),
          startPoint: Type.Optional(Type.String({ description: "Start point for new branch (default: HEAD)" })),
          all: Type.Optional(Type.Boolean({ description: "List remote branches too" })),
        }),
        async execute(_id: string, params: Record<string, unknown>, context: any) {
          const cwd = (params.cwd as string) || context?.cwd || process.cwd();
          try { await requireRepo(cwd); } catch (e: any) { return err(e.message); }

          const action = (params.action as string) ?? "list";
          const name = params.name as string | undefined;

          if (action === "list") {
            const args = ["branch", "-v"];
            if (params.all) args.push("-a");
            const result = await runGit(args, cwd);
            if (result.exitCode !== 0) return err(result.stderr);
            return text(result.stdout || "no branches");
          }

          if (!name) return err(`branch name required for '${action}'`);
          const nameErr = validateBranchName(name);
          if (nameErr) return err(nameErr);

          if (action === "create") {
            const args = ["branch", name];
            if (params.startPoint) {
              const v = validateRef(params.startPoint as string);
              if (v) return err(v);
              args.push(params.startPoint as string);
            }
            const result = await runGit(args, cwd);
            if (result.exitCode !== 0) return err(result.stderr);
            return text(`created branch '${name}'`);
          }

          if (action === "switch") {
            const result = await runGit(["switch", name], cwd);
            if (result.exitCode !== 0) return err(result.stderr);
            return text(`switched to '${name}'`);
          }

          if (action === "delete") {
            if (isProtected(name)) return err(`cannot delete protected branch '${name}'`);
            const result = await runGit(["branch", "-d", name], cwd);
            if (result.exitCode !== 0) return err(result.stderr);
            return text(`deleted branch '${name}'`);
          }

          return err(`unknown action '${action}'`);
        },
      },
      { name: "git_branch" }
    );

    // ── git_commit ──────────────────────────────────────────────────

    api.registerTool(
      {
        name: "git_commit",
        label: "Git Commit",
        description: "Stage files and commit. Sanitizes commit messages and validates branch. Won't commit to main/master unless explicitly allowed in config.",
        parameters: Type.Object({
          cwd: Type.Optional(Type.String()),
          message: Type.String({ description: "Commit message" }),
          files: Type.Optional(Type.Array(Type.String(), { description: "Files to stage before committing. If empty, commits whatever is already staged." })),
          all: Type.Optional(Type.Boolean({ description: "Stage all modified/deleted files (-a)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>, context: any) {
          const cwd = (params.cwd as string) || context?.cwd || process.cwd();
          try { await requireRepo(cwd); } catch (e: any) { return err(e.message); }

          // check protected branch
          const branch = await getCurrentBranch(cwd);
          if (branch && !cfg.allowMainCommit && isProtected(branch)) {
            return err(`direct commits to '${branch}' are blocked. set allowMainCommit: true in config to override.`);
          }

          // stage files if specified
          const files = params.files as string[] | undefined;
          if (files && files.length > 0) {
            for (const f of files) {
              const v = validateFilePath(f);
              if (v) return err(`invalid path '${f}': ${v}`);
            }
            const addResult = await runGit(["add", "--", ...files], cwd);
            if (addResult.exitCode !== 0) return err(`staging failed: ${addResult.stderr}`);
          }

          // build commit message — written to a temp file to avoid shell injection
          let message = params.message as string;
          if (cfg.commitPrefix) message = `${cfg.commitPrefix}${message}`;

          const msgFile = join(tmpdir(), `openclaw-git-msg-${randomUUID()}.txt`);
          try {
            writeFileSync(msgFile, message, "utf-8");
            const args = ["commit", "--file", msgFile];
            if (params.all) args.splice(1, 0, "-a");

            const result = await runGit(args, cwd);
            if (result.exitCode !== 0) return err(result.stderr || result.stdout);
            return text(result.stdout);
          } finally {
            try { unlinkSync(msgFile); } catch {}
          }
        },
      },
      { name: "git_commit" }
    );

    // ── git_push ────────────────────────────────────────────────────

    api.registerTool(
      {
        name: "git_push",
        label: "Git Push",
        description: "Push to remote. Force-push is blocked by default and always blocked on protected branches.",
        parameters: Type.Object({
          cwd: Type.Optional(Type.String()),
          remote: Type.Optional(Type.String({ description: "Remote name (default: from config)" })),
          branch: Type.Optional(Type.String({ description: "Branch to push (default: current)" })),
          force: Type.Optional(Type.Boolean({ description: "Force push (blocked unless config allows it)" })),
          setUpstream: Type.Optional(Type.Boolean({ description: "Set upstream tracking (-u)" })),
          dryRun: Type.Optional(Type.Boolean({ description: "Dry run — show what would be pushed without pushing" })),
        }),
        async execute(_id: string, params: Record<string, unknown>, context: any) {
          const cwd = (params.cwd as string) || context?.cwd || process.cwd();
          try { await requireRepo(cwd); } catch (e: any) { return err(e.message); }

          const remote = (params.remote as string) ?? cfg.defaultRemote;
          const remoteErr = validateRemoteName(remote);
          if (remoteErr) return err(remoteErr);
          const branch = (params.branch as string) ?? (await getCurrentBranch(cwd));
          const force = Boolean(params.force);

          if (branch) {
            const nameErr = validateBranchName(branch.replace(/^\(detached.*\)$/, ""));
            if (nameErr && !branch.startsWith("(detached")) return err(nameErr);
          }

          if (force) {
            if (!cfg.allowForcePush) return err("force push is disabled. set allowForcePush: true in config to enable.");
            if (branch && isProtected(branch)) return err(`force push to protected branch '${branch}' is always blocked.`);
          }

          const args = ["push"];
          if (force) args.push("--force-with-lease"); // safer than --force
          if (params.setUpstream) args.push("-u");
          if (params.dryRun) args.push("--dry-run");
          args.push(remote);
          if (branch && !branch.startsWith("(detached")) args.push(branch);

          const result = await runGit(args, cwd);
          if (result.exitCode !== 0) return err(result.stderr);
          // git push output goes to stderr normally
          return text(result.stderr || result.stdout || "pushed successfully");
        },
      },
      { name: "git_push" }
    );

    // ── git_pull ────────────────────────────────────────────────────

    api.registerTool(
      {
        name: "git_pull",
        label: "Git Pull",
        description: "Pull from remote.",
        parameters: Type.Object({
          cwd: Type.Optional(Type.String()),
          remote: Type.Optional(Type.String()),
          branch: Type.Optional(Type.String()),
          rebase: Type.Optional(Type.Boolean({ description: "Pull with rebase instead of merge" })),
        }),
        async execute(_id: string, params: Record<string, unknown>, context: any) {
          const cwd = (params.cwd as string) || context?.cwd || process.cwd();
          try { await requireRepo(cwd); } catch (e: any) { return err(e.message); }

          const args = ["pull"];
          if (params.rebase) args.push("--rebase");
          if (params.remote) {
            const remoteErr = validateRemoteName(params.remote as string);
            if (remoteErr) return err(remoteErr);
            args.push(params.remote as string);
          }
          if (params.branch) {
            const v = validateRef(params.branch as string);
            if (v) return err(v);
            args.push(params.branch as string);
          }

          const result = await runGit(args, cwd);
          if (result.exitCode !== 0) return err(result.stderr);
          return text(result.stdout || result.stderr || "up to date");
        },
      },
      { name: "git_pull" }
    );

    // ── git_stash ───────────────────────────────────────────────────

    api.registerTool(
      {
        name: "git_stash",
        label: "Git Stash",
        description: "Stash, pop, or list stashed changes.",
        parameters: Type.Object({
          cwd: Type.Optional(Type.String()),
          action: Type.Optional(Type.Union([
            Type.Literal("push"),
            Type.Literal("pop"),
            Type.Literal("list"),
            Type.Literal("drop"),
            Type.Literal("show"),
          ], { description: "Stash action (default: push)" })),
          message: Type.Optional(Type.String({ description: "Stash message (for push)" })),
          index: Type.Optional(Type.Number({ description: "Stash index for pop/drop/show (default: 0)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>, context: any) {
          const cwd = (params.cwd as string) || context?.cwd || process.cwd();
          try { await requireRepo(cwd); } catch (e: any) { return err(e.message); }

          const action = (params.action as string) ?? "push";
          const rawIdx = (params.index as number) ?? 0;
          const idx = Math.max(0, Math.floor(rawIdx));

          if (action === "list") {
            const result = await runGit(["stash", "list"], cwd);
            if (result.exitCode !== 0) return err(result.stderr);
            return text(result.stdout || "no stashes");
          }

          if (action === "push") {
            const args = ["stash", "push"];
            if (params.message) args.push("-m", params.message as string);
            const result = await runGit(args, cwd);
            if (result.exitCode !== 0) return err(result.stderr);
            return text(result.stdout || "stashed");
          }

          if (action === "pop") {
            const result = await runGit(["stash", "pop", `stash@{${idx}}`], cwd);
            if (result.exitCode !== 0) return err(result.stderr);
            return text(result.stdout || "popped stash");
          }

          if (action === "drop") {
            const result = await runGit(["stash", "drop", `stash@{${idx}}`], cwd);
            if (result.exitCode !== 0) return err(result.stderr);
            return text(result.stdout || "dropped stash");
          }

          if (action === "show") {
            const result = await runGit(["stash", "show", "-p", `stash@{${idx}}`], cwd);
            if (result.exitCode !== 0) return err(result.stderr);
            return text(truncateOutput(filterBinaryDiffs(result.stdout), MAX_DIFF_LINES, "stash diff"));
          }

          return err(`unknown stash action '${action}'`);
        },
      },
      { name: "git_stash" }
    );

    // ── git_blame ───────────────────────────────────────────────────

    api.registerTool(
      {
        name: "git_blame",
        label: "Git Blame",
        description: "Show line-by-line blame for a file, optionally limited to a line range.",
        parameters: Type.Object({
          cwd: Type.Optional(Type.String()),
          file: Type.String({ description: "File path to blame" }),
          startLine: Type.Optional(Type.Number({ description: "Start line number" })),
          endLine: Type.Optional(Type.Number({ description: "End line number" })),
        }),
        async execute(_id: string, params: Record<string, unknown>, context: any) {
          const cwd = (params.cwd as string) || context?.cwd || process.cwd();
          try { await requireRepo(cwd); } catch (e: any) { return err(e.message); }

          const file = params.file as string;
          const v = validateFilePath(file);
          if (v) return err(v);

          const args = ["blame"];
          if (params.startLine && params.endLine) {
            args.push(`-L${params.startLine},${params.endLine}`);
          } else if (params.startLine) {
            args.push(`-L${params.startLine},+20`);
          }
          args.push("--", file);

          const result = await runGit(args, cwd);
          if (result.exitCode !== 0) return err(result.stderr);
          return text(truncateOutput(result.stdout, MAX_DIFF_LINES, "blame"));
        },
      },
      { name: "git_blame" }
    );

    // ── git_pr ──────────────────────────────────────────────────────

    api.registerTool(
      {
        name: "git_pr",
        label: "Create Pull Request",
        description: "Create a pull request using the GitHub CLI (gh). Returns an error if gh is not installed.",
        parameters: Type.Object({
          cwd: Type.Optional(Type.String()),
          title: Type.String({ description: "PR title" }),
          body: Type.Optional(Type.String({ description: "PR body/description" })),
          base: Type.Optional(Type.String({ description: "Base branch (default: repo default)" })),
          draft: Type.Optional(Type.Boolean({ description: "Create as draft PR" })),
          labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to add" })),
        }),
        async execute(_id: string, params: Record<string, unknown>, context: any) {
          const cwd = (params.cwd as string) || context?.cwd || process.cwd();
          try { await requireRepo(cwd); } catch (e: any) { return err(e.message); }

          // check gh is available
          const ghCheck = await new Promise<boolean>((resolve) => {
            const { execFile: ef } = require("node:child_process");
            ef("gh", ["--version"], { timeout: 5000 }, (err: any) => resolve(!err));
          });
          if (!ghCheck) return err("gh CLI is not installed. install it from https://cli.github.com/ to create PRs.");

          // validate title
          const title = params.title as string;
          if (title.startsWith("-")) return err("PR title cannot start with a dash");

          // validate labels
          const labels = params.labels as string[] | undefined;
          if (labels && labels.length > 0) {
            for (const l of labels) {
              const lv = validateLabel(l);
              if (lv) return err(lv);
            }
          }

          // write body to temp file to avoid injection
          const body = (params.body as string) ?? "";

          const bodyFile = join(tmpdir(), `openclaw-pr-body-${randomUUID()}.md`);
          try {
            writeFileSync(bodyFile, body, "utf-8");
            const args = ["pr", "create", "--title", title, "--body-file", bodyFile];
            if (params.base) {
              const v = validateRef(params.base as string);
              if (v) return err(v);
              args.push("--base", params.base as string);
            }
            if (params.draft) args.push("--draft");
            if (labels && labels.length > 0) {
              args.push("--label", labels.join(","));
            }

            // gh is not git, so we use execFile directly
            const { execFile: ef } = require("node:child_process");
            const result = await new Promise<GitResult>((resolve) => {
              ef("gh", args, { cwd, timeout: 30_000 }, (err: any, stdout: string, stderr: string) => {
                const exitCode = err && "code" in err ? err.code as number : err ? 1 : 0;
                resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
              });
            });

            if (result.exitCode !== 0) return err(result.stderr || result.stdout);
            return text(result.stdout || result.stderr);
          } finally {
            try { unlinkSync(bodyFile); } catch {}
          }
        },
      },
      { name: "git_pr" }
    );

    // ── slash command: /git ──────────────────────────────────────────

    api.registerCommand({
      name: "git",
      description: "Quick git status for the current workspace",
      acceptsArgs: true,
      handler: async (ctx: any) => {
        const cwd = ctx?.cwd || process.cwd();
        if (!(await isGitRepo(cwd))) return { text: "not a git repo" };

        const branch = await getCurrentBranch(cwd);
        const status = await runGit(["status", "--short"], cwd);
        const logResult = await runGit(["log", "-5", "--oneline"], cwd);

        let output = `branch: ${branch}\n`;
        if (status.stdout.trim()) {
          output += `\nchanges:\n${status.stdout}`;
        } else {
          output += "\nworking tree clean";
        }
        if (logResult.stdout.trim()) {
          output += `\n\nrecent commits:\n${logResult.stdout}`;
        }

        return { text: output };
      },
    });

    // ── CLI ─────────────────────────────────────────────────────────

    api.registerCli(
      ({ program }: any) => {
        const git = program.command("git").description("Git operations");

        git
          .command("status")
          .description("Show git status")
          .action(async () => {
            const cwd = process.cwd();
            if (!(await isGitRepo(cwd))) { console.log("not a git repo"); return; }
            const branch = await getCurrentBranch(cwd);
            console.log(`branch: ${branch}`);
            const result = await runGit(["status", "--short"], cwd);
            console.log(result.stdout || "clean");
          });

        git
          .command("log")
          .description("Show recent commits")
          .option("--count <n>", "Number of commits", "20")
          .action(async (opts: any) => {
            const cwd = process.cwd();
            if (!(await isGitRepo(cwd))) { console.log("not a git repo"); return; }
            const count = Math.max(1, Math.min(200, parseInt(opts.count) || 20));
            const result = await runGit(["log", `-${count}`, "--oneline"], cwd);
            if (result.exitCode !== 0) {
              console.log(result.stderr.includes("does not have any commits") ? "no commits yet" : result.stderr);
              return;
            }
            console.log(result.stdout || "no commits");
          });
      },
      { commands: ["git"] }
    );
  },
};

export default plugin;
