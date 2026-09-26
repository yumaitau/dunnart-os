// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    /** Trusted native capability provenance key; no private archive recovery material. */
    BACKUP_CAPABILITY_KEY?: string;
    // Public-collections snapshot KV.
    CONTEXT_COLLECTIONS: KVNamespace;
    // Optional Git-compatible backing repos for artifact-backed context collections.
    ARTIFACTS?: Artifacts;
    // Converts uploaded documents to text for the collection's search index.
    AI?: Ai;
  }

  interface GlobalProps {
    // Populates Cloudflare.Exports, the type of ctx.exports.
    mainModule: typeof import("./index.js");
    // Storage classes exposed as DO namespaces on ctx.exports.
    durableNamespaces:
      | "ContextCollectionDurableObject"
      | "UserLibraryDurableObject"
      | "LibraryRegistryDurableObject"
      | "ContextGatekeeper";
  }
}
