# Knowledge base and Context Library

Upload documents in **Knowledge & Context**, inside a private or public collection.
Text, Markdown, HTML, CSV, JSON and other supported text files are indexed when saved.
Uploaded PDF, DOCX, XLSX, ODT and ODS documents are converted with Workers AI `toMarkdown`; failed conversion rejects the
upload instead of reporting it as indexed. Files are limited to 1.8 MB, including storage
metadata, and extracted text to 1.8 MB. Existing binary documents need uploading again to extract text.
Images and unsupported binary formats (including DOC and PPTX) remain attachments; they are not indexed beyond their metadata.

The collection's SQLite FTS5 index stores overlapping passages. Agents call
`context.retrieve(query)` to obtain up to five passages (maximum ten), each with a
source `docId`, path and text offset, then use those passages to answer and cite the
source. `search()` discovers documents and `read()` reads their text, including document
extractions. Offsets identify extracted characters, not page numbers. Retrieval
uses keywords and BM25 ranking, without an embedding service or vector database.
Agents should try alternate terms when necessary and say when no source supports an answer.

Each index lives in the collection Durable Object. Private collections remain account
owned; public collections remain admin managed within the sharing domain. Retrieval
uses the existing observation authorization before returning content. Document updates,
moves and deletes update the index in the same transaction. Text already stored before
this feature is indexed on first use.

The gatekeeper needs its `AI` binding for document extraction. The binding is included in
`wrangler.jsonc` and customer release manifests. Local tests use SQLite in workerd;
Document extraction still requires a configured Workers AI connection in a real deployment.
