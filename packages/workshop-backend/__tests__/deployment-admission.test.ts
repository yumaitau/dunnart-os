import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import type { DeploymentBackups } from "../src/deployment-backups";
import { trackDeploymentContext, withDeploymentAdmission } from "../src/deployment-admission";

it("holds request admission through registered background auth work", async () => {
  const namespace = (env as typeof env & { TEST_DEPLOYMENT_BACKUPS: DurableObjectNamespace<DeploymentBackups> }).TEST_DEPLOYMENT_BACKUPS;
  const stub = namespace.getByName("");
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "exports", { value: { DeploymentBackups: namespace } });
  const tracked = trackDeploymentContext(ctx, true);
  let finish!: () => void;
  const background = new Promise<void>(resolve => { finish = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const operation = withDeploymentAdmission(tracked, async () => {
    tracked.waitUntil(background);
    entered();
    return "auth response";
  });
  await started;
  const maintenance = runInDurableObject(stub, instance => Reflect.get(instance, "beginMaintenance").call(instance, "auth-capture"));
  await runInDurableObject(stub, async (_instance, storageCtx) => {
    expect(storageCtx.storage.kv.get("maintenance/owner")).toBe("auth-capture");
    expect([...storageCtx.storage.kv.list({ prefix: "maintenance/lease/" })]).toHaveLength(1);
  });
  expect(await stub.admitRequest()).toBeNull();
  finish();
  await operation;
  await maintenance;
  await runInDurableObject(stub, instance => Reflect.get(instance, "endMaintenance").call(instance, "auth-capture"));
  expect(await operation).toBe("auth response");
});

it("does not contact backup infrastructure when the optional feature is unconfigured", async () => {
  const tracked = trackDeploymentContext(createExecutionContext(), false);
  expect(await withDeploymentAdmission(tracked, async () => 7)).toBe(7);
});
