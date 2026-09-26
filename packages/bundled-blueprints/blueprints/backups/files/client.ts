import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";

const main = el("main", {}, [
  el("h1", {}, "Backups"),
  el("p", {}, "Manage encrypted deployment backups, schedules, archive checks, and isolated recovery in the trusted admin page."),
  el("p", {}, "Deployment administrator access is required. This shortcut does not receive backup data, recovery keys, or administrator permissions."),
]);

const style = el("style", {}, "@media print { main { max-width: none; } a::after { content: ' (' attr(href) ')'; } }");
document.head.append(style);

// srcdoc frames inherit their embedding document's base URL. Use the referrer when available,
// falling back to that base for deployments which suppress referrers. Never use an operator URL.
try {
  const workshop = new URL(document.referrer || document.baseURI);
  if (workshop.protocol !== "https:" && workshop.protocol !== "http:") throw new Error("No Workshop origin");
  const target = new URL("/admin#backups", workshop.origin);
  main.append(el("a", { href: target.href, target: "_blank", rel: "noopener noreferrer" }, "Open Backups admin"));
} catch {
  main.append(el("p", {}, "Open Admin in your Workshop, then choose Backups."));
}

document.body.replaceChildren(main);
