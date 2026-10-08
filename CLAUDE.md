# Figma Booster — Figma plugin

A Figma plugin: a horizontal collapsible toolbar (section tools, dark-theme copies, art-task
sizing, translator, dev status, grid/component, Master-style component tools, custom JSON "Code"
buttons) plus an animated **Clawd** crab pet.

## Full reference
**Read [`docs/CLAUDE.md`](docs/CLAUDE.md) before changing the plugin** — architecture, message
protocol, toolbar/pet logic, code.ts features, the JSON-recipe system, and Figma-mockup notes.

## Essentials
- **Two files:** `src/code.ts` (plugin sandbox — has `figma`, no DOM/eval) and `ui.html`
  (iframe UI — has DOM, no `figma`). They talk only via `postMessage`.
- **Build:** `npm run build` (tsc → `dist/src/code.js`). `ui.html` is **not compiled** — verify it
  with `node --check` on its `<script>`. Build only after editing `code.ts`.
- **No `eval` in the plugin sandbox** → custom "Code" buttons run a JSON recipe (`{ops:[...]}`),
  not raw JS. See `runScript`/`applyScriptOp` in code.ts.
- **Persistence:** `clientStorage` keys `uiPos, lightTheme, toolOrder, customTools, removedTools,
  wfTheme, artTaskKey, masterTarget`. `reset-all` restores the default toolbar row —
  **Clawd · Wrap · Align · ←/→ · Find · Replace · Art · Comp · Translate** — and hides the rest
  (540px/Dev/Zero/Custom/Grid) in the Functions add-list. **Art** and **Comp** are *smart buttons*
  (`cmd:'__art'` / `'__comp'`) that open flyouts — Art▸ = Art-sizing / 1px / 2.67x (`ART_ACTIONS`);
  Comp▸ = Create / Comp+ / Pick / Attach / Swap all (`COMP_ACTIONS`). Both render via
  `renderActionMenu(actions)`; see docs/CLAUDE.md §4.

## Conventions
- **Don't use browser-preview tools** — the user verifies in Figma. (For UI logic you may simulate
  ui.html's script in Node with a mock `document`/`parent`.)
- **Commits:** author is Stepan only — never add an AI co-author.
- Clawd animations are MIT (clawd-tank) — keep `THIRD_PARTY_NOTICES.md` + the credit comment in `ui.html`.
- Figma mockups live on **Page 2** of the plugin's mockup file (component-based; see docs/CLAUDE.md §7).
