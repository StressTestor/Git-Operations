# git-operations

safe git workflow tools for openclaw agents. branch, commit, push, PR — without the foot-guns.

i built this because making an agent run raw git commands through exec felt wrong. and dangerous. mostly dangerous.

day 4 of [20 days of claw](https://github.com/StressTestor).

## what it does

gives your openclaw agent 10 git tools with proper input validation and safety rails:

| tool | what it does |
|------|-------------|
| `git_status` | working tree status, branch, merge conflict detection |
| `git_diff` | staged/unstaged/between-refs diffs with binary filtering |
| `git_log` | commit history with flexible filtering |
| `git_branch` | list, create, switch, delete branches |
| `git_commit` | stage + commit with message sanitization |
| `git_push` | push with force-push protection |
| `git_pull` | pull with optional rebase |
| `git_stash` | push, pop, list, drop, show |
| `git_blame` | line-by-line blame with range support |
| `git_pr` | create PRs via gh CLI |

## install

add to your `openclaw.json`:

```json
{
  "plugins": {
    "git-operations": {
      "path": "/path/to/git-operations"
    }
  }
}
```

## config

all optional. sane defaults.

```json
{
  "plugins": {
    "git-operations": {
      "path": "/path/to/git-operations",
      "allowForcePush": false,
      "allowMainCommit": false,
      "defaultRemote": "origin",
      "commitPrefix": "",
      "protectedBranches": ["main", "master"]
    }
  }
}
```

| option | default | what it does |
|--------|---------|-------------|
| `allowForcePush` | `false` | blocks --force unless explicitly enabled |
| `allowMainCommit` | `false` | blocks direct commits to main/master |
| `defaultRemote` | `"origin"` | default remote for push/pull |
| `commitPrefix` | `""` | prepended to all commit messages |
| `protectedBranches` | `["main", "master"]` | can't be force-pushed or deleted. ever. |

## security

this is the whole point of the plugin existing.

- **no shell interpolation** — uses `execFile`, not `exec`. no shell involved.
- **branch name validation** — must match `^[a-zA-Z0-9._/-]+$`. no spaces, no flags, no injection.
- **commit messages via temp file** — written to disk and passed with `--file`, never interpolated into a command string.
- **PR bodies via temp file** — same approach, `--body-file` instead of inline.
- **`--` separator** — always used before file paths to prevent flag injection.
- **allowlisted subcommands** — only known git subcommands can run. no `git -c` or arbitrary args.
- **force push protection** — blocked by default. even when enabled, protected branches are still blocked. uses `--force-with-lease` instead of raw `--force`.
- **binary diff filtering** — binary files get flagged instead of dumping garbage into the output.
- **output truncation** — large diffs/logs get truncated at 500/200 lines so the agent context doesn't explode.
- **path validation** — blocks paths starting with `-` and containing shell metacharacters.

## slash command

`/git` — quick status for the current workspace.

## cli

```
openclaw git status
openclaw git log --count 10
```

## license

MIT
