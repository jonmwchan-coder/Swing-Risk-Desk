## v1.8.1: naturally wrapping Thesis / Catalyst on desktop (2026-11-15)

- **Trade History → Thesis / Catalyst** now wraps its full text into multiple lines at all screen widths, including wide desktop layouts (previously desktops above 1100px forced a one-line horizontal scroller).
- Other table columns, the 1180px-wide app shell, compact mobile/tablet behavior, original trading precision and records are unchanged. This is a CSS-only data-safe display fix; no data schema, account calculation, cloud, or IBKR changes.
- Offline app-shell cache version updated so existing installations can pick up the styling.

## v1.8: concise history placeholders and readable small-screen notes (2026-11-15)

- Trade History now shows `----` for un-realized P/L on entries and `----` for the exit/reason column when no exit occurred. Financial records and calculations are unchanged.
- Long thesis, catalyst, target, invalidation, and exit notes wrap to as many lines as needed in trade-history cells at phone, tablet, and narrow-laptop widths (up to 1100px). Desktop above 1100px still allows optional horizontal scrolling inside long text cells. The page shell remains the same width as other views.
- Versioned offline cache refresh; no changes to Supabase schema, persisted trade data, IBKR import logic, or JSON handoff.

## v1.7: compact trade history (2026-11-14)

- Trade History uses the same centered 1180px app width as Dashboard, Positions, and Settings; no more 1900px-wide exception.
- The date uses a compact `MM/DD/YY` presentation (full date retained as a tooltip and machine-readable `datetime`); premium displays two decimal places (underlying raw values stay unchanged in all records and exports).
- Contract, TP, invalidation, thesis/catalyst and exit columns share their space more efficiently. Long TP, invalidation, thesis and exit text scrolls inside the cell, not across the entire page. On phones, all content wraps in the existing card layout. Smaller tablets may scroll inside the ledger itself.
- This is a display-only change. No existing portfolio history, cash calculations, stored fills, cloud sync, IBKR deduplication, or JSON backups are modified.

# Swing Risk Desk v1.6 (multi-entry sizing + private cloud journal)

## v1.6: Compact multi-entry size planning (November 2026)

The Dashboard's **Quick size check** starts with one idea. Click **+ Add idea** only when planning more simultaneous entries (up to 8). Each scratchpad row has an optional label such as `INTC 1/15/27 70C`, quantity, premium per share in USD, total entry fees in USD, and individual stress %. The bottom summary shows risk already available, **combined draft reserves** with each option rounded separately, and risk still available after all planned entries. The per-idea line shows its reserve and the running remainder. If the combined ideas breach the portfolio limit, it is clearly flagged; unpriced rows are shown as incomplete rather than assumed risk-free. Existing open reserves and realized rolling losses are already deducted from starting capacity. Strict mode reserves the entire entry debit. This is a **planning scratchpad, not a market order or logged trade**; its contents live only in browser-tab session storage, separated by portfolio, and do not enter Supabase, real account risk, JSON backup or IBKR history.

Use **Record** on a filled draft to open the normal New position form with the size prefilled. The optional `TICKER M/D/YY STRIKEC` / `STRIKEP` label is parsed into ticker, expiry, strike and type when clearly recognizable; confirm before recording. On successful submission only that draft is removed, so the actual live reserve replaces it rather than being counted twice. Cancelling keeps the draft. Other draft ideas remain and re-evaluate against updated available capacity.

Private, responsive options swing-trading risk desk for a **rolling NYSE-session loss budget in Canadian dollars**. A small Vercel-ready website with an optional authenticated Supabase cloud ledger; no IBKR account passwords or broker API access.

## Cloud synchronization: secure configuration is required

**Status: cloud-ready in source code, but NOT active merely because this package is deployed.** The site continues to work locally until a Supabase account, the per-user database, and Vercel environment variables are configured.

1. Create or connect a Supabase project you own (you can connect the Supabase app to ChatGPT to help with setup). Keep it private.
2. In **Supabase → SQL Editor**, execute `supabase/schema.sql`. This creates a private user-scoped ledger snapshot with atomic revision checks and row-level security. Enable email OTP/magic-link sign-in in Supabase Authentication and configure the deployed Swing Risk Desk origin as the **Site URL** and **Redirect URL**, e.g. `https://your-swing-risk-domain.vercel.app/**`.
3. In **Vercel → existing project → Settings → Environment Variables**, set `SUPABASE_URL` to your project URL and `SUPABASE_PUBLISHABLE_KEY` to the *public/publishable* key from Supabase (older projects call it the anon key). No database password or service-role key belongs in browser-accessible configuration, repository source, or chat.
4. Redeploy the existing Vercel project. In **Rules & data → Cloud synchronization**, enter your email, click the sign-in link, and approve the one-time local-history merge when prompted. The first sync prompts before uploading your local ledger; save a complete JSON backup before enabling it.
5. Verify the status **Cloud saved**, then test sign-in on another device and use **Sync now** to confirm its position, account and note counts. Do not assume sync is working just because you signed in.

**How data survives:** the browser still holds an offline copy. The Supabase row holds an authenticated, private server-side snapshot; all fills, account settings, original IBKR source rows, notes, plan revisions, archives and duplicate-review records are included. The database requires sign-in, and the server rejects stale writes. The client merges conflicting revisions using existing position/execution/note identities; it preserves disputed plan changes and original source evidence for manual review instead of discarding either. The JSON export remains the universal complete restore + ChatGPT handoff. Supabase project backups and an independent saved JSON copy are still recommended; no storage provider guarantees zero loss.

**Limits:** single-user cloud workspace per signed-in email; email links are subject to provider delivery; no live IBKR brokerage API and no automatic Google Sheets master commits. Internet is required for *cloud* sign-in and sync. When cloud status says offline/failed/unsynced, your data is **not** confirmed to be in cloud storage and you should export a complete backup. Service-worker shell supports offline app use but does not make cloud writes possible offline.

**GitHub / Vercel ownership:** the existing Vercel Drop project `swing-risk-desk-vercel-v1.1` is not yet Git-connected. To preserve the existing browser storage, connect a new, private Swing Risk Desk GitHub repository to the **existing** Vercel project, rather than creating an unrelated site/domain. Do not put the starter JSON, IBKR CSV, actual fills, or export backups in GitHub.


## v1.5: equity automatically follows realized profit and loss

- The risk limit is **risk percentage x tracked current equity**, not permanently based on the initial manual principal. Examples: CAD 18,000 at 3% = CAD 540; CAD 23,000 at 3% = CAD 690.
- **Tracked equity = most recent manually confirmed equity checkpoint + net realized CAD profit/loss recorded after that checkpoint.** Realized exits and signed outside-P/L adjustments count; unrealized option value, unconfirmed open P/L and open stress reserves do not change principal. The risk ceiling changes as recorded profits/losses change tracked equity, while rolling realized LOSSES remain charged gross and are never offset by profits.
- **Safe migration:** When opening older v1.4 data, the manually recorded account equity is treated as an existing broker-balance checkpoint. All realized P/L already logged at migration is pinned as included, rather than added again. The app will not silently reprice historic accounts.
- **Manual reconcile / deposits / withdrawals:** Settings shows the computed live equity. Change that figure to the broker realized-equity equivalent (excluding unrealized gains/losses on still-open options) and save to create a dated balance checkpoint, with prior checkpoints retained in the JSON/cloud record. Saving unrelated account rules does *not* reset the checkpoint. This is not a live broker balance feed: new trades must be imported, and actual CAD P/L/FX should be verified with IBKR.
- **Backfilled trades:** If a later import brings historical realized trades that had already been included in the broker account balance you manually entered, use the equity setting to re-checkpoint against the broker and avoid counting the result twice. Imported records are not deleted.

## What changed in v1.4

- **Desktop trade history uses the full available page width** at 1200px and above, with no horizontal table scroll; mobile keeps per-fill cards and tablets retain contained sideways scrolling where needed. Headers are shortened to `TP`, `Invalidation`, `P/L CAD`, etc. Numeric level columns are deliberately narrower.
- **Edit plan on every history row** now opens actual thesis, catalyst, entry trigger, management, TP and invalidation fields. Fixes an earlier editor omission that could clear existing thesis/catalyst when saving. All edited values preserve timestamped plan-change history; history shows the latest plan, not a reconstructed entry-time opinion.
- **Journal/plan timeline has a recoverable × button.** Removed notes and plan revisions are archived rather than erased from the complete JSON/cloud record. Restore them in Rules & data → Archived corrections. Cloud/backup merges honour removal and restoration markers instead of resurrecting stale copies. Removing a revision does not undo current risk settings.
- **IBKR reconciliation explicitly displays the destination portfolio.** New broker account mappings require a deliberate choice; existing mappings are shown. New purchases for an unambiguously open matching contract attach to the same position and do not reset the per-idea risk allowance. Same-day manual fills with unspecified times can link to their broker source if economics match and the timestamp correction preserves a valid execution sequence. Re-importing a broker statement remains duplicate-safe; ambiguous fills are held for review.
- The release keeps the same local-storage key, backup schema and authenticated Supabase snapshot table. No migrations or trading-master changes are required.

## What changed in v1.2

- **Trade history is now explicit:** TP targets *on the underlying*, underlying invalidation, current thesis/catalyst, and actual exit underlying/reason are separate columns. The prior "Underlying / Reason" column came from manually entered **exit price on the underlying** and a **reason selected at exit**; it did not pull from your idea/notes. Missing values are shown as "Not recorded". The displayed targets and invalidation are the **latest recorded plan**, not a fabricated plan at entry.
- **IBKR CSV import:** recognizes the supplied Flex-style trade export columns, parses OCC option contracts, splits genuine partial fills, matches accounts, and checks timestamps, premiums, quantities and commissions against existing positions. A confirmation preview displays new vs existing vs pending rows before applying changes. Uploading the same overlapping statement again does not duplicate recorded fills. When new broker accounts are discovered, they start with **zero** account equity until you supply a real balance.
- **No invented notes:** Broker exports do not contain a trading thesis, actual underlying prices, exit rationale, underlying invalidations, or TP targets. Add these yourself through **Edit plan**, **+ Journal note**, and **Exit details** (the latter is available on a SELL in Trade history).
- **Dated journal timeline:** journal notes are append-only. Editing a plan keeps a dated **before → after** record. New exit annotations also append an audit note. Imported alternatives and conflicts are kept rather than silently replacing what you wrote.
- **One complete JSON file:** **Download full backup / ChatGPT handoff** produces a portable `.json` containing all account rules, every fill and exit, IBKR source rows, full notes, plan changes, import logs, unreconciled rows, conflicts and archive. That **same file** can be imported with **Full restore** to reproduce all records and settings, or **Safely merge** to reconcile with newer local data without blind duplication. Previous v1 backups and journal JSON imports are supported.
- **Data safety:** browser `localStorage` continues to hold the working record; a secondary IndexedDB copy is written when supported to help recover from a single browser-store failure. A prominent **Backup needed** state appears when edits have not been exported. Deleting a position/fill/adjustment archives the original instead of permanently discarding it; archives are restorable in **Rules & data** and included in JSON backups.
- Responsive dashboard, tablet forms, and mobile history cards remain in place.

## Deploy to Vercel (no coding required)

If you already deployed v1.1:

1. Download the new ZIP and unpack it.
2. Replace the project files in the **existing GitHub repository** connected to your Vercel project. Do not change to a new project/domain if you want this device's browser storage to remain accessible.
3. Vercel normally redeploys automatically after the commit. Otherwise choose **Redeploy** in the Vercel dashboard.
4. Reopen the same web address. Existing local v1 records are migrated in memory and saved using the original storage key after your next edit. Download a fresh full JSON backup immediately.

If starting fresh, create a **new, preferably private GitHub repo**, upload the **contents** of this ZIP to its root, then import it under **Vercel → Add New → Project**. Framework is **Other**, with no build command. Do not upload private IBKR files or account backups to GitHub, including private repos: these are intended for import **inside the app**.

## Daily workflow

1. **After a fill:** Open **Rules & data → Import IBKR trades CSV**. Select the IBKR export. Review the modal for `New executions`, `Already logged`, `Existing fills linked`, and `Needs review`, then confirm. Choose the correct existing portfolio in the IBKR import preview; the app then remembers that broker-account mapping. You can also set or change it in **Rules & data → Portfolio settings**. The separately provided BDI starter contains the prior SMH fills but does not expose your private IBKR account ID in the public app source. A new account gets a separate portfolio with $0 equity until you enter its actual balance.
2. **Record the original thesis and plan:** Open **Positions → Edit plan**. Write your directional thesis, catalyst, entry trigger, structural invalidation on the *underlying*, TP targets, review date, and management plan. The plan revision is timestamped. Don't backdate later information as though it were known at entry.
3. **During the trade:** Choose **+ Journal note**. Select `Psychology`, `Management decision`, `Thesis update`, etc. and write your observation. Earlier notes remain intact. These notes are intended to be preserved as evidence when reviewing execution quality, not treated as a reconstructed premarket plan.
4. **When you sell:** Import the SELL from IBKR, then open **Trade history → Exit details** to state the actual TP/invalidation/other reason, underlying price at exit, and your reasoning. The app does not guess those from P/L or from what happened later.
5. **After a trading session:** Click **Download full backup / ChatGPT handoff** and move the JSON to **your private Google Drive folder**. Use versioned filenames/dates so an old backup cannot erase newer work. That's also the file to upload into ChatGPT.

## Using the same file with ChatGPT and for recovery

- **ChatGPT handoff:** Upload `swing-risk-desk-COMPLETE-YYYY-MM-DD.json`. The file includes account IDs, stable position IDs, broker provenance, dated notes, plan revisions and every economic transaction. When you explicitly say **"commit to master"**, the assistant must first read the live **DK Trading Review 2026 with ChatGPT Master → AI_Update_Protocol**, reconcile existing trade IDs and broker executions, preserve your journal and prospective plan context, and obey the project requirement to update the **trading master and NQ/SPX market master** in one workflow, with separate success/failure reporting. Merely uploading the backup does **not** authorize a master write.
- **Restore on another device:** Visit the app's URL, choose **Rules & data → Restore / merge JSON or CSV**, pick the **same complete JSON**, select **Full restore** for a new/empty browser, and confirm. The app downloads a pre-restore safety snapshot first. Full restore updates both history and settings. **Safely merge** is for a browser that has newer independent data: transactions and notes are merged, while conflicting account rules stay current and alternatives go into the review queue.
- **Before clearing browser storage, replacing a phone, changing the Vercel domain, or uninstalling the PWA:** export a full backup first. Local browser copies do **not** automatically sync across devices.

## Limits that matter

- **No guaranteed cloud persistence until configured and verified.** The site stores your data locally in that browser. `localStorage` and IndexedDB can **both** be removed when you clear site data, use a private browser session, lose the device, or the browser clears the origin. Vercel hosts the website code, not your portfolio records. **Do not make this app your only copy of the journal.** The simplest reliable routine without setting up authenticated cloud infrastructure is one-click full JSON backup saved to Google Drive after each update. A later authenticated cloud database/sync service would be needed for genuinely automatic cross-device persistence; no fake cloud-sync toggle is shown here.
- **IBKR data limitations:** The sample export has no execution ID, no trade idea, no underlying exit price, no confirmation of report timezone, and no CAD execution FX. Fills are identified by account/option/side/date/time/quantity/price/fees/NetCash, plus an occurrence index when printed rows are identical. Distinct fills that print **exactly identically** are fundamentally ambiguous: the importer flags this. Review them rather than relying on blind automation. If the same contract is traded in more than one independent idea, that grouping may also need manual reconciliation. Source rows that cannot be matched safely remain in the **unreconciled inbox**; they do not enter the budget or generate fabricated realized P/L.
- **Imported non-swing options:** This is a swing-budget ledger, not a complete IBKR tax statement. If you import a mixed options export, review the preview and archive non-swing trades so they don't consume the swing risk budget. The archived source data remains available for audit and backup.
- **FX:** The app can request a Bank of Canada reference FX rate from the optional Vercel `/api/fx` endpoint or accept a manually entered IBKR broker rate. The default 1.40 is *illustrative*. Calculated CAD P/L is an estimate unless overridden with the actual verified broker CAD net figure. Price, fees and original source fields remain preserved.
- **Risk:** The 70% stress reserve is not a guaranteed stop. Full option debit remains possible max loss. Rolling five trading sessions counts *gross realized losing exits*; profits do **not** offset those losses. Partial exits release the proportionate open reserve while retaining any realized loss until its date rolls out. Strict mode reserves full premium. Nothing sends orders to IBKR.
- **No master changes:** The app is not wired to edit your connected Google Sheet. Uploading an app backup to ChatGPT is the supported reconciliation handoff. No user data is automatically published to the hosting repository.

## Testing and internals

Run `npm test` in the source folder on Node 20+. The test suite uses **synthetic fictional examples only** and covers rolling-window math, IBKR source recognition, existing-fill matching, duplicate protection, an unmatched SELL inbox, partial exits, dated plan history, full-backup merges, and a minimal initial DOM-render smoke test. No private source CSV or starter positions ship in the ZIP.

Layout: `index.html`, `styles.css`, `app.js`; domain logic: `lib/risk.mjs`, `lib/calendar.mjs`, `lib/ibkr.mjs`, `lib/ledger.mjs`; optional FX endpoint: `api/fx.js`; PWA offline shell: `sw.js`; fixtures/tests: `tests/`. The PWA caches application code, **not** account records or uploaded CSV files.
