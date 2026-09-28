/** How an inbound email was assigned to a conversation. */
export type EmailRoutingReason = "new" | "thread" | "related";

/** One account's private email intake configuration. */
export interface EmailInboxConfiguration {
  /** Private intake address. Anyone holding it can submit information. */
  address: string;
  /** Owned workspace receiving emails. */
  workspaceId: string;
  /** Whether delivery may select a strongly related existing conversation. */
  continueRelated: boolean;
}

/** Safe, account-scoped receipt for an email accepted by the system. */
export interface EmailInboxReceipt {
  /** Opaque receipt identifier. */
  id: string;
  /** Sender as reported by the email, not an authenticated application identity. */
  sender: string;
  /** Bounded subject, rendered as text. */
  subject: string;
  /** Time received by the service, in milliseconds. */
  receivedAt: number;
  /** Durable processing state. */
  status: "queued" | "processing" | "complete" | "failed" | "cancelled";
  /** Local conversation link, available once the email is submitted. */
  chatPath: string | null;
  /** Why this conversation was selected, if selection has completed. */
  routing: EmailRoutingReason | null;
  /** Visible extraction limits or unsupported attachments. */
  notices: string[];
}

/** Email intake settings and recent receipts visible to the signed-in account. */
export interface EmailInboxStatus {
  /** Whether the operator has configured an intake domain. */
  available: boolean;
  /** Active private address, or null while intake is disabled for this user. */
  configuration: EmailInboxConfiguration | null;
  /** Most recent receipts, newest first. */
  messages: EmailInboxReceipt[];
}

/** A bounded page of account-owned receipts, newest first. */
export interface EmailInboxPage {
  /** At most 30 received emails. */
  messages: EmailInboxReceipt[];
  /** Exclusive sequence cursor for the next page, or null at the end. */
  nextBefore: number | null;
}

/** Plain-text email preview. Raw MIME and attachment bytes are never returned. */
export interface EmailInboxMessage extends EmailInboxReceipt {
  /** Bounded text body; null when an older receipt no longer retains its content. */
  body: string | null;
  /** Original attachment names and declared types, rendered as untrusted text. */
  attachments: { /** Bounded filename. */ name: string; /** Declared MIME type. */ type: string }[];
}
