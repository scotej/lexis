# Word bank PDF and related ordering

Export every live bank entry, in full, as a downloadable A4 PDF on web and desktop.
Use white pages, dark body text, muted blue headwords, embedded Unicode fonts,
flowing pagination, page numbers, and an export date/order/count. Include all
senses, parts of speech, examples, synonyms and their stored attributes,
pronunciation, attribution and source URLs, added date, practice/essay totals,
review schedule/history, and any additional stored entry fields. Exclude app
credentials, deleted entries and unrelated application settings. Export is a
snapshot and never changes bank records. Empty banks cannot export.
Bundle a broad Unicode fallback for foreign-script examples. Characters outside
the font/renderer coverage retain their explicit Unicode value instead of being
silently removed.

Reuse the existing ten bank orders; add word length and last-practised orders.
The export dialog defaults to the current bank order and permits any order.

Related ordering uses OpenRouter's embeddings endpoint with the user's saved
key and existing privacy routing. Use openai/text-embedding-3-small, independently
of the selected chat model. Send only headwords, dictionary senses and synonyms,
in bounded batches. Validate every returned index and vector. Compare normalized
vectors globally, extending a path with the nearest remaining word. This is a
semantic similarity heuristic, not a claim of an optimal path or synonymy.
All entries occur exactly once, across batch boundaries. No bank-size truncation.
Yield during local sorting; support cancellation and visible progress/errors.

Reuse the order in memory for unchanged dictionary content. Changes to bank
membership/meanings invalidate it. Never issue requests during ordinary render;
refreshing AI order is an explicit action. Stale asynchronous results cannot
replace a newer bank/selection/session. Preload PDF assets at startup; ordinary
exports work offline once those assets have loaded. Assets need no CDN. Use
native desktop save dialog and browser download.

Verify meaningful core behavior and integration, parse generated PDF text and
pagination, inspect a rendered sample, and run the full existing test suite.
