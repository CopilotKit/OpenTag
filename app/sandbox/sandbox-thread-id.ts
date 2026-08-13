export const SANDBOX_JOB_KINDS = [
  "promo",
  "docs-pr",
  "linear-fix",
  "linear-triage",
  "copilotkit",
] as const;

export type SandboxJobKind = (typeof SANDBOX_JOB_KINDS)[number];

export function sandboxThreadId(
  kind: SandboxJobKind,
  conversationKey: string,
): string {
  if (!conversationKey) {
    throw new Error("sandboxThreadId requires a non-empty conversationKey");
  }
  return `${kind}:${conversationKey}`;
}
