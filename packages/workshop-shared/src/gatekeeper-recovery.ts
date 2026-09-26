import type { RpcTarget, RpcStub } from "cloudflare:workers";
import type { Gatekeeper, GatekeeperUser, GatekeeperUserVerifier, HookController, HookInitiator } from "./gatekeeper";

/** Non-secret identity accepted only after the trusted recovery service verifies its attestation. */
export type GatekeeperRecoveryDescriptor = {
  /** Owning connector and capability class. */
  kind: string;
  /** Immutable capability scope; never credentials or bearer tokens. */
  props: Record<string, unknown>;
};

/** Workshop hook identity derived from a verified native initiator descriptor. */
export type RecoveryHookDescriptor = {
  /** Native Workshop hook class. */
  kind: "workshop-hook";
  /** Original object and hook identities, remapped by the destination resolver. */
  props: { overseerId: string; hookId: number };
};

/** Trusted resolver reconstructs native callbacks without invoking them. */
export interface GatekeeperRecoveryResolver extends RpcTarget {
  /** Rebind a hook to its isolated destination Overseer. */
  restoreHook(descriptor: RecoveryHookDescriptor): Promise<Fetcher<HookInitiator<RpcTarget>>>;
}

/** Native authority reconstructed by a trusted connector participant. */
export type GatekeeperRecoveryCapability = Fetcher<GatekeeperUser> | Fetcher<GatekeeperUserVerifier> |
  Fetcher<HookController<RpcTarget>> | DurableObjectClass<Gatekeeper<RpcTarget>>;

/** Service-binding-only recovery authority; never exposed to a connected account UI or agent. */
export interface GatekeeperRecoveryParticipant extends RpcTarget {
  /** Freeze each account and all deployment-owned state for this run. */
  beginRecovery(accountIds: string[], run: string): Promise<void>;
  /** Confirm all capture fences remain owned by this run before committing its archive. */
  validateRecovery(accountIds: string[], run: string): Promise<void>;
  /** Release only fences belonging to this capture. */
  endRecovery(accountIds: string[], run: string): Promise<void>;
  /** Export a versioned portable JSON snapshot of all local account state. */
  exportAccount(accountId: string): Promise<string>;
  /** Export a versioned portable JSON snapshot of all deployment-owned local state. */
  exportDomain(): Promise<string>;
  /** Restore account data and native identity in an empty, isolated namespace. */
  restoreAccount(snapshot: string, scope: string, resolver?: RpcStub<GatekeeperRecoveryResolver>): Promise<Fetcher<GatekeeperUser>>;
  /** Restore deployment-owned data in the same isolated namespace. */
  restoreDomain(snapshot: string, scope: string): Promise<void>;
  /** Rebind an authenticated descriptor to this connector's isolated namespace. */
  restoreCapability(descriptor: GatekeeperRecoveryDescriptor, scope: string): Promise<GatekeeperRecoveryCapability>;
}
