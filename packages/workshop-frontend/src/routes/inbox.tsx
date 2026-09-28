import { createFileRoute } from "@tanstack/react-router";
import { InboxPage } from "../features/email-inbox/InboxPage";

export const Route = createFileRoute("/inbox")({ component: InboxPage });
