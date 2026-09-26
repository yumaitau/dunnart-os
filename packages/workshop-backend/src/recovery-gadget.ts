import { DurableObject, RpcTarget, restore, type RpcStub } from "cloudflare:workers";
import { captureNativeStorage } from "@gadgets/backend-utils/recovery-native";
import { encodePortableValue, type PortableValue } from "@gadgets/backend-utils/recovery-value";
import { nativeRecoveryCodec, type NativeRecoveryService } from "./native-recovery";

/** Parent-issued identity of the facet inspected during one recovery capture. */
export interface GadgetRecoveryScope {
  overseerId: string;
  gadgetId: number;
  chatId?: number;
}

/** Trusted inspector configuration; never supplied to an application worker. */
export interface GadgetRecoveryProps {
  scope: GadgetRecoveryScope;
  key: string;
}

/** Reconstructs either a gadget facet or a persistent callback minted by that facet. */
export type GadgetRecoveryDescriptor = GadgetRecoveryScope & (
  { kind: "gadget" } | { kind: "gadget-callback"; params: PortableValue }
);

/** An authenticated descriptor issued only by the trusted recovery inspector. */
export interface SignedGadgetRecoveryDescriptor {
  payload: string;
  signature: string;
}

async function signingKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signDescriptor(key: string, descriptor: GadgetRecoveryDescriptor)
    : Promise<SignedGadgetRecoveryDescriptor> {
  const payload = JSON.stringify(descriptor);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(key),
    new TextEncoder().encode(payload)));
  return { payload, signature: Array.from(signature, byte => byte.toString(16).padStart(2, "0")).join("") };
}

/** Verify against this capture's secret before trusting any gadget-selected RPC method result. */
export async function verifyGadgetRecoveryDescriptor(key: string, value: SignedGadgetRecoveryDescriptor)
    : Promise<GadgetRecoveryDescriptor> {
  if (!value || typeof value.payload !== "string" || typeof value.signature !== "string"
      || !/^[0-9a-f]{64}$/.test(value.signature)) {
    throw new TypeError("Invalid signed gadget recovery descriptor");
  }
  const signature = Uint8Array.from(value.signature.match(/../g)!, byte => parseInt(byte, 16));
  if (!await crypto.subtle.verify("HMAC", await signingKey(key), signature,
      new TextEncoder().encode(value.payload))) {
    throw new Error("Gadget recovery descriptor authentication failed");
  }
  return JSON.parse(value.payload);
}

class RecoveryCallback extends RpcTarget {
  #props: GadgetRecoveryProps;
  #params: unknown;

  constructor(props: GadgetRecoveryProps, params: unknown) {
    super();
    this.#props = props;
    this.#params = params;
  }

  async getRecoveryDescriptor(service?: RpcStub<NativeRecoveryService>): Promise<SignedGadgetRecoveryDescriptor> {
    return signDescriptor(this.#props.key,
      { ...this.#props.scope, kind: "gadget-callback",
        params: await encodePortableValue(this.#params, nativeRecoveryCodec(service)) });
  }
}

/** Receives original parameters directly from workerd's persisted capability restore chain. */
export function createGadgetRecoveryTarget(scope: GadgetRecoveryScope, key: string, params: unknown) {
  return new RecoveryCallback({ scope, key }, params);
}

/** Temporarily occupies the original gadget facet name while its capabilities are inspected. */
export class RecoveryGadgetInspector extends DurableObject<{}, GadgetRecoveryProps> {
  [restore](params: unknown) {
    return createGadgetRecoveryTarget(this.ctx.props.scope, this.ctx.props.key, params);
  }

  /** Describe the facet itself, rather than a nested persistent callback. */
  getRecoveryDescriptor(_service?: RpcStub<NativeRecoveryService>): Promise<SignedGadgetRecoveryDescriptor> {
    return signDescriptor(this.ctx.props.key, { ...this.ctx.props.scope, kind: "gadget" });
  }

  /** Read the original facet's storage without constructing or running its application class. */
  async exportRecoveryStorage(service?: RpcStub<NativeRecoveryService>): Promise<string> {
    return JSON.stringify(await captureNativeStorage(this.ctx.storage, nativeRecoveryCodec(service)));
  }

  /** Identify writes occurring during archive capture. */
  getRecoveryBookmark(): Promise<string> {
    return this.ctx.storage.getCurrentBookmark();
  }
}
