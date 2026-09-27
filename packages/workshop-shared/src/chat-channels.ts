/** Supported private chat providers. */
export type ChatChannelProvider = "slack" | "teams";
/** An account's linked provider identity and private conversation. */
export interface ChatChannelLink {
  /** Opaque link identifier used for revocation. */
  id: string;
  /** Provider carrying this conversation. */
  provider: ChatChannelProvider;
  /** Workspace selected when pairing. */
  workspaceId: string;
  /** Time the verified provider identity was paired. */
  linkedAt: number;
}
/** Connection setup available to the signed-in user. */
export interface ChatChannelStatus {
  /** Providers configured by this deployment's operator. */
  providers: {
    /** Provider name. */ provider: ChatChannelProvider;
    /** Whether pairing is available. */ available: boolean;
  }[];
  /** Private conversations paired to this account. */
  links: ChatChannelLink[];
  /** Safe delivery diagnostics, without message contents or provider credentials. */
  deliveries: {
    /** Event identifier. */ id: string;
    /** Delivery lifecycle. */ status: string;
    /** Latest update time. */ updatedAt: number;
  }[];
}
/** Short-lived, single-use proof to send in a private provider conversation. */
export interface ChatChannelPairing {
  /** Command to paste into the bot's private chat. */
  command: string;
  /** Expiration timestamp in milliseconds. */
  expiresAt: number;
  /** Optional provider installation or personal-chat link. */
  openUrl: string | null;
}
