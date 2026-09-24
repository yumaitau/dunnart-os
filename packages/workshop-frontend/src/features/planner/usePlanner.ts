import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, GadgetClient, Overseer, OutputSummary } from "@gadgets/workshop-shared/api";
import { useAuthenticatedApi } from "../../AuthContext";
import type { EventInput, PlannerApi, PlannerSnapshot, TaskInput } from "./plannerTypes";

const PLANNER_BLUEPRINT = "format.dunnart-planner";

type Session = {
  overseer: RpcStub<Overseer>;
  gadget: RpcStub<GadgetClient>;
  api: RpcStub<PlannerApi>;
};

function disposeSession(session: Session | null) {
  session?.api[Symbol.dispose]();
  session?.gadget[Symbol.dispose]();
  session?.overseer[Symbol.dispose]();
}

function ownedPlanner(outputs: OutputSummary[]): OutputSummary | undefined {
  return outputs
    .filter((output) => output.output?.id === "planner" && output.owner === undefined)
    .sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime())[0];
}

async function openSession(authenticatedApi: RpcStub<AuthenticatedApi>): Promise<Session> {
  const listed = await authenticatedApi.listOutputs();
  const planner = ownedPlanner(listed.outputs);
  const overseer = planner
    ? await authenticatedApi.openGadget(planner.workspaceId)
    : await authenticatedApi.newGadgetFromBlueprint(PLANNER_BLUEPRINT, {});
  if (!planner) await overseer.setTitle("Tasks");
  const metadata = planner ? null : await overseer.getMetadata();
  const workpieceId = planner?.workpieceId ?? metadata?.defaultGadgetId;
  if (!workpieceId) {
    overseer[Symbol.dispose]();
    throw new Error("Planner was not created.");
  }
  const gadget = await overseer.getGadget(workpieceId);
  const api = await gadget.connectToGadget() as RpcStub<PlannerApi>;
  return { overseer, gadget, api };
}

export function usePlanner() {
  const { authenticatedApi } = useAuthenticatedApi();
  const session = useRef<Session | null>(null);
  const [snapshot, setSnapshot] = useState<PlannerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    const current = session.current;
    if (!current) return;
    setSnapshot(await current.api.getTasks());
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSnapshot(null);
    void openSession(authenticatedApi)
      .then(async (opened) => {
        if (cancelled) {
          disposeSession(opened);
          return;
        }
        session.current = opened;
        setSnapshot(await opened.api.getTasks());
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not open tasks.");
      });
    return () => {
      cancelled = true;
      disposeSession(session.current);
      session.current = null;
    };
  }, [authenticatedApi]);

  const run = useCallback(async (action: (api: RpcStub<PlannerApi>) => Promise<unknown>) => {
    const current = session.current;
    if (!current || pending) return false;
    setPending(true);
    setError(null);
    try {
      await action(current.api);
      setSnapshot(await current.api.getTasks());
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      return false;
    } finally {
      setPending(false);
    }
  }, [pending]);

  return {
    snapshot,
    loading: snapshot === null && error === null,
    error,
    pending,
    refresh,
    saveTask: (input: TaskInput, id?: string) =>
      run((api) => (id ? api.updateTask(id, input) : api.createTask(input))),
    deleteTask: (id: string) => run((api) => api.deleteTask(id)),
    saveEvent: (input: EventInput, id?: string) =>
      run((api) => (id ? api.updateEvent(id, input) : api.createEvent(input))),
    deleteEvent: (id: string) => run((api) => api.deleteEvent(id)),
  };
}
