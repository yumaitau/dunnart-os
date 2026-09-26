import { DurableObject } from "cloudflare:workers";
import { recoveryBytes, recoveryDigest } from "@gadgets/backend-utils/recovery-archive";
import { deleteRecoverySnapshot, stageRecoverySnapshot, verifyRecoverySnapshot, writeRecoverySnapshot } from "@gadgets/backend-utils/recovery-repository";
import type { BackupSchedule, BackupStatus, BackupRun, BackupCoverage, BackupVerification, BackupRestorePreview, BackupRestoreStage } from "@gadgets/workshop-shared/deployment-backups";
import type { DeploymentBackupEnv, DeploymentRecovery } from "./deployment-backup-contract";
import { createDeploymentRecovery } from "./deployment-recovery";
import { nextBackupAt, validateBackupSchedule, DEFAULT_BACKUP_SCHEDULE } from "./deployment-backup-schedule";

type Run = BackupRun & { phase: "queued" | "capturing" | "done" };
type State = { schedule: BackupSchedule; nextRunAt: number | null; runs: Run[] };
const WATCHDOG_MS = 15 * 60 * 1000;

/** Deployment singleton orchestrating durable capture and inactive restore through admin authority. */
export class DeploymentBackups extends DurableObject<DeploymentBackupEnv> {
  private state: State = { schedule: { ...DEFAULT_BACKUP_SCHEDULE }, nextRunAt: null, runs: [] };
  private recovery: DeploymentRecovery;
  private work: Promise<void> | undefined;
  private drainWaiters = new Set<() => void>();
  private drainTimeoutMs = 30_000;
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: DeploymentBackupEnv) {
    super(ctx, env);
    this.recovery = createDeploymentRecovery(env, ctx.exports, ctx.storage, {
      begin: run => this.beginMaintenance(run), end: run => this.endMaintenance(run),
    });
    ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get<State>("backups") ?? this.state;
    });
  }

  /** Admit one backend HTTP/RPC operation unless a persisted capture barrier is closed. */
  async admitRequest(): Promise<string | null> {
    if (this.ctx.storage.kv.get("maintenance/owner")) return null;
    const lease = crypto.randomUUID();
    this.ctx.storage.kv.put(`maintenance/lease/${lease}`, Date.now());
    await this.ctx.storage.sync();
    return lease;
  }

  /** Release only the caller's admission lease after all its registered work has drained. */
  async finishRequest(lease: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(lease)) throw new Error("Invalid deployment admission lease.");
    this.ctx.storage.kv.delete(`maintenance/lease/${lease}`);
    await this.ctx.storage.sync();
    if (![...this.ctx.storage.kv.list({ prefix: "maintenance/lease/", limit: 1 })].length) {
      for (const wake of this.drainWaiters) wake();
    }
  }

  private async beginMaintenance(run: string): Promise<void> {
    const owner = this.ctx.storage.kv.get<string>("maintenance/owner");
    if (owner && owner !== run) throw new Error("Another recovery run owns deployment maintenance.");
    this.ctx.storage.kv.put("maintenance/owner", run);
    await this.ctx.storage.sync();
    const active = () => [...this.ctx.storage.kv.list({ prefix: "maintenance/lease/", limit: 1 })].length > 0;
    if (!active()) return;
    let wake!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>(resolve => {
        wake = resolve; this.drainWaiters.add(wake);
        timer = setTimeout(resolve, this.drainTimeoutMs);
        if (!active()) resolve();
      });
    } finally { this.drainWaiters.delete(wake); if (timer !== undefined) clearTimeout(timer); }
    // A lost request may leave a persisted lease. Time is not proof that its mutation stopped.
    if (active()) throw new Error("Deployment requests have not drained. Capture was refused; unresolved admission leases remain.");
  }

  private async endMaintenance(run: string): Promise<void> {
    const owner = this.ctx.storage.kv.get<string>("maintenance/owner");
    if (owner && owner !== run) throw new Error("Recovery run does not own deployment maintenance.");
    this.ctx.storage.kv.delete("maintenance/owner");
    await this.ctx.storage.sync();
  }

  private save(): Promise<void> { return this.ctx.storage.put("backups", this.state); }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.catch(() => {});
    return result;
  }

  private async configuration() {
    if (!this.env.BACKUPS || !this.env.BACKUP_DEPLOYMENT_ID ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(this.env.BACKUP_DEPLOYMENT_ID) ||
        !this.env.BACKUP_PUBLIC_KEY || !this.env.BACKUP_AUTHENTICATION_KEY) {
      throw new Error("Recovery archive storage and keys must be configured by the deployment operator.");
    }
    const publicKey: JsonWebKey = JSON.parse(this.env.BACKUP_PUBLIC_KEY);
    if (publicKey.kty !== "RSA" || !publicKey.n || !publicKey.e || ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(key => key in publicKey) ||
        recoveryBytes(publicKey.n.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(publicKey.n.length / 4) * 4, "="), 1024).length < 384) {
      throw new Error("A public RSA recovery key of at least 3072 bits is required.");
    }
    await crypto.subtle.importKey("jwk", publicKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
    const bytes = recoveryBytes(this.env.BACKUP_AUTHENTICATION_KEY, 128);
    if (bytes.length < 32) throw new Error("Recovery authentication key must contain at least 32 bytes.");
    const authenticationKey = await crypto.subtle.importKey("raw", new Uint8Array(bytes),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const recoveryKeyId = await recoveryDigest(new TextEncoder().encode(JSON.stringify([publicKey.kty, publicKey.n, publicKey.e])));
    return { bucket: this.env.BACKUPS, deployment: this.env.BACKUP_DEPLOYMENT_ID, publicKey, authenticationKey, recoveryKeyId };
  }

  /** Safe readiness and execution history; configuration secrets never leave this object. */
  async getBackupStatus(): Promise<BackupStatus> {
    let configured = false, recoveryKeyId: string | null = null;
    const coverage: BackupCoverage[] = [];
    try { recoveryKeyId = (await this.configuration()).recoveryKeyId; configured = true; }
    catch { coverage.push({ id: "archive-configuration", title: "Archive storage and recovery keys", ready: false,
      reason: "Deployment operator must configure valid archive storage, deployment identity, and recovery keys." }); }
    try { coverage.push(...await this.recovery.coverage()); }
    catch { coverage.push({ id: "deployment-inventory", title: "Deployment inventory", ready: false,
      reason: "Required deployment stores could not be enumerated." }); }
    if (!coverage.length) coverage.push({ id: "deployment-inventory", title: "Deployment inventory", ready: false,
      reason: "The deployment inventory contains no components." });
    return { configured, recoveryKeyId, coverage, schedule: { ...this.state.schedule }, nextRunAt: this.state.nextRunAt,
      running: this.state.runs.some(r => r.status === "running"),
      runs: this.state.runs.map(({ phase: _phase, ...run }) => ({ ...run })) };
  }

  /** Authorize the target name of a verified isolated workspace from this archive. */
  async getRestoredWorkspaceTarget(run: string, originalWorkspaceId: string): Promise<string> {
    const required = await this.inventory(run);
    if (!/^[a-f0-9]{64}$/.test(originalWorkspaceId) || !required.includes(`workspace-${originalWorkspaceId}`)) {
      throw new Error("The requested workspace is not part of this archive.");
    }
    return this.recovery.getRestoredWorkspaceTarget(run, originalWorkspaceId);
  }

  /** Rebuild lost coordinator inventory only from authenticated, fully intact R2 archives. */
  rescanBackupArchives(): Promise<BackupStatus> {
    return this.serialize(async () => {
      if (this.state.runs.some(run => run.status === "running")) throw new Error("Archive rediscovery requires capture to finish first.");
      const configuration = await this.configuration();
      const prefix = `recovery/v1/${configuration.deployment}/`;
      const discovered: Run[] = [];
      let cursor: string | undefined;
      let count = 0;
      do {
        const page = await configuration.bucket.list({ prefix, delimiter: "/", cursor, limit: 100 });
        for (const runPrefix of page.delimitedPrefixes) {
          if (++count > 1000) throw new Error("Archive rediscovery exceeds 1000 runs; inspect archive storage before retrying.");
          const id = runPrefix.slice(prefix.length, -1);
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || this.state.runs.some(run => run.id === id && run.status === "complete")) continue;
          const head = await configuration.bucket.head(`${runPrefix}head.json`);
          if (!head) continue; // Interrupted prefixes have no published archive.
          let verified;
          try { verified = await verifyRecoverySnapshot({ ...configuration, run: id }); }
          catch {
            discovered.push({ id, trigger: "recovered", status: "failed", phase: "done",
              startedAt: head.uploaded.getTime(), finishedAt: Date.now(), components: 0, bytes: 0,
              error: "Stored archive could not be authenticated or is incomplete. It cannot be restored." });
            continue;
          }
          await this.ctx.storage.put(`inventory/${id}`, verified.components.map(component => component.id));
          discovered.push({ id, trigger: "recovered", status: "complete", phase: "done",
            startedAt: head.uploaded.getTime(), finishedAt: head.uploaded.getTime(), verifiedAt: Date.now(),
            components: verified.components.length, bytes: verified.bytes });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      const replaced = new Set(discovered.map(run => run.id));
      const all = [...this.state.runs.filter(run => !replaced.has(run.id)), ...discovered].toSorted((a, b) => b.startedAt - a.startedAt);
      this.state.runs = [...all.filter(run => run.status === "complete").slice(0, 100),
        ...all.filter(run => run.status !== "complete").slice(0, 100)].toSorted((a, b) => b.startedAt - a.startedAt);
      await this.save();
      return this.getBackupStatus();
    });
  }

  /** Persist a validated UTC schedule and ensure the durable alarm follows it. */
  setBackupSchedule(schedule: BackupSchedule): Promise<BackupStatus> {
    return this.serialize(async () => {
      this.state.schedule = validateBackupSchedule(schedule);
      this.state.nextRunAt = nextBackupAt(this.state.schedule, Date.now());
      await this.saveAndArm();
      return this.getBackupStatus();
    });
  }

  private async saveAndArm(): Promise<void> {
    const running = this.state.runs.find(r => r.status === "running");
    const alarmAt = running ? Date.now() + (running.phase === "queued" ? 1 : WATCHDOG_MS) : this.state.nextRunAt;
    // The request is not durably queued unless both its state and wakeup commit together.
    await this.ctx.storage.transaction(async transaction => {
      await transaction.put("backups", this.state);
      if (alarmAt === null) await transaction.deleteAlarm();
      else await transaction.setAlarm(alarmAt);
    });
  }

  private async arm(): Promise<void> {
    const running = this.state.runs.find(r => r.status === "running");
    if (running) await this.ctx.storage.setAlarm(running.phase === "queued" ? Date.now() + 1 : Date.now() + WATCHDOG_MS);
    else if (this.state.nextRunAt !== null) await this.ctx.storage.setAlarm(this.state.nextRunAt);
    else await this.ctx.storage.deleteAlarm();
  }

  private async enqueue(trigger: "manual" | "scheduled"): Promise<void> {
    if (this.state.runs.some(r => r.status === "running")) throw new Error("A backup is already running.");
    this.state.runs.unshift({ id: crypto.randomUUID(), startedAt: Date.now(), finishedAt: null, trigger,
      status: "running", components: 0, bytes: 0, phase: "queued" });
    await this.saveAndArm();
  }

  /** Queue work durably before returning so browser disconnection cannot lose a manual request. */
  startBackup(): Promise<BackupStatus> {
    return this.serialize(async () => { await this.enqueue("manual"); return this.getBackupStatus(); });
  }

  /** Resume queued work, fail interrupted capture safely, and launch due scheduled runs. */
  async alarm(): Promise<void> {
    if (this.work) return this.work;
    this.work = this.executeAlarm().finally(() => { this.work = undefined; });
    return this.work;
  }

  private async executeAlarm(): Promise<void> {
    let run = this.state.runs.find(r => r.status === "running");
    if (!run && this.state.nextRunAt !== null && this.state.nextRunAt <= Date.now()) {
      await this.serialize(async () => {
        if (!this.state.runs.some(r => r.status === "running")) await this.enqueue("scheduled");
      });
      run = this.state.runs.find(r => r.status === "running");
    }
    if (!run) { await this.arm(); return; }
    if (run.phase !== "queued") {
      try { await this.recovery.release(run.id); }
      catch {
        run.error = "Interrupted capture cleanup is pending. The durable alarm will retry releasing snapshot fences.";
        await this.saveAndArm(); return;
      }
      // A reset can happen after head publication but before the final state write. The signed
      // receipt proves this run passed the capture-validation publication gate; recover completion
      // only after checking every archived object and the persisted required inventory again.
      try {
        const verified = await verifyRecoverySnapshot({ ...await this.configuration(), run: run.id });
        const required = await this.inventory(run.id);
        if (verified.components.length !== required.length || verified.components.some(c => !required.includes(c.id))) throw new Error("coverage");
        run.status = "complete"; run.components = verified.components.length; run.bytes = verified.bytes;
        run.verifiedAt = Date.now(); delete run.error;
      } catch {
        run.status = "failed";
        run.error = "Capture was interrupted before a complete archive could be verified; start a new run.";
      }
      run.phase = "done"; run.finishedAt = Date.now();
      await this.finish();
      if (run.status === "complete") await this.retain().catch(() => {});
      return;
    }
    run.phase = "capturing";
    await this.saveAndArm();
    let captured = false;
    try {
      const status = await this.getBackupStatus();
      if (!status.configured || status.coverage.some(c => !c.ready)) throw new Error("coverage");
      const configuration = await this.configuration();
      const snapshot = await this.recovery.acquire(run.id);
      await this.ctx.storage.put(`inventory/${run.id}`, snapshot.required);
      const manifest = await writeRecoverySnapshot({ ...configuration, run: run.id, ...snapshot,
        beforePublish: () => this.recovery.validate(run!.id) });
      const verified = await verifyRecoverySnapshot({ ...configuration, run: run.id });
      if (verified.components.length !== snapshot.required.length ||
          verified.components.some(c => !snapshot.required.includes(c.id))) throw new Error("coverage");
      run.components = manifest.components.length;
      run.bytes = verified.bytes;
      run.verifiedAt = Date.now();
      captured = true;
    } catch {
      // Provider exceptions may include credentials or customer content. Persist only bounded,
      // operator-actionable categories; underlying errors never enter logs or the admin response.
      const diagnostic = await this.phaseDiagnostic(run.id);
      run.error = `Backup failed: required coverage, stable capture, or archive integrity could not be verified. Check deployment readiness and retry.${diagnostic}`;
    }
    try { await this.recovery.release(run.id); }
    catch {
      // Keep the durable run in capturing phase so a new isolate/alarm retries release before
      // any later capture. Reporting complete while a write fence remains held is unsafe.
      run.error = "Capture cleanup is pending. The durable alarm will retry releasing snapshot fences.";
      await this.saveAndArm();
      return;
    }
    run.status = captured ? "complete" : "failed";
    run.phase = "done";
    run.finishedAt = Date.now();
    await this.finish();
    if (captured) await this.retain().catch(() => {});
  }

  private async finish(): Promise<void> {
    this.state.nextRunAt = nextBackupAt(this.state.schedule, Date.now());
    // Keep failed history bounded independently of successful archive retention. Inventories live
    // under separate keys so a large deployment cannot exceed the single-value storage limit.
    let failed = 0;
    this.state.runs = this.state.runs.filter(run => run.status !== "failed" || ++failed <= 100);
    await this.saveAndArm();
  }

  private async inventory(id: string): Promise<string[]> {
    const required = await this.ctx.storage.get<string[]>(`inventory/${id}`);
    if (!required?.length) throw new Error("The completed archive inventory is unavailable.");
    return required;
  }

  private async retain(): Promise<void> {
    const configuration = await this.configuration();
    const complete = this.state.runs.filter(r => r.status === "complete" && r.verifiedAt);
    if (complete.length <= this.state.schedule.retention) return;
    // Verify the newest retained archive again before removing any older successful recovery point.
    await verifyRecoverySnapshot({ ...configuration, run: complete[0].id });
    for (const run of complete.slice(this.state.schedule.retention)) {
      await deleteRecoverySnapshot(configuration.bucket, configuration.deployment, run.id);
      this.state.runs = this.state.runs.filter(r => r.id !== run.id);
      await this.ctx.storage.delete(`inventory/${run.id}`);
      await this.save();
    }
  }

  /** Authenticate archived ciphertext against write-time hashes without loading a private key. */
  async verifyBackup(id: string): Promise<BackupVerification> {
    const run = this.state.runs.find(r => r.id === id);
    if (!run || run.status !== "complete") return { runId: id, verified: false, issues: ["A completed backup is required."] };
    try {
      const verified = await verifyRecoverySnapshot({ ...await this.configuration(), run: id });
      const required = await this.inventory(id);
      if (verified.components.length !== required.length || verified.components.some(c => !required.includes(c.id))) throw new Error("coverage");
      run.verifiedAt = Date.now(); await this.save();
      return { runId: id, verified: true, issues: [] };
    } catch { return { runId: id, verified: false, issues: ["Archive integrity could not be verified. An object is missing, modified, or inaccessible."] }; }
  }

  /** Validate archive integrity and inactive target coverage before accepting a private key. */
  async previewBackupRestore(id: string): Promise<BackupRestorePreview> {
    const verified = await this.verifyBackup(id);
    const run = this.state.runs.find(r => r.id === id);
    const result: BackupRestorePreview = { runId: id, ready: false, issues: [...verified.issues], target: "isolated", components: run?.components ?? 0 };
    if (!verified.verified || !run) return result;
    try {
      const preview = await this.recovery.preview(id, await this.inventory(id));
      result.target = preview.target; result.issues.push(...preview.issues);
    } catch { result.issues.push("Isolated recovery target availability could not be verified."); }
    result.ready = result.issues.length === 0;
    if (!result.ready) {
      const diagnostic = await this.phaseDiagnostic(id, true);
      if (diagnostic) result.issues.push(`Last isolated restore operation:${diagnostic}`);
    }
    return result;
  }

  private async phaseDiagnostic(id: string, restoreOnly = false): Promise<string> {
    const marker = await this.ctx.storage.get<{ phase?: unknown; component?: unknown }>(`recovery-provider/phase/${id}`);
    const allowed = new Set(["restore-component", "restore-runtime-prepare", "restore-runtime-activate", "restore-runtime-verify",
      ...restoreOnly ? [] : ["maintenance-drain", "release-escrow", "storage-baseline", "user-fence", "workspace-fence", "root-fence",
        "connector-fence", "native-baseline", "linked-record-validation", "component-capture", "final-source-validation"]]);
    const phase = typeof marker?.phase === "string" && allowed.has(marker.phase) ? marker.phase : undefined;
    const component = typeof marker?.component === "string" && /^[a-f0-9]{16}$/.test(marker.component) ? marker.component : undefined;
    return phase ? ` [${phase}${component ? `:${component}` : ""}]` : "";
  }

  /** Stage into isolated inactive storage. The supplied private key exists only during this call. */
  async stageBackupRestore(id: string, privateKey: JsonWebKey): Promise<BackupRestoreStage> {
    const preview = await this.previewBackupRestore(id);
    if (!preview.ready) return { ...preview, staged: false };
    try {
      const required = await this.inventory(id);
      const targets = await this.recovery.targets(id, required);
      await stageRecoverySnapshot({ ...await this.configuration(), run: id, privateKey, required, targets });
      await this.recovery.finalizeRestore(id, required);
      return { ...preview, staged: true };
    } catch { return { ...preview, ready: false, staged: false,
      issues: [`Isolated staging failed. Check the private recovery key and target availability. Production was not activated.${await this.phaseDiagnostic(id, true)}`] }; }
  }
}
