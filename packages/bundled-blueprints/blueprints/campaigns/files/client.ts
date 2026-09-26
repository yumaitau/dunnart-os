import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import type { Campaign, CampaignStub, Channel } from "./lib/protocol.ts";
declare const gadget: CampaignStub;

document.head.append(el("style", { text: `
:root{color-scheme:light dark;font:15px/1.5 system-ui;background:Canvas;color:CanvasText}
body{margin:0}main{max-width:1100px;margin:auto;padding:24px}form,article{border:1px solid GrayText;border-radius:12px;padding:18px;margin:16px 0}
form,label{display:grid;gap:8px}input,select,textarea,button{font:inherit;padding:8px}textarea{min-height:140px}
button{cursor:pointer;margin-right:8px}h1,h2{margin:0}.copy{white-space:pre-wrap;overflow-wrap:anywhere}
@media print{form,button,[role="status"]{display:none}main{max-width:none;padding:0}article{break-inside:avoid}:root{color-scheme:light}}
` }));
const root = el("main"); document.body.append(root);
const status = el("p", { role: "status", "aria-live": "polite" });
const list = el("section", { "aria-label": "Campaign calendar" });
const title = el("input", { required: true, maxlength: 160 });
const channel = el("select", {}, ["social", "email", "sms"].map(value => el("option", { value, text: value })));
const audience = el("input", { required: true, maxlength: 1000, placeholder: "Provider list or social account" });
const content = el("textarea", { required: true, maxlength: 6000 });
const plannedAt = el("input", { type: "datetime-local" });
const save = el("button", { type: "submit", text: "Save draft" });
const cancel = el("button", { type: "button", text: "New draft" });
const form = el("form", {}, [el("label", {}, ["Campaign title", title]), el("label", {}, ["Channel", channel]),
  el("label", {}, ["Audience / account", audience]), el("label", {}, ["Message", content]),
  el("label", {}, ["Planned date (your local time)", plannedAt]), el("div", {}, [save, cancel])]);
root.append(el("h1", { text: "Campaigns" }), el("p", { text: "Draft social posts, email and SMS campaigns. Dates are plans; sending requires a connected provider and separate approval." }), form, status, el("h2", { text: "Campaign calendar" }), list);
let editing: Campaign | undefined;
let busy = false;
function clear(): void { editing = undefined; form.reset(); save.textContent = "Save draft"; }
cancel.addEventListener("click", clear);
async function run(action: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  busy = true; save.disabled = true; cancel.disabled = true;
  try { await action(); await refresh(); status.textContent = "Saved. No messages sent."; }
  catch (error) { status.textContent = error instanceof Error ? error.message : "Unable to save."; }
  finally { busy = false; save.disabled = false; cancel.disabled = false; }
}
form.addEventListener("submit", event => {
  event.preventDefault();
  void run(async () => {
    await gadget.saveCampaign({ title: title.value, channel: channel.value as Channel, audience: audience.value,
      content: content.value, plannedAt: plannedAt.value ? new Date(plannedAt.value).toISOString() : null }, editing?.id, editing?.revision);
    clear();
  });
});
function edit(item: Campaign): void {
  if (busy) return;
  editing = item; title.value = item.title; channel.value = item.channel;
  audience.value = item.audience; content.value = item.content;
  const date = item.plannedAt ? new Date(item.plannedAt) : null;
  plannedAt.value = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
  save.textContent = "Save changes"; title.focus();
}
async function refresh(): Promise<void> {
  const campaigns = await gadget.listCampaigns();
  list.replaceChildren();
  if (!campaigns.length) list.append(el("p", { text: "No campaigns yet. Create a draft or ask your agent to prepare one from your brand documents." }));
  for (const item of campaigns.sort((a, b) => (a.plannedAt ?? "~").localeCompare(b.plannedAt ?? "~"))) {
    const editButton = el("button", { type: "button", text: "Edit" }); editButton.addEventListener("click", () => edit(item));
    const review = el("button", { type: "button", text: "Mark reviewed", disabled: item.reviewedRevision === item.revision });
    review.addEventListener("click", () => void run(() => gadget.markReviewed(item.id, item.revision)));
    const remove = el("button", { type: "button", text: "Delete draft" });
    remove.addEventListener("click", () => void run(async () => { await gadget.deleteCampaign(item.id, item.revision); if (editing?.id === item.id) clear(); }));
    list.append(el("article", {}, [el("h2", { text: item.title }),
      el("p", { text: `${item.channel} · ${item.plannedAt ? new Date(item.plannedAt).toLocaleString() : "Unscheduled"} · ${item.reviewedRevision === item.revision ? "Reviewed" : "Draft"} · Revision ${item.revision}` }),
      el("p", { text: `Audience: ${item.audience}` }), el("p", { class: "copy", text: item.content }), el("div", {}, [editButton, review, remove])]));
  }
}
void refresh().catch(() => { status.textContent = "Unable to load campaigns. Use Refresh to retry."; });
const refreshButton = el("button", { type: "button", text: "Refresh" }); refreshButton.addEventListener("click", () => void run(async () => {})); root.append(refreshButton);
