export interface GitOpsConfig {
  allowForcePush: boolean;
  allowMainCommit: boolean;
  defaultRemote: string;
  commitPrefix: string;
  protectedBranches: string[];
}

const DEFAULTS: GitOpsConfig = {
  allowForcePush: false,
  allowMainCommit: false,
  defaultRemote: "origin",
  commitPrefix: "",
  protectedBranches: ["main", "master"],
};

export function resolveConfig(raw?: Record<string, unknown>): GitOpsConfig {
  if (!raw) return { ...DEFAULTS, protectedBranches: [...DEFAULTS.protectedBranches] };

  return {
    allowForcePush: raw.allowForcePush !== undefined ? Boolean(raw.allowForcePush) : DEFAULTS.allowForcePush,
    allowMainCommit: raw.allowMainCommit !== undefined ? Boolean(raw.allowMainCommit) : DEFAULTS.allowMainCommit,
    defaultRemote: (raw.defaultRemote as string) ?? DEFAULTS.defaultRemote,
    commitPrefix: (raw.commitPrefix as string) ?? DEFAULTS.commitPrefix,
    protectedBranches: Array.isArray(raw.protectedBranches) ? raw.protectedBranches as string[] : [...DEFAULTS.protectedBranches],
  };
}
