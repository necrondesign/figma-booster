# Figma Booster — Architecture & Logic (agent guide)

Authoritative reference for the **Figma Booster** Figma plugin. Read this before changing
`src/code.ts` or `ui.html`. Reflects the current state of the code.

**The audit (Find / Fix / Radius / Clean) has its own document: [`AUDIT.md`](AUDIT.md).**
Read it before touching `auditNode`, `collectFindings`, `requestAuditComments`,
`runAuditFix`, or the `postComments` / `cleanComments` / `spellCheck` blocks in `ui.html`.
It holds the rules, the thresholds, the comment protocol, and — importantly — the reasons
behind the deliberate differences from the source checklist. Those reasons are not
recoverable from the code.

---

## 1. Build & workflow

- **Two source files only:**
  - `src/code.ts` — plugin sandbox (the "main thread"). Compiled by `tsc`.
  - `ui.html` — the UI iframe. **Not compiled** — `manifest.json` references it directly.
- **Build:** `npm run build` (= `tsc`, target ES2017, strict) → `dist/src/code.js`.
  - After editing **code.ts** → run `npm run build`.
  - After editing **ui.html** → **no build**; verify the script block with
    `node --check` (extract `/<script>([\s\S]*?)<\/script>/`). It is plain browser JS.
- **manifest.json:** `main: dist/src/code.js`, `ui: ui.html`, `networkAccess` allows
  `translate.googleapis.com` (used by the translator).
- **Verifying:** the user (Stepan) checks in Figma himself. **Do NOT use browser-preview
  tools** unless asked. For UI logic you can simulate `ui.html`'s script in Node with a
  mock `document`/`parent` (see how prior sessions tested `composeTools`/pet logic).
- **Commits:** never add an AI co-author — author is Stepan only.

---

## 2. Two-context architecture (critical)

| | `src/code.ts` (sandbox) | `ui.html` (iframe) |
|---|---|---|
| Has | `figma` API, clientStorage | DOM, `fetch`, `eval` |
| Lacks | DOM, `eval`, `Function`, `fetch` to most hosts | the `figma` API |
| Role | mutate the document, persist state | render toolbar/panels, user input |

They communicate **only** via messages:
- UI → plugin: `parent.postMessage({ pluginMessage: { type, ... } }, '*')` (UI helper `post(type, extra)`).
- plugin → UI: `figma.ui.postMessage({ type, ... })`, received in `window.onmessage`.

**Consequence:** you cannot run arbitrary user JS in the plugin (no `eval`). The "Code"
custom button therefore uses a **JSON recipe** interpreted by a whitelist (see §6).

---

## 3. Message protocol

**UI → plugin** (handled in `figma.ui.onmessage` switch in code.ts):
- Tools: `wrap-selection` / `wrap-selection-light`, `fix-selection` / `fix-selection-light`,
  `align-sections`, `frame-540`, `expand-section` / `expand-section-left`, `find-similar`,
  `replace-instance`, `frame-border`, `create-art-block`, `toggle-dev-status`, `move-to-zero`.
- Layout helpers: `grid-layout`, `make-component`, `custom-absolute`, `slice-267`.
- Master-style component tools: `create-component-from-objects`, `pick-target`, `attach-to-target`,
  `bulk-swap-to-target` (see §5).
- Custom buttons: `custom-fn` `{fn, script}` (only `fn:"__script"` is used now → runs the recipe).
- Translation: `run-translation` `{target}` → plugin replies `start-api-call`; UI fetches Google
  Translate, sends back `apply-data` `{results}`.
- State get/save: `get-order`/`save-order`, `get-theme`/`save-theme`, `get-custom`/`save-custom`,
  `get-removed`/`save-removed`, `get-wf`/`save-wf`, `set-pos`, `reset-all`. (`pick-target` persists
  the chosen target in `clientStorage` key `masterTarget`; `reset-all` clears it.)
- Window: `resize` `{width,height}` (robust: missing dim keeps previous, clamps ≥1), `notify`.

**plugin → UI** (`window.onmessage`): `status` (button flash), `selection-info`
(`{count,hasSection,hasFrames,allDark,hasAny,textCount}` → drives enable rules),
`order`, `theme`, `custom`, `removed`, `wf`, `pos`, `start-api-call`.

---

## 4. `ui.html` — toolbar & UI logic

### Tool model
- `TOOLS` (const) = built-in tool defs, in render order: `wrap`(primary, with dark-theme checkbox),
  `align`, `540`, `expand`(group of two chevron minis), `find`, `replace`, `art`(label **"Art"**,
  `cmd:'__art'` — **smart button**, opens the art-actions flyout), `dev`, `zero`, `component`(label
  **"Comp"**, `cmd:'__comp'` — **smart button**, opens the component-actions flyout), `custom`,
  `greed`(label **"Grid"**, cmd `grid-layout`), `translate`(`__translate`→language picker, placed
  last so it renders after the smart buttons), and `settings`(`settingsBtn`).
- `COMP_ACTIONS` / `ART_ACTIONS` (const) = flyout sub-actions revealed by the smart **Comp** / **Art**
  buttons — **not** standalone toolbar tools.
  - COMP_ACTIONS: `Create`(`make-component`), `Comp+`(`create-component-from-objects`),
    `Pick`(`pick-target`), `Attach`(`attach-to-target`), `Swap all`(`bulk-swap-to-target`).
  - ART_ACTIONS: `Art`(`create-art-block`), `1px`(`frame-border`), `2.67x`(`slice-267`).
  - Both rendered by `renderActionMenu(actions)` (see Panels); each carries a `rule` so `applyEnable()`
    greys it live vs the selection.
- **Default toolbar (after reset):** Clawd · Wrap · Align · ←/→ · Find · Replace · Art · Comp ·
  Translate. Everything else starts hidden (see `DEFAULT_HIDDEN` below). The Art/export ops live inside
  Art's flyout; the 4 Master ops live inside Comp's flyout.
- `composeTools()` returns the render list: **Clawd pet (id `claude`) first** →
  built-ins + custom tools (ordered by `savedOrder`) → `settings` last.
- State (module-level lets, persisted in clientStorage):
  - `customTools` — `[{id, name, icon, fn:'__script', script}]` (user "Code" buttons).
  - `removedIds` — hidden built-in ids; **seeded with `DEFAULT_HIDDEN = ['540','dev','zero','custom',
    'greed']`** so those tools are hidden by default and live in the Functions add-list. Reset
    re-seeds it. (To change the default row, edit this list — a built-in tool is visible-by-default
    iff its id is *not* in it. `art` and `component` are visible = the smart Art / Comp buttons;
    `1px`/`x267`/the 4 Master ops aren't in TOOLS at all — they live only inside the flyouts.)
  - `savedOrder` — persisted tool order (settings & pet excluded).
- `buildToolbar()` iterates `composeTools()`, skips `removedIds`, renders each tool;
  `applyEnable()` toggles `disabled` per `RULES[dataset.rule]` against `selInfo`.

### Collapse / expand
- `body.open` toggled by the ▸ arrow. Collapsed shows the first 3 reorderable tools (`shown<3`)
  + arrow; expanded shows all. Width is dynamic via `fitSize()`.

### Reorder (edit) mode
- `toggleEdit()` → `body.edit`; tools wiggle, become drag-handles (`makeDraggable` + pointer
  events + `#drop-line`). Each shows a **✕ delete badge** (`addDeleteX`→`deleteTool`):
  deleting a built-in adds it to `removedIds`; deleting a custom removes it from `customTools`.
  The gear becomes a ✓ to save+exit. Pet is excluded from reorder (not draggable).

### Panels (replace `#bar`; each "back" returns to **Settings**)
- **Settings** (`openSettings`): position picker (5 zones) + `Functions` · `Theme` · `Reorder` ·
  `FAQ` · `Reset` + Back(✕). Width hugs content.
- **Functions** (`openCreate`, title "Functions"): top = **"Add back removed"** chips (re-add hidden
  built-ins) ; **"Code (JSON)"** button → reveals **Name + Script(JSON)** fields. Select a chip OR
  fill Code, then **"Add function"** (footer). Code buttons get `icon:'code'`, `fn:'__script'`.
  `sizePanel()` fits the window to content (consistent 16px padding).
- **FAQ** (`openFaq`): header + scrollable list (scrollbars hidden) + description.
- **Reset dialog** (`openResetDialog`): compact prompt + Yes/No.
- **Translate** (`renderLangs`): replaces toolbar with 9 language flags + Cancel.
- **Smart-button flyouts** (`renderActionMenu(actions)`, triggered by the `art`→`__art` and
  `component`→`__comp` cmds in `onTool`): replaces the toolbar with the given actions list
  (`ART_ACTIONS` or `COMP_ACTIONS`) + a ✕ back. Reuses the compact `lang` marker class; **stays open**
  after an action (so you can chain e.g. Pick → Attach / Swap all) — ✕ calls `buildToolbar()` to
  return. Buttons carry `data-rule`, so `applyEnable()` keeps them in sync with the live selection
  (e.g. Pick/Swap all disable unless exactly one node is selected).

### Window sizing
- `fitSize()` measures `#bar` and posts `resize {width, height}` (skips if bar hidden).
- Panels post their own size (FAQ 560×420 fixed; Settings/Reset/Functions hug content).
- code.ts `resize` handler keeps the previous dimension when one is omitted (never `undefined`).

### Persistence keys (clientStorage)
`uiPos`, `lightTheme`, `toolOrder`, `customTools`, `removedTools`, `wfTheme`, `artTaskKey`,
`masterTarget` (the Pick target: `{id, key, name}`).
**Reset** (`reset-all`) deletes the first six + `masterTarget` and posts defaults back to the UI
(`removed` → re-seeds DEFAULT_HIDDEN; `wf` → true).

### Clawd pet (the crab) 🦀
- First toolbar block; not draggable; deletable via ✕ (→ appears in Functions add-list as "Clawd").
- 14 animation **`<template>`s** in `ui.html` (authentic Clawd SVGs, CSS keyframes inside;
  viewBox normalized to `-8 -11 31 30`). Shown one at a time via `clawdShow(tplId)`.
- Registries + triggers:
  - `CLAWD_IDLE` (idle-living/sleeping/wake) — random rotation every ~9–14s (`petIdleLoop`).
  - `CLAWD_REACT` (working-typing/building/builder/wizard) — random on **any tool click** (`petReact`, hooked in `onTool`/`onWrapFix`).
  - `CLAWD_PET` (eureka/notification/dizzy) — random on **tapping the crab** (`petPlay`).
  - `CLAWD_EXPAND` = crab-walking (marches right, ×2 fast, ~1s) on **expand**; `CLAWD_COLLAPSE` = going-away on **collapse** (`petGesture`).
  - `CLAWD_SETTINGS` = working-overheated, shown on **return from Settings** (panel hides the crab while open).
- **Licensing:** animations adapted from `github.com/marciogranzotto/clawd-tank` (MIT). See
  `THIRD_PARTY_NOTICES.md`. "Clawd" is Anthropic's mascot — MIT doesn't grant brand rights;
  not affiliated with Anthropic. Keep the credit comment in `ui.html` `<head>`.

---

## 5. `src/code.ts` — features (each operates on the current selection)

- `wrapToNewSelection(withDark)` — Wrap: align selected frames into a Section (+ dark copies if a
  Dark variable mode exists); `fixSelection(withDark)` — re-align an existing Section.
  `findDarkMode()` finds a "Dark" variable mode (used by both).
- `alignSections()` — lay sections in a row. `frame540()` — wrap in 540px auto-layout.
- `expandSectionGrow(dir)` — duplicate a frame / grow a section (row-aware).
- `replaceWithInstance()` — replace selection with a copy of the reference (last-added). `lastAddedId`
  tracked in `trackLastAdded` on `selectionchange`.
- `findSimilar()` — select same-name/size nodes. `frameWithBorder()` — 1px slicing frame.
- `createArtBlock()` — ArtTask sizing (×3) + green arrow; `findArtTaskComponent` / `findIconTags` / `findTextNodes`.
- `toggleDevStatus()` — Ready-for-Dev. move-to-zero — `(0,0)`.
- **Layout and component helpers:**
  `gridLayout()`, `makeComponents()`, `customIgnoreAutoLayout()`, `scaleSelection267()` (slice ×2.67).
- **Master-style component tools** — reimplemented from the *documented behaviour* of the paid
  "Master" plugin (dominate.design); no proprietary code was used, features aren't copyrightable.
  Single-file only (cross-file "move between files" isn't possible in the sandbox and was skipped).
  - `createComponentFromObjects()` (**Comp+**) — builds one master from the first selection via
    `buildMasterFrom()` (frames convert in place → structure preserved; other nodes get wrapped,
    `wrapped=true`), parks it left of the selection, then replaces every selected object with an
    instance, copying overrides via `copyOverridesTree()`.
  - `pickTarget()` (**Pick**) — stores the selected component / instance's main component in
    `clientStorage.masterTarget` `{id, key, name}`. `resolveTarget()` resolves it back (local `id`
    first, then `importComponentByKeyAsync(key)`; COMPONENT_SET → `defaultVariant`).
  - `attachToTarget()` (**Attach**) — selected instances → `swapComponent(target)`; frames/groups →
    a fresh `target.createInstance()` + `copyOverridesTree()`, original removed.
  - `bulkSwapToTarget()` (**Swap all**) — `figma.root.findAllWithCriteria({types:['INSTANCE']})`,
    match by source `mainComponent.id` (a COMPONENT_SET matches all its variant ids), `swapComponent`
    each to the picked target. File-wide.
  - `copyOverridesTree(src,dst)` — parallel index-walk of two subtrees (needs matching layer order &
    hierarchy). Copies **only when changed** (so token-bound paints round-trip and no no-op overrides
    are recorded): text `characters` (loads fonts first), `fills`/`strokes` (JSON round-trip keeps
    `boundVariables`), `visible`, and nested-instance `swapComponent`. Depth-capped at 60.
    Non-dynamic-page plugin → uses sync `.mainComponent`.
- Translator: `run-translation` collects TEXT nodes → UI fetches Google Translate → `apply-data`
  loads fonts and writes translations.
- `sendStatus(text,status)` — notify + flash the clicked toolbar button.

---

## 6. Custom "Code" buttons — JSON recipe (no eval)

A Code button stores `script = { ops: [...] }`. `runScript()` runs each op on every selected node
via `applyScriptOp()` (whitelist — **safe, no eval**). Ops:
`move{dx,dy}` · `pos{x,y}` · `resize{w,h}` · `opacity{value}` · `rotate{deg}` · `corner{value}` ·
`fill{color,opacity}` · `stroke{color,weight}` · `visible{value}` · `lock{value}` ·
`rename{name}` (tokens `{w} {h} {i} {name}`) · `text{value}`.
To add an op: extend `applyScriptOp` (and the `SCRIPT_HINT` string in ui.html).

---

## 7. Figma mockups (the plugin's mockup file, Page 2)

Component-based, built via the Figma `use_figma` MCP tool. See memory `project_figma_mockups`.
- Section **"Booster Components"**: `icon/*` (26 outline icon components) + `btn/*` (button components,
  each containing an icon instance) + `btn/clawd`/`btn/expand`/`btn/arrow`.
- Board **"Figma Booster — UI"** (dark) + **"Figma Booster — UI · Light"**: 9 state tiles each,
  assembled from `btn/*` instances. Variable collection **"Figma Booster Tokens"** (Dark/Light modes).
- **Gotchas:** wrap `use_figma` code in try/catch + `let out=null` (strict mode rejects undeclared
  assignment); `createNodeFromSvg` returns a FRAME with a default fill → clear the wrapper's fill,
  keep only strokes for outline icons; pass full `<path d="...">`, never raw path data; nodes that
  visually overlap a SECTION get auto-adopted into it; `clone()` can land on the wrong page — set
  `figma.currentPage`/`appendChild` to the intended page.

---

## 8. Conventions

- Match surrounding code style (compact, vanilla). ui.html uses CSS variables + `body.light` for theme.
- Icon set is the `IC` map in ui.html (`S(d)` builds an 18×18 outline SVG). New icon → add to `IC`.
- Keep this doc and `THIRD_PARTY_NOTICES.md` current when adding features/assets.
- **This file + the root `CLAUDE.md` are the source of truth** for the plugin.
