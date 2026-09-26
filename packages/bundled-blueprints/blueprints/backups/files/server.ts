import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// This gadget is a navigation shortcut; all backup authority stays in the trusted admin API.
export class Gadget extends DurableObject {}

export class ExportHandler extends WorkerEntrypoint {
  getExportFormats() {
    return [{ id: "instructions", label: "Setup instructions", mode: "server" as const,
      contentType: "text/markdown", fileExtension: ".md" }];
  }

  async export(_gadget: unknown, id: string): Promise<ReadableStream<Uint8Array>> {
    if (id !== "instructions") throw new Error("Unsupported Backups export format.");
    return new Response("# Backups\n\nOpen Admin in your Workshop, then choose Backups. " +
      "Deployment administrator access is required.\n\n" +
      "The operator configures archive storage and a public recovery key. Keep the matching private " +
      "key in an offline recovery kit. Configure the schedule, review coverage and history, and " +
      "verify archives in the trusted admin page. Stage restores into isolated recovery storage.\n\n" +
      "This file contains setup instructions only. It is not a backup archive or a recovery key.\n").body!;
  }
}
