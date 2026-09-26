# Optional apps and semantic recall

## Create an app

Ask the Workshop agent to create a **Competitor Watch** or **Campaign Board** from the available formats. Both are bundled blueprints, instantiated only when chosen. An admin can remove either from the offered formats. Existing workspaces acquire no new external connections or scheduled jobs automatically.

Competitor Watch stores source URLs, focus notes, timestamps and the latest 12 findings. The agent can use its existing web-fetch tool to collect a relevant excerpt and record it. Unchanged content updates last-checked time without making a duplicate finding, even after the old finding leaves the bounded history. Connect Scheduled Tasks and wire a callback for recurring monitoring. Fetch failures must remain failures; a stored snapshot is not a live crawl.

Campaign Board stores social, email and SMS drafts, audience descriptions, planned dates and editorial review markers. Changing a draft invalidates its review, and revision checks protect simultaneous edits. The date list is a planning calendar. It does not claim provider scheduling or delivery. Sending requires a separately connected MCP/API provider and its normal action approval. Provider credentials, consent/suppression records, actual contact lists, delivery webhooks and idempotent sends belong in that connector/provider.

## Workspace memory

Normal user conversations now recall related completed exchanges before the agent researches a question. The first recall imports one recent completed exchange from each of up to 12 recent chats. Future completed answers are indexed automatically. Recall is scoped to the workspace Durable Object; it never searches other workspaces or users' personal accounts. Workspace collaborators who can already see those chats share the same history. Spawned agents neither contribute nor receive this workspace memory, preserving their configured capability scope.

Workers AI `@cf/baai/bge-base-en-v1.5` supplies 768-dimensional embeddings. Exact repeated questions avoid a query embedding call. Paraphrases use cosine similarity; at most four relevant answers are provided with source chat, sequence and date. A repeated identical question updates its previous answer only if the new source is newer. Different questions retain independent records, so similarity cannot silently overwrite distinct facts. Newer corrections take precedence in the recall guidance.

Memory is evidence of a previous conversation, not proof that an answer was correct or that a new action completed. Recalled text is explicitly untrusted data. The agent must still check changing facts, conflicting evidence and requests to refresh, and must retain normal action approvals. It should use previous task outcomes to avoid duplicate work and verify current state before performing a repeat action. This is retrieval-based learning; it does not retrain model weights.

Storage is bounded to 256 answers per workspace and 90 days. Answers over 6,000 characters or questions over 2,000 are not copied. Records older than seven days are marked for refresh. Chat deletion/reversion removes derived memory; every recall also checks the original transcript to exclude stale or deleted sources, including changes during embedding calls. Deleting a source chat is the user-facing way to forget its derived memory. Memory failure falls back to normal chat and logs only a fixed event, never message contents. Set backend `SEMANTIC_MEMORY_ENABLED=false` to disable indexing/recall; `WORKERS_AI` is required to enable it.

## Knowledge retrieval

`CONTEXT.retrieve` combines full-text matches and semantic passage matches through rank fusion. Vectors stay in each collection's existing SQLite Durable Object, behind the existing collection permissions and observation authorization. Replacing, moving or deleting a document clears its old vectors. Upgrading the passage index preserves PDF/office text already extracted.

The Context Library `AI` binding computes embeddings in batches of 32. Uploads start background indexing; reads resume interrupted work. The newest 4,096 passages per collection participate in semantic search; full-text search still covers the complete collection. Cold or partially indexed collections can return keyword results while background indexing completes. Repeated query embeddings are cached in memory for five minutes (up to 32 queries). Without AI, or on AI errors, full-text retrieval remains available. English is the embedding model's primary language.

No vector database, provider subscription, social account or campaign sending service is created by these templates. Embedding calls use the deployment's Workers AI billing account.
