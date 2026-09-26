import type { RecoveryHookDescriptor } from "@gadgets/workshop-shared/gatekeeper-recovery";
export type { RecoveryHookDescriptor as ScheduleHookRecoveryDescriptor, GatekeeperRecoveryResolver as ScheduleRecoveryResolver } from "@gadgets/workshop-shared/gatekeeper-recovery";
/** All scheduler rows, including native initiators, encoded by the trusted archive codec. */
export type ScheduleAccountRecovery = {
  version: 1;
  accountId: string;
  rows: string;
  alarm: number | null;
};

/** Restored drivers retain every row but cannot deliver or accept activations. */
export const SCHEDULE_RECOVERY_DISABLED = ".recoveryDisabled";

/** Construct a separate account namespace for recovery verification. */
export function scheduleRecoveryAccount(scope: string, original: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(scope) || !original || original.includes("\0")) {
    throw new Error("Invalid Scheduler recovery scope.");
  }
  return `recovery:${scope}:${original}`;
}

/** Persisted capture fence, separate from permanent restore quarantine. */
export const SCHEDULE_RECOVERY_FREEZE = ".recoveryFreeze";

/** Validate a verified descriptor before granting it to the isolated hook resolver. */
export function parseScheduleHookDescriptor(value: unknown): RecoveryHookDescriptor {
  if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== "workshop-hook" ||
      !("props" in value) || !value.props || typeof value.props !== "object") {
    throw new Error("Invalid schedule initiator recovery descriptor.");
  }
  const props = value.props;
  if (!("overseerId" in props) || typeof props.overseerId !== "string" || !props.overseerId ||
      !("hookId" in props) || typeof props.hookId !== "number" || !Number.isSafeInteger(props.hookId) || props.hookId < 0) {
    throw new Error("Invalid schedule initiator recovery descriptor.");
  }
  return { kind: "workshop-hook", props: { overseerId: props.overseerId, hookId: props.hookId } };
}
