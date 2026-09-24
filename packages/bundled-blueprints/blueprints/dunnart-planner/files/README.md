# Dunnart Planner

One gadget, two connected views. Board columns are To do, In progress, and Done; month calendar shows task due dates and all-day events. Tasks and events live in this gadget's Durable Object, scoped to the workspace that owns it. The agent can call `getTasks`, `createTask`, `updateTask`, `deleteTask`, `createEvent`, `updateEvent`, and `deleteEvent` on the gadget capability. Dates are local calendar dates (`YYYY-MM-DD`), not instants.

Runs in the Cloudflare Workers gadget runtime without external service dependencies.
