# SSO whitelist management implementation plan

**Goal:** Manage the authentication center's shared institution FIDs and return origins from the case-library administration page, limited to designated Chaoxing accounts.

**Architecture:** Keep both lists exclusively in the authentication center database. The case-library backend authenticates its current administrator, checks the designated UID list, and calls only the center's existing whitelist APIs using a separate server-only integration token. Do not reuse the SSO verification secret or forward browser cookies.

**Constraints:** No new dependencies or database schema changes in the case library, no edits to `.coze`, no production data/configuration access, and no changes to unrelated preview folders. The authentication-center checkout has no Git remote; provide its required changes as a deployable patch alongside the case-library release.

## Interfaces and access

- Both projects use `SSO_WHITELIST_ADMIN_TOKEN`, a separately generated secret of at least 32 characters. Missing/short tokens disable integration. Existing center administrator-cookie authentication remains supported.
- Tokens must be visible ASCII and cannot equal existing login/admin secrets. Center calls require HTTPS, except explicit local loopback development hosts. Actor UIDs use encodeURIComponent in the header and are decoded once at the center.
- The case library also uses `SSO_WHITELIST_ADMIN_UIDS` (comma-separated). A caller must be an existing case-library administrator AND have a matching SSO UID. Missing UIDs deny management; other case maintenance stays unchanged.
- Only the center's four whitelist route files accept integration tokens: FID collection/item and origin collection/action. Passwords, users, audit reading and all other administration routes retain their original authentication.
- The case-library backend sets `X-Case-Library-Actor` from the verified SSO UID; center audit logs identify the integration and operator.
- Case-library `GET /api/sso-whitelists` returns `{ fids: [{fid,name,enabled}], origins: [{origin,note,enabled}] }` with no secrets or private center session data.
- `POST /api/sso-whitelists` accepts `{kind:'fid'|'origin',action:'add'|'enable'|'disable'|'delete',fid|origin,name|note}`. Validate locally, reject cross-origin writes, restrict upstream paths, set a timeout, prohibit redirects and never replay a write automatically.
- Root errors: `sso_whitelist_forbidden` (403), `sso_whitelist_not_configured` (503), `sso_whitelist_invalid_input` (400), `sso_whitelist_center_unauthorized` (502), `sso_whitelist_center_unavailable` (502), and `sso_whitelist_center_timeout` (504). Preserve center 400/404/409 with sanitized user-facing validation errors.

## Tasks

- [x] Center: add a pure, independently testable integration-token checker with constant-time hash comparison; adapt whitelist routes through a dedicated auth helper, leaving all other APIs untouched. Check existing middleware for compatibility.
- [x] Case backend: add an isolated adapter and tests, wire two authenticated handlers/configuration fields into `server.mjs`; retain all existing SSO behavior.
- [x] Admin frontend: add an isolated module, stylesheet and collapsible panel, display current operator UID, add institutions/origins, toggle and delete with confirmation, refresh after writes, and clearly distinguish unavailable/forbidden/readback-failed states. Keep controls disabled before successful reads and during writes.
- [x] Verify permissions and HTTP contracts with fake center integration tests, token tests and UI tests; check secret non-disclosure and existing sign-in compatibility.
- [x] Provide both projects' configuration/deployment instructions and a center patch; validate the patch against its original checkout. Publish only this feature's case-library files to the existing GitHub main branch.

## Acceptance

Only designated administrator accounts can read or change lists. FIDs are numeric; origins are HTTP(S) origins without credentials, paths, queries or fragments. Missing configuration and upstream errors never appear as empty successful lists. Upstream writes have no automatic retry; failed readback prompts refresh to establish the actual result. Existing center audit logging/cache invalidation remain effective. The deployed center and real Chaoxing login are separate live-validation steps and must not be described as verified by mocks.

## Evidence

- Case-library complete Node test run: 286 passed.
- Center token tests: 5 passed; TypeScript and ESLint checks passed.
- Center patch applies cleanly to original files, and its standalone token tests pass after applying.
- Browser fixture uses the actual center token helper with in-memory institution/origin records and the real case-library backend/SQLite. Adding an institution, disabling it, adding an origin and confirming its deletion succeeded; all four audit actors were `case-library:fixture-owner`. Another administrator received no list data and could not use whitelist controls while ordinary case maintenance stayed available.
- No production login, whitelist writes, credentials or database connections were used.
