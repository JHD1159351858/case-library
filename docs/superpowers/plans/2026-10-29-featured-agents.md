# Manual popular cases implementation plan

**Goal:** Administrators choose the cases occupying the existing popular TOP 1, TOP 2 and TOP 3 positions. Do not add a separate featured section or general sort-number field.

**Architecture:** Store three nullable case IDs in one persistent settings row, shared by SQLite and PostgreSQL implementations. Save the entire selection atomically. List queries prioritize selected cases before applying pagination, while retaining existing filters and the normal ordering for remaining cases.

## Contract

- `GET /api/featured-agents` is public and returns `{ configured, agentIds, items, updatedAt }`.
- `agentIds` always has three positions, each containing a case ID or null.
- Each returned item includes the normal case summary, `position` (1 through 3), and public `viewStats.viewCount`.
- `POST /api/featured-agents` requires an administrator and accepts `{ agentIds: [idOrNull, idOrNull, idOrNull] }`.
- Reject duplicates, invalid IDs, wrong lengths and missing cases before changing settings. Existing inactive cases remain selectable, matching the platform's existing visibility rules.
- Null cancels a position. Deleted cases are omitted from public results and returned as null positions.
- Before the first manual save, retain the existing automatic popularity behavior. After manual save, only selected positions are popular, including an explicitly empty selection.
- Store the JSON array in `featured_agent_settings`, with one row (`id = 1`) and an update timestamp. Both schemas create this table idempotently for old installations.
- Storage methods: `featuredAgentSettings()` and `saveFeaturedAgentSettings(agentIds, timestamp)`.

## Implementation and verification

- [x] Add both schemas and storage methods; test old SQLite migration, persistence and list ordering.
- [x] Add public-read/admin-write endpoints; test permissions, validation, empty positions and filters/pagination.
- [x] Add three selectors and a save action to the existing administration page.
- [x] Map the existing popular badges and effects to the configured positions; retain existing page structure.
- [x] Verify the selection and query results in an isolated browser fixture, including a laptop viewport.
- [x] Run focused tests and inspect the diff; publish only this feature's files to the existing GitHub main branch.

## Constraints

No npm dependencies, backend authentication changes, production-data writes from development tests, `.coze` edits or changes to unrelated preview directories. PostgreSQL production execution must be reported separately from local SQLite validation.

## Verification evidence

- Backend/API and SQLite storage tests: 62 passed, including persistence after reopening the database.
- Frontend tests: 70 passed, including manual ranks, empty positions, failed saves and retrying failed configuration reads without losing edits.
- Complete repository test run: 245 passed, zero failed.
- Real local HTTP/browser fixture: selected cases 8, 5 and 2 as TOP 1/2/3, reloaded the admin page, checked both result pages and searched for a non-selected case. All matched the intended behavior at a 1366 by 768 viewport without horizontal overflow.
- PostgreSQL schema and storage implementation updated; a live PostgreSQL service has not been exercised.
