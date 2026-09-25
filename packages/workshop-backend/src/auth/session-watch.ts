import { DurableObject, RpcTarget, type RpcStub } from "cloudflare:workers";

class SessionWatch extends RpcTarget {
  constructor(private close: () => void) { super(); }
  [Symbol.dispose]() { this.close(); }
}

/** Bounds live RPC access after session expiry, remote logout or credential recovery. */
export class AuthSession extends DurableObject<Cloudflare.Env> {
  #watchers = new Set<RpcStub<() => void>>();

  async watch(sessionId: string, callback: RpcStub<() => void>): Promise<SessionWatch> {
    await this.ctx.storage.put("sessionId", sessionId);
    if (!await this.#valid()) throw new Error("Session expired.");
    const watcher = callback.dup();
    this.#watchers.add(watcher);
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    return new SessionWatch(() => {
      if (this.#watchers.delete(watcher)) watcher[Symbol.dispose]();
    });
  }

  async #valid(): Promise<boolean> {
    const id = await this.ctx.storage.get<string>("sessionId");
    if (!id || !this.env.AUTH_DB) return false;
    const session = await this.env.AUTH_DB.prepare('SELECT expiresAt FROM session WHERE id = ?').bind(id)
      .first<{ expiresAt: string }>();
    return !!session && Date.parse(session.expiresAt) > Date.now();
  }

  async alarm(): Promise<void> {
    let valid = false;
    try { valid = await this.#valid(); } catch { /* Losing the authority check closes access. */ }
    if (!valid) {
      const watchers = [...this.#watchers];
      this.#watchers.clear();
      await Promise.allSettled(watchers.map(async callback => {
        try { await callback(); } finally { callback[Symbol.dispose](); }
      }));
    } else if (this.#watchers.size) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }
}
