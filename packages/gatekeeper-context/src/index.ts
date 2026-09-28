// Context Library worker: private per-account collections plus public per-domain collections. The
// vendor auto-provisions accounts that expose a read-only agent singleton and a management UI.

export { ContextCollectionDurableObject } from "./context-collection.js";
export { UserLibraryDurableObject } from "./user-library.js";
export { LibraryRegistryDurableObject } from "./registry-do.js";
export {
  GatekeeperVendor, ContextAccount, ContextVerifier, ContextGatekeeper,
} from "./library-gatekeeper.js";

/** Keep ES Module worker format; this worker is used over RPC/DOs, not HTTP. */
export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/") return new Response("Not found", { status: 404 });
    return new Response("Context Library worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
