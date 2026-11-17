# Case drag order implementation plan

**Goal:** Drag existing records in the administration table to persist the public catalog list order.

**Confirmed behavior:** Dragging changes only list order. Existing popular TOP 1–3 settings and badges remain separately controlled. Drop saves automatically. Hidden records keep their positions for later restoration; new records follow saved records. With no saved order, existing featured/update sorting remains unchanged.

**Architecture:** One single-row order setting in the current database stores an ordered array of case IDs. Both storage implementations join this order before filtering/pagination. An admin-only same-origin endpoint saves order; the existing list endpoint supplies the sorted results and a `manualOrder` flag. The administration table uses native drag events and no dependency.

**Tech stack:** Existing Node 24, vanilla HTML/CSS/ES modules, SQLite/PostgreSQL stores.

## Constraints

- No new packages, no `.coze` edits, no real credentials/production database access.
- Reuse the current checkout; preserve unrelated untracked preview directories.
- Do not change case fields, timestamps, visibility, or popular slot settings when reordering.
- Saving failure preserves a usable table and prompts refresh when the result cannot be confirmed.
- This request authorizes implementation; GitHub publication/deployment remains a separate user action.

## Storage

- [x] Add idempotent `agent_order_settings` tables to both schema files.
- [x] Add same-shape `agentOrderSettings()` and `saveAgentOrderSettings(agentIds, timestamp)` to both stores. Default: `{agentIds: [], updatedAt: null}`.
- [x] Put saved IDs before unlisted records, in array order, with existing ordering for unlisted records.
- [x] Test SQLite persistence, upgrades, filtered pages, hidden/new/deleted records, and a fake-client PG contract without claiming live PG verification.

## HTTP API

- [x] `POST /api/agent-order` accepts exactly `{agentIds: string[]}`; requires admin session, JSON, same-origin, unique known IDs and the existing body-size cap.
- [x] Save once and return `{agentIds, updatedAt}`; no write retry.
- [x] Add `manualOrder` to `GET /api/agents`, preserving all current fields.
- [x] Test permissions, invalid writes, list/filter/page/visibility behavior, and independent TOP slots.

## Administration and catalog UI

- [x] Add a grip column and clear auto-save notice to the existing table.
- [x] Drop before/after a row, disable further ordering during save, and recover on failure.
- [x] Load all admin list pages so dragging reflects the complete fetched catalog.
- [x] Show manual-order copy in the public catalog only when the server confirms a saved order.
- [x] Test actual drag event handlers, up/down movement, no-op drops, repeat-save prevention, failures and complete list loading.

## Final verification and handoff

- [x] Run related Node tests and diff checks once after integration; broaden only if failures or new risks require it.
- [x] Document persistence/API/usage and update the Obsidian project and daily notes.
- [x] Report implemented local behavior, verification evidence and deployment limits accurately.

## Evidence

- Final complete Node run: 303 tests passed, 0 failed. Local runtime: Node 22.21.1; deployment still follows the project's Node 24 requirement.
- SQLite upgrade, reopen persistence and real HTTP API tests passed; PostgreSQL verification used a fake query client, not a live server.
- Browser test with disposable SQLite/admin data: vertical drag along the grip column moved C before A; successful save and reload retained C/A/B, with popular TOP1 still A. Public list readback had C/A on its first two-item page, `manualOrder: true`.
- The grip-column drop interception found during browser testing was covered by a failing test, fixed, and reverified; the final full test run includes the fix.
- Temporary fixture processes/tabs/cookies cleaned up; screenshot at `utils/verify/shots/agent-order/drag-order.jpg`. No live SSO, production data/config changes, GitHub push or deployment.
