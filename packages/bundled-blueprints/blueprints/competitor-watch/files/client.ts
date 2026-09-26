import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import type { WatchSnapshot, WatchStub } from "./lib/protocol.ts";
declare const gadget: WatchStub;

const style = el("style", { text: `
:root{color-scheme:light dark;font:15px/1.5 system-ui;background:Canvas;color:CanvasText}
body{margin:0}main{max-width:1000px;margin:auto;padding:24px}header,p{margin-bottom:20px}
form,.sources,article{display:grid;gap:12px}form,article{border:1px solid GrayText;border-radius:12px;padding:18px;margin-bottom:16px}
label{display:grid;gap:5px}input,textarea,button{font:inherit;padding:8px}textarea{min-height:70px}
button{cursor:pointer}h1,h2,h3{margin:0}small{display:block}a{overflow-wrap:anywhere}
details{white-space:pre-wrap;overflow-wrap:anywhere}.sources{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
@media print{form,button,[role="status"]{display:none}main{max-width:none;padding:0}article{break-inside:avoid}:root{color-scheme:light}}
` });
document.head.append(style);
const root = el("main"); document.body.append(root);
const status = el("p", { role: "status", "aria-live": "polite" });
const sources = el("div", { class: "sources" });
const findings = el("section", { "aria-label": "Change history" });
const name = el("input", { required: true, maxlength: 160 });
const url = el("input", { type: "url", required: true, placeholder: "https://example.com/pricing" });
const notes = el("textarea", { maxlength: 1000, placeholder: "Pricing, product changes, positioning…" });
const submit = el("button", { type: "submit", text: "Add source" });
const form = el("form", {}, [el("label", {}, ["Competitor", name]), el("label", {}, ["Source URL", url]), el("label", {}, ["What to watch", notes]), submit]);
root.append(el("header", {}, [el("h1", { text: "Competitor Watch" }), el("p", { text: "Track sources and keep dated evidence of what changed. Ask your agent to check the watchlist; recurring checks need a configured schedule." })]), form, status, sources, el("h2", { text: "Recent findings" }), findings);

let busy = false;
async function run(action: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  busy = true; submit.disabled = true;
  try { await action(); await refresh(); status.textContent = "Saved."; }
  catch (error) { status.textContent = error instanceof Error ? error.message : "Unable to save."; }
  finally { busy = false; submit.disabled = false; }
}
form.addEventListener("submit", event => {
  event.preventDefault();
  void run(async () => { await gadget.addCompetitor({ name: name.value, url: url.value, notes: notes.value }); form.reset(); });
});
function render(state: WatchSnapshot): void {
  sources.replaceChildren(); findings.replaceChildren();
  if (!state.competitors.length) sources.append(el("p", { text: "No sources yet. Add a competitor's public page to start." }));
  for (const item of state.competitors) {
    const remove = el("button", { type: "button", text: "Remove source and findings" });
    remove.addEventListener("click", () => void run(() => gadget.removeCompetitor(item.id)));
    sources.append(el("article", {}, [el("h2", { text: item.name }),
      el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer", text: item.url }),
      el("p", { text: item.notes }), el("small", { text: item.lastChecked ? `Last checked ${new Date(item.lastChecked).toLocaleString()}` : "Not checked yet" }), remove]));
  }
  if (!state.findings.length) findings.append(el("p", { text: "No recorded snapshots. Ask the agent to check your sources and save a baseline." }));
  for (const item of [...state.findings].reverse()) {
    findings.append(el("article", {}, [el("h3", { text: state.competitors.find(entry => entry.id === item.competitorId)?.name ?? "Source" }),
      el("small", { text: new Date(item.observedAt).toLocaleString() }), el("p", { text: item.summary }),
      el("a", { href: item.sourceUrl, target: "_blank", rel: "noopener noreferrer", text: "View source" }),
      el("details", {}, [el("summary", { text: "Saved excerpt" }), item.content])]));
  }
}
async function refresh(): Promise<void> { render(await gadget.getWatchlist()); }
void refresh().catch(() => { status.textContent = "Unable to load watchlist. Use Refresh to retry."; });
const refreshButton = el("button", { type: "button", text: "Refresh" });
refreshButton.addEventListener("click", () => void run(async () => {})); root.append(refreshButton);
