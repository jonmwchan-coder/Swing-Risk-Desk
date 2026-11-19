# v2.5 visual/interaction verification

Ran the original index.html, styles.css, app.js and library modules via an inline Playwright browser harness with synthetic option inputs (no real user data), width 320 / 390 / 768 / 1100 / 1440. All sizes showed the one selected-idea preview and a two-date matrix, with **no document horizontal overflow** and **no JavaScript page errors**. The compact matrix alone is horizontally scrollable on phones. Added TP and date interactions produced a new row and column and recalculated percentages without touching recorded positions. Model tests cover calendar-time decay, weekends/NYSE holiday date defaults, the expiry intrinsic payoff, price/IV input validation, fee-inclusive P/L, half-spread indicative assumptions and quote-midpoint anchoring. `npm test`: 105/105 passing.

Provider credentials were **not** available during these tests: success and error responses from the optional read-only Alpaca backend are tested with mocked market-data responses. No claim of a successful real Alpaca connection or authentic OPRA quote.

# Responsive and functional QA — Swing Risk Desk v1.2

## Screen sizes and layouts

The v1.1 base layout was checked in headless Chromium at widths **320, 360, 390, 430, 600, 690, 691, 768, 820, 1024, 1280, 1440px** for Dashboard, Positions, Trade History, Rules & Data. Its responsive styles are retained in v1.2: narrow phone cards at <=690px, tablet portrait from 691-979px, tablet landscape / desktop from 980px. The expanded trade-history ledger is scrollable within its own table on tablet/desktop and labelled row cards on phone. Import preview and broker-account mapping use the established modal layout.

**Important qualification:** Headless browser navigation for v1.2 was blocked by this current execution environment, so the new import and detail dialogs were **not** visually certified in a real browser or physical iPad/Android/Safari device. No claim is made that 12 viewport screenshots were taken for v1.2.

## Automated functional checks

`npm test` currently passes **22 tests**, including risk calculation, session counting, 0DTE gating, IBKR parsing, duplicate and repeated statement protection, exact execution matching, orphan-sell quarantine, partial exits, dated plan revision, full JSON backup merge, no private broker-account numbers in the public app, explicit account mapping, zero-equity unknown-account safety, archived-transaction reimport protection, and a minimal first-render DOM smoke test.

A separate live data reconciliation against the user's supplied Nov 13 IBKR CSV and original SMH starter generated `added=0, sourceLinked=2, duplicates=2, pending=0` on the first import; a second import with a different filename produced `added=0, duplicates=2`. No user data is included with the public deployable source package.

## Persistence limits

LocalStorage + secondary IndexedDB recovery copy are scoped to the same browser origin. Both may be lost together. A full JSON export saved outside the browser is currently the supported durable backup and ChatGPT handoff. Cross-device cloud synchronization requires future authenticated hosted storage; it has not been implemented.
