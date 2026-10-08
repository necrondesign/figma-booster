// Figma Booster — Figma Plugin

const H_GAP = 80;
const V_GAP = 160;
const SECTION_PADDING = 100;

// ─── Helpers ─────────────────────────────────────────────────────

// Тосты бывают трёх видов, и ведут себя они по-разному:
//   • настоящий сбой (sticky) — красный, висит с крестиком, пока человек не закроет:
//     там причина, которую надо прочитать, а не поймать краем глаза;
//   • подсказка «так нельзя» — красная, но гаснет сама: «Select objects» читается за миг;
//   • сведения и итоги — обычные, гаснут сами.
const TOAST_TIME = 5000;
function sendStatus(text: string, status: "success" | "error" | "", working?: boolean, sticky?: boolean) {
  // working — это «ещё в работе»: по такому тосту индикатор на кнопке не гаснет.
  figma.ui.postMessage({ type: "status", text, status, working: !!working });
  if (!text) return;
  const opts: NotificationOptions = { timeout: sticky ? Infinity : TOAST_TIME };
  if (status === "error") opts.error = true;
  figma.notify(text, opts);
}

async function findDarkMode(): Promise<{ collection: VariableCollection; modeId: string } | null> {
  // 1. Try local collections
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  for (const collection of collections) {
    const darkMode = collection.modes.find(
      (m) => m.name.toLowerCase() === "dark"
    );
    if (darkMode) {
      return { collection, modeId: darkMode.modeId };
    }
  }

  // 2. Not found locally — scan bound variables in selection for library collections
  const checkedIds = new Set(collections.map((c) => c.id));
  const queue: SceneNode[] = [...figma.currentPage.selection];
  let checked = 0;

  while (queue.length > 0 && checked < 50) {
    const node = queue.shift()!;
    checked++;

    if ("boundVariables" in node) {
      const bv = node.boundVariables as Record<string, any> | undefined;
      if (bv) {
        for (const val of Object.values(bv)) {
          const bindings = Array.isArray(val) ? val : val ? [val] : [];
          for (const b of bindings) {
            if (!b?.id) continue;
            try {
              const v = await figma.variables.getVariableByIdAsync(b.id);
              if (!v || checkedIds.has(v.variableCollectionId)) continue;
              checkedIds.add(v.variableCollectionId);
              const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
              if (col) {
                const dark = col.modes.find((m) => m.name.toLowerCase() === "dark");
                if (dark) return { collection: col, modeId: dark.modeId };
              }
            } catch (_e) {}
          }
        }
      }
    }

    if ("children" in node) {
      for (const child of (node as ChildrenMixin & SceneNode).children) {
        queue.push(child as SceneNode);
      }
    }
  }

  return null;
}

async function findVariable(name: string): Promise<Variable | null> {
  // Get ALL local variables (no type filter)
  const allVars = await figma.variables.getLocalVariablesAsync();

  const search = (vars: Array<{ name: string }>) => {
    const exact = vars.find((v) => v.name === name);
    if (exact) return exact;
    const byEnd = vars.find((v) => v.name.endsWith("/" + name));
    if (byEnd) return byEnd;
    const partial = vars.find((v) => v.name.toLowerCase().includes(name.toLowerCase()));
    return partial ?? null;
  };

  const found = search(allVars);
  if (found) return found as Variable;

  // Not found locally — search in library collections
  try {
    const libCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (const libCol of libCollections) {
      const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(libCol.key);
      const match = search(libVars);
      if (match) {
        return await figma.variables.importVariableByKeyAsync((match as LibraryVariable).key);
      }
    }
    figma.notify(`⚠ "${name}" not found (${allVars.length} local, ${libCollections.length} libs)`, { timeout: 5000 });
  } catch (e) {
    figma.notify(`⚠ Library search error: ${e}`, { timeout: 5000 });
  }

  return null;
}

type Orientation = "horizontal" | "vertical";

// Detect whether frames are laid out as a row or a column from their current positions
function detectOrientation(frames: ReadonlyArray<SceneNode>): Orientation {
  if (frames.length < 2) return "horizontal";
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const f of frames) {
    const cx = f.x + f.width / 2;
    const cy = f.y + f.height / 2;
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
  }
  return (maxY - minY) > (maxX - minX) ? "vertical" : "horizontal";
}

// Place a dark copy next to its light frame: below if row, to the right if column
function placeDarkCopy(dark: SceneNode, light: SceneNode, orientation: Orientation): void {
  if (orientation === "horizontal") {
    dark.x = light.x;
    dark.y = light.y + light.height + V_GAP;
  } else {
    dark.x = light.x + light.width + H_GAP;
    dark.y = light.y;
  }
}

// ─── Feature 2: Wrap to New Selection ────────────────────────────

async function wrapToNewSelection(withDark: boolean = true): Promise<void> {
  const selection = [...figma.currentPage.selection];

  if (selection.length === 0) {
    sendStatus("Select frames", "error");
    return;
  }

  // Block if selection contains Sections
  if (selection.some((n) => n.type === "SECTION")) {
    sendStatus("Use Fix Selection for sections", "error");
    return;
  }

  // Block if all selected frames are dark copies
  const allDark = selection.every((n) => n.name.endsWith(" — Dark"));
  if (allDark) {
    sendStatus("Select light frames only", "error");
    return;
  }

  // --- Separate light originals from existing dark copies ---
  const allNames = new Set(selection.map((n) => n.name));
  const lightFrames: SceneNode[] = [];
  const existingDarkFrames: SceneNode[] = [];

  for (const node of selection) {
    if (node.name.endsWith(" — Dark") && allNames.has(node.name.replace(/ — Dark$/, ""))) {
      existingDarkFrames.push(node);
    } else {
      lightFrames.push(node);
    }
  }

  if (lightFrames.length === 0) {
    sendStatus("No light frames", "error");
    return;
  }

  // --- Step 1: Align light frames, keeping their existing orientation ---
  const orientation = detectOrientation(lightFrames);

  let baseX = Infinity, baseY = Infinity;
  for (const f of lightFrames) {
    if (f.x < baseX) baseX = f.x;
    if (f.y < baseY) baseY = f.y;
  }

  if (orientation === "horizontal") {
    lightFrames.sort((a, b) => a.x - b.x);
    let nextX = baseX;
    for (const frame of lightFrames) {
      frame.x = nextX;
      frame.y = baseY;
      nextX = nextX + frame.width + H_GAP;
    }
  } else {
    lightFrames.sort((a, b) => a.y - b.y);
    let nextY = baseY;
    for (const frame of lightFrames) {
      frame.x = baseX;
      frame.y = nextY;
      nextY = nextY + frame.height + V_GAP;
    }
  }

  // --- Step 2: Try dark theme (skip if not available or not requested) ---
  const dark = withDark ? await findDarkMode() : null;
  let allDarkFrames: SceneNode[] = [];

  if (dark) {
    // Re-position existing dark copies
    const existingDarkByLightName = new Map<string, SceneNode>();
    for (const df of existingDarkFrames) {
      const lightName = df.name.replace(/ — Dark$/, "");
      existingDarkByLightName.set(lightName, df);
    }

    for (const lightFrame of lightFrames) {
      const darkFrame = existingDarkByLightName.get(lightFrame.name);
      if (darkFrame) {
        placeDarkCopy(darkFrame, lightFrame, orientation);
      }
    }

    // Create missing dark copies
    const newDarkFrames: SceneNode[] = [];
    for (const frame of lightFrames) {
      if (existingDarkByLightName.has(frame.name)) continue;
      if (!("clone" in frame)) continue;

      const clone = (frame as FrameNode).clone();
      placeDarkCopy(clone, frame, orientation);
      clone.setExplicitVariableModeForCollection(dark.collection, dark.modeId);
      clone.name = frame.name + " — Dark";
      newDarkFrames.push(clone);
    }

    allDarkFrames = [...existingDarkFrames, ...newDarkFrames];
  }

  const allFrames = [...lightFrames, ...allDarkFrames];

  // --- Step 4: Calculate bounding box of all frames (absolute coords) ---
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of allFrames) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }

  const contentW = maxX - minX;
  const contentH = maxY - minY;

  // --- Step 5: Create Section and move frames inside ---
  const section = figma.createSection();
  section.name = "Section";
  section.x = minX - SECTION_PADDING;
  section.y = minY - SECTION_PADDING;
  section.resizeWithoutConstraints(
    contentW + SECTION_PADDING * 2,
    contentH + SECTION_PADDING * 2
  );

  // Apply fill token
  const fillVar = await findVariable("default_system_frame");
  if (fillVar) {
    try {
      const baseFill: SolidPaint = { type: "SOLID", color: { r: 1, g: 1, b: 1 } };
      const boundFill = figma.variables.setBoundVariableForPaint(baseFill, "color", fillVar);
      section.fills = [boundFill];
    } catch (_e) {
      figma.notify("⚠ Could not bind fill variable to section", { timeout: 3000 });
    }
  } else {
    figma.notify("⚠ Variable \"default_system_frame\" not found", { timeout: 3000 });
  }

  // Move all frames into the section
  for (const node of allFrames) {
    const oldX = node.x;
    const oldY = node.y;
    section.appendChild(node);
    node.x = oldX - minX + SECTION_PADDING;
    node.y = oldY - minY + SECTION_PADDING;
  }

  figma.currentPage.selection = [section];
  figma.viewport.scrollAndZoomIntoView([section]);

  const darkMsg = allDarkFrames.length > 0 ? ` + ${allDarkFrames.length} dark` : "";
  sendStatus(`Wrapped ${lightFrames.length}${darkMsg}`, "success");
}

// ─── Shared helpers: text & icon-tag finders (used by Create Art Block) ──

function findTextNodes(node: SceneNode): TextNode[] {
  const texts: TextNode[] = [];
  if (node.type === "TEXT") {
    texts.push(node);
  }
  if ("children" in node) {
    for (const child of (node as ChildrenMixin & SceneNode).children) {
      texts.push(...findTextNodes(child as SceneNode));
    }
  }
  return texts;
}

function findIconTags(node: SceneNode): SceneNode[] {
  const tags: SceneNode[] = [];
  if (node.name === "IconTag") {
    tags.push(node);
  }
  if ("children" in node) {
    for (const child of (node as ChildrenMixin & SceneNode).children) {
      tags.push(...findIconTags(child as SceneNode));
    }
  }
  return tags;
}

// ─── Feature 4: Align Sections ───────────────────────────────────

const SECTION_GAP = 400;

async function alignSections(): Promise<void> {
  const selection = [...figma.currentPage.selection];

  // Use selected sections, or all sections on page
  let sections: SectionNode[] = [];

  if (selection.length > 0) {
    sections = selection.filter((n) => n.type === "SECTION") as SectionNode[];
  }

  const usedSelection = sections.length > 0;

  if (sections.length === 0) {
    // Find all sections on the current page
    for (const child of figma.currentPage.children) {
      if (child.type === "SECTION") {
        sections.push(child);
      }
    }
  }

  if (sections.length === 0) {
    sendStatus("No sections found", "error");
    return;
  }

  // Sort by current x position to preserve order
  sections.sort((a, b) => a.x - b.x);

  // Selection → start from the leftmost selected section; nothing selected → from (0, 0)
  const baseX = usedSelection ? sections[0].x : 0;
  const baseY = usedSelection ? sections[0].y : 0;

  let nextX = baseX;
  for (let i = 0; i < sections.length; i++) {
    sections[i].x = nextX;
    sections[i].y = baseY;
    nextX += sections[i].width + SECTION_GAP;
  }

  figma.currentPage.selection = sections;
  figma.viewport.scrollAndZoomIntoView(sections);
  sendStatus(`${sections.length} sections aligned`, "success");
}

// ─── Feature: Toggle Ready for Dev ──────────────────────────────

async function toggleDevStatus(): Promise<void> {
  const selection = [...figma.currentPage.selection];

  let targets: SceneNode[] = [];

  if (selection.length > 0) {
    // Use selected nodes that support devStatus
    targets = selection.filter((n) => "devStatus" in n);
  } else {
    // No selection — collect all top-level frames/sections on the page
    for (const child of figma.currentPage.children) {
      if ("devStatus" in child) targets.push(child);
    }
  }

  if (targets.length === 0) return;

  // Determine direction: if ANY target is not ready → set all to ready, otherwise clear all
  const allReady = targets.every(
    (n) => (n as FrameNode).devStatus?.type === "READY_FOR_DEV"
  );

  for (const node of targets) {
    (node as FrameNode).devStatus = allReady
      ? null
      : { type: "READY_FOR_DEV" };
  }
}

// ─── Feature 5: Expand Section (ported, row-aware, both directions) ──

const SECTION_EXPAND_BARE = 620; // empty expand for a bare section (540 + 80)

const FRAMEISH = new Set(["FRAME", "COMPONENT", "INSTANCE"]);

// Shift sections that sit on the same row and to the right of `fromX`
function shiftRowSectionsRight(section: SectionNode, fromX: number, by: number): void {
  for (const s of figma.currentPage.children) {
    if (s.type !== "SECTION" || s.id === section.id) continue;
    const sec = s as SectionNode;
    if (
      sec.x >= fromX &&
      sec.y < section.y + section.height &&
      sec.y + sec.height > section.y
    ) {
      sec.x += by;
    }
  }
}

async function expandSectionGrow(direction: "left" | "right", duplicate: boolean = true): Promise<void> {
  const selection = [...figma.currentPage.selection];

  if (selection.length !== 1) {
    sendStatus("Select 1 section or frame", "error");
    return;
  }

  const node = selection[0];

  // Frame inside a section → duplicate and shift neighbors
  if (FRAMEISH.has(node.type)) {
    const frame = node as FrameNode;
    const parent = frame.parent;

    // Standalone frame (not in a section) → simple copy to the side
    if (!parent || parent.type !== "SECTION") {
      if (!parent || !("appendChild" in parent) || !("clone" in frame)) {
        sendStatus("Can't copy this", "error");
        return;
      }
      const clone = frame.clone();
      clone.y = frame.y;
      clone.x = direction === "right"
        ? frame.x + frame.width + H_GAP
        : frame.x - frame.width - H_GAP;
      (parent as ChildrenMixin).appendChild(clone);
      figma.currentPage.selection = [clone];
      figma.viewport.scrollAndZoomIntoView([clone]);
      return;
    }

    const section = parent as SectionNode;
    const expandBy = frame.width + H_GAP;
    const originalRight = section.x + section.width;
    const originalFrameX = frame.x;
    const originalFrameY = frame.y;

    section.resizeWithoutConstraints(section.width + expandBy, section.height);

    for (const c of section.children) {
      if (!FRAMEISH.has(c.type)) continue;
      if (direction === "right") {
        if (c.id !== frame.id && c.x > originalFrameX) c.x += expandBy;
      } else {
        if (c.x >= originalFrameX) c.x += expandBy; // includes the frame itself
      }
    }

    if (duplicate) {
      const clone = frame.clone();
      clone.x = direction === "right" ? originalFrameX + frame.width + H_GAP : originalFrameX;
      clone.y = originalFrameY;
      section.appendChild(clone);
      figma.currentPage.selection = [clone];
    } else {
      figma.currentPage.selection = [section];
    }

    shiftRowSectionsRight(section, originalRight, expandBy);
    return;
  }

  // Bare section → grow by a fixed amount
  if (node.type !== "SECTION") {
    sendStatus("Select 1 section or frame", "error");
    return;
  }

  const section = node as SectionNode;
  const originalRight = section.x + section.width;

  section.resizeWithoutConstraints(section.width + SECTION_EXPAND_BARE, section.height);

  if (direction === "left") {
    for (const child of section.children) child.x += SECTION_EXPAND_BARE;
  }

  shiftRowSectionsRight(section, originalRight, SECTION_EXPAND_BARE);
}

// ─── Feature: Replace with Instance (ported) ─────────────────────

async function replaceWithInstance(): Promise<void> {
  const selection = [...figma.currentPage.selection];

  if (selection.length < 2) {
    sendStatus("Select objects + reference last", "error");
    return;
  }

  // Reference = last node added to selection, fallback to last in array
  const source =
    (lastAddedId && selection.find((n) => n.id === lastAddedId)) ||
    selection[selection.length - 1];

  if (!("clone" in source)) {
    sendStatus("Reference can't be cloned", "error");
    return;
  }

  const targets = selection.filter((n) => n.id !== source.id);
  let count = 0;

  for (const target of targets) {
    const parent = target.parent;
    if (!parent || !("insertChild" in parent)) continue;

    const x = target.x;
    const y = target.y;
    const w = target.width;
    const h = target.height;
    const constraints = "constraints" in target ? (target as FrameNode).constraints : null;
    const index = (parent as ChildrenMixin).children.indexOf(target as SceneNode);

    const clone = (source as FrameNode).clone();
    (parent as ChildrenMixin).insertChild(index, clone);
    clone.x = x;
    clone.y = y;
    if ("resize" in clone) {
      try {
        clone.resize(w, h);
      } catch (_e) {}
    }
    if (constraints && "constraints" in clone) clone.constraints = constraints;

    target.remove();
    count++;
  }

  sendStatus(`Replaced ${count}`, "success");
}

// ─── Feature: Find Similar (ported) ──────────────────────────────

async function findSimilar(): Promise<void> {
  const selection = [...figma.currentPage.selection];

  if (selection.length !== 1) {
    sendStatus("Select 1 object", "error");
    return;
  }

  const target = selection[0];
  const name = target.name;
  const w = Math.round(target.width);
  const h = Math.round(target.height);

  const candidates = figma.currentPage.findAllWithCriteria({ types: [target.type] } as any) as SceneNode[];
  const matches = candidates.filter(
    (n) => n.name === name && Math.round(n.width) === w && Math.round(n.height) === h
  );

  if (matches.length <= 1) {
    sendStatus("No similar found", "error");
    return;
  }

  figma.currentPage.selection = matches;
  figma.viewport.scrollAndZoomIntoView(matches);
  sendStatus(`Found ${matches.length} similar`, "success");
}

// ─── Feature 6: Fix Selection ────────────────────────────────────

async function fixSelection(withDark: boolean = true): Promise<void> {
  const selection = [...figma.currentPage.selection];
  const section = selection.find((n) => n.type === "SECTION") as SectionNode | undefined;

  if (!section) {
    sendStatus("Select a section", "error");
    return;
  }

  const dark = withDark ? await findDarkMode() : null;

  // Collect light frames (skip sections and dark copies)
  const lightFrames: SceneNode[] = [];
  for (const child of section.children) {
    if (child.type === "SECTION") continue;
    if (child.name.endsWith(" — Dark")) continue;
    lightFrames.push(child);
  }

  if (lightFrames.length === 0) {
    sendStatus("No light frames", "error");
    return;
  }

  // Remove all existing dark copies
  for (const child of [...section.children]) {
    if (child.name.endsWith(" — Dark")) {
      child.remove();
    }
  }

  // Align light frames inside section, keeping their existing orientation
  const orientation = detectOrientation(lightFrames);
  if (orientation === "horizontal") {
    lightFrames.sort((a, b) => a.x - b.x);
    let nextX = SECTION_PADDING;
    for (const frame of lightFrames) {
      frame.x = nextX;
      frame.y = SECTION_PADDING;
      nextX = nextX + frame.width + H_GAP;
    }
  } else {
    lightFrames.sort((a, b) => a.y - b.y);
    let nextY = SECTION_PADDING;
    for (const frame of lightFrames) {
      frame.x = SECTION_PADDING;
      frame.y = nextY;
      nextY = nextY + frame.height + V_GAP;
    }
  }

  // Create dark copies if dark mode is available
  const clones: SceneNode[] = [];
  if (dark) {
    for (const frame of lightFrames) {
      if (!("clone" in frame)) continue;
      const clone = (frame as FrameNode).clone();
      section.appendChild(clone);
      placeDarkCopy(clone, frame, orientation);
      clone.setExplicitVariableModeForCollection(dark.collection, dark.modeId);
      clone.name = frame.name + " — Dark";
      clones.push(clone);
    }
  }

  // Resize section to fit content
  let maxX = 0, maxY = 0;
  for (const child of section.children) {
    if (child.type === "SECTION") continue;
    const right = child.x + child.width;
    const bottom = child.y + child.height;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }
  section.resizeWithoutConstraints(
    maxX + SECTION_PADDING,
    maxY + SECTION_PADDING
  );

  figma.currentPage.selection = [section];
  figma.viewport.scrollAndZoomIntoView([section]);
  const darkMsg = clones.length > 0 ? ` + ${clones.length} dark` : "";
  sendStatus(`Fixed ${lightFrames.length}${darkMsg}`, "success");
}

// ─── Feature 7: Create Art Block ─────────────────────────────────

const ART_BLOCK_GAP = 240;

let cachedArtTask: ComponentNode | null = null;

async function findArtTaskComponent(): Promise<ComponentNode | null> {
  if (cachedArtTask && !cachedArtTask.removed) return cachedArtTask;

  // Try saved key first — instant import
  const savedKey = await figma.clientStorage.getAsync("artTaskKey");
  if (savedKey) {
    try {
      cachedArtTask = await figma.importComponentByKeyAsync(savedKey);
      return cachedArtTask;
    } catch (_e) {
      await figma.clientStorage.deleteAsync("artTaskKey");
    }
  }

  // Fallback: search current page
  const candidates = figma.currentPage.findAllWithCriteria({ types: ["COMPONENT", "INSTANCE"] });
  for (const node of candidates) {
    const name = node.name.toLowerCase().replace(/\s+/g, "");
    if (!name.includes("arttask")) continue;
    if (node.type === "COMPONENT") {
      cachedArtTask = node;
      await figma.clientStorage.setAsync("artTaskKey", node.key);
      return node;
    }
    if (node.type === "INSTANCE") {
      const main = (node as InstanceNode).mainComponent;
      if (main) {
        cachedArtTask = main;
        await figma.clientStorage.setAsync("artTaskKey", main.key);
        return main;
      }
    }
  }
  return null;
}

async function fillArtTask(node: SceneNode, sizeText: string, size3xText: string): Promise<void> {
  const iconTags = findIconTags(node);
  if (iconTags.length < 3) return;

  const tag1Texts = findTextNodes(iconTags[1]);
  const tag2Texts = findTextNodes(iconTags[2]);
  const allTexts = [...tag1Texts, ...tag2Texts];

  for (const textNode of allTexts) {
    const fontName = textNode.fontName;
    if (fontName !== figma.mixed) {
      await figma.loadFontAsync(fontName);
    }
  }

  if (tag1Texts.length > 0) tag1Texts[0].characters = sizeText;
  if (tag2Texts.length > 0) tag2Texts[tag2Texts.length - 1].characters = size3xText;
}

async function createArtBlock(): Promise<void> {
  const selection = [...figma.currentPage.selection];

  if (selection.length !== 2) {
    sendStatus("Select 1 object + 1 ArtTask", "error");
    return;
  }

  // Separate ArtTask from target
  let artTask: SceneNode | null = null;
  let target: SceneNode | null = null;

  for (const node of selection) {
    const iconTags = findIconTags(node);
    if (iconTags.length >= 2) {
      artTask = node;
    } else {
      target = node;
    }
  }

  if (!artTask || !target) {
    sendStatus("Select 1 object + 1 ArtTask", "error");
    return;
  }

  // Calculate sizes
  const w = Math.round(target.width);
  const h = Math.round(target.height);
  const sizeText = `${w}x${h}px`;

  const ART_GROUPS: [number, number][] = [
    [160, 160],
    [320, 320],
    [540, 800],
  ];
  const ceilEven = (n: number) => Math.ceil(n / 2) * 2;

  let group = ART_GROUPS[ART_GROUPS.length - 1];
  for (const g of ART_GROUPS) {
    if (w <= g[0] && h <= g[1]) { group = g; break; }
  }
  const scale = Math.min(group[0] / w, group[1] / h);
  const artW = ceilEven(w * scale);
  const artH = ceilEven(h * scale);
  const size3xText = `${artW * 3}x${artH * 3}px`;

  // Fill ArtTask with size data
  await fillArtTask(artTask, sizeText, size3xText);

  // Create green elbow arrow from ArtTask to target
  const artBB = artTask.absoluteBoundingBox;
  const targetBB = target.absoluteBoundingBox;
  if (artBB && targetBB) {
    const arrow = figma.createVector();
    arrow.name = "ArtTask Arrow";

    const targetCenterY = targetBB.y + targetBB.height / 2;
    const gap = 20;
    const goingDown = targetCenterY > artBB.y + artBB.height / 2;

    // Start from bottom or top edge of ArtTask (center X), outside the block
    const startX = artBB.x + artBB.width / 2;
    const startY = goingDown
      ? artBB.y + artBB.height + gap
      : artBB.y - gap;

    // End at target edge closest to ArtTask, with gap
    const artCenterX = artBB.x + artBB.width / 2;
    const targetCenterX = targetBB.x + targetBB.width / 2;
    const endX = artCenterX < targetCenterX
      ? targetBB.x - gap
      : targetBB.x + targetBB.width + gap;
    const endY = targetCenterY;

    // All points for bounding box
    const allX = [startX, endX];
    const allY = [startY, endY];
    const minX = Math.min(...allX);
    const minY = Math.min(...allY);
    const maxX = Math.max(...allX);
    const maxY = Math.max(...allY);

    arrow.x = minX;
    arrow.y = minY;
    arrow.resize(Math.max(maxX - minX, 1), Math.max(maxY - minY, 1));

    // Local coordinates
    const lsx = startX - minX, lsy = startY - minY;
    const lex = endX - minX, ley = endY - minY;

    // #30CB44
    const green = { r: 48 / 255, g: 203 / 255, b: 68 / 255 };

    // Elbow: vertical from ArtTask edge → horizontal to target (1 corner)
    arrow.vectorNetwork = {
      vertices: [
        { x: lsx, y: lsy, strokeCap: "NONE", cornerRadius: 0 },
        { x: lsx, y: ley, strokeCap: "NONE", cornerRadius: 16 },
        { x: lex, y: ley, strokeCap: "ARROW_EQUILATERAL", cornerRadius: 0 },
      ],
      segments: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
      regions: [],
    };

    arrow.strokes = [{ type: "SOLID", color: green }];
    arrow.strokeWeight = 4;
    arrow.fills = [];
  }

  figma.currentPage.selection = [artTask];
  sendStatus(`${sizeText} → x3 → ${size3xText}`, "success");
}

// ─── Feature 8: Frame with Border ────────────────────────────────

async function frameWithBorder(): Promise<void> {
  const selection = [...figma.currentPage.selection];

  if (selection.length === 0) {
    sendStatus("Select objects", "error");
    return;
  }

  const wrappers: SceneNode[] = [];

  for (const node of selection) {
    const parent = node.parent;
    if (!parent || !("appendChild" in parent)) continue;

    const bb = node.absoluteBoundingBox;
    if (!bb) continue;

    // Node's transform origin (absolute)
    const originAbsX = node.absoluteTransform[0][2];
    const originAbsY = node.absoluteTransform[1][2];

    // Parent's absolute position
    const parentAbsX = "absoluteTransform" in parent ? (parent as SceneNode).absoluteTransform[0][2] : 0;
    const parentAbsY = "absoluteTransform" in parent ? (parent as SceneNode).absoluteTransform[1][2] : 0;

    const wrapper = figma.createFrame();
    wrapper.name = node.name;
    wrapper.resize(bb.width + 2, bb.height + 2);
    // Position wrapper so it covers bounding box + 1px padding
    wrapper.x = bb.x - 1 - parentAbsX;
    wrapper.y = bb.y - 1 - parentAbsY;
    wrapper.clipsContent = false;
    wrapper.fills = [];
    wrapper.strokes = [];

    // Insert wrapper where node is, then move node inside
    const idx = (parent as ChildrenMixin).children.indexOf(node as SceneNode);
    (parent as ChildrenMixin).insertChild(idx, wrapper);
    wrapper.appendChild(node);

    // Position node's origin relative to wrapper
    node.x = originAbsX - (bb.x - 1);
    node.y = originAbsY - (bb.y - 1);

    wrappers.push(wrapper);
  }

  figma.currentPage.selection = wrappers;
  sendStatus(`${wrappers.length} framed`, "success");
}

// ─── Feature 9: Wrap in 540px Auto Layout ────────────────────────

const FRAME_FIXED_WIDTH = 540;

async function frame540(): Promise<void> {
  const selection = [...figma.currentPage.selection];

  if (selection.length === 0) {
    sendStatus("Select objects", "error");
    return;
  }

  const wrappers: SceneNode[] = [];

  for (const node of selection) {
    const parent = node.parent;
    if (!parent || !("appendChild" in parent)) continue;

    const nodeX = node.x;
    const nodeY = node.y;
    const childH = node.height;

    // Fixed width 540, height rounded up to the 8px grid
    const targetH = Math.ceil(childH / 8) * 8;

    // Auto-layout frame, centered, padding 0
    const wrapper = figma.createFrame();
    wrapper.name = node.name;
    wrapper.layoutMode = "VERTICAL";
    wrapper.paddingTop = 0;
    wrapper.paddingBottom = 0;
    wrapper.paddingLeft = 16;
    wrapper.paddingRight = 16;
    wrapper.itemSpacing = 0;
    wrapper.primaryAxisAlignItems = "CENTER";
    wrapper.counterAxisAlignItems = "CENTER";
    wrapper.clipsContent = false;
    wrapper.fills = [];
    wrapper.strokes = [];

    // Insert wrapper where node is, then move node inside
    const idx = (parent as ChildrenMixin).children.indexOf(node as SceneNode);
    (parent as ChildrenMixin).insertChild(idx, wrapper);
    wrapper.appendChild(node);

    // Stretch object to fill width (minus side padding); keep its own height
    if ("layoutAlign" in node) (node as SceneNode & { layoutAlign: string }).layoutAlign = "STRETCH";
    if ("layoutGrow" in node) (node as SceneNode & { layoutGrow: number }).layoutGrow = 0;

    // Fixed width 540 and fixed height on the 8px grid
    wrapper.counterAxisSizingMode = "FIXED";
    wrapper.primaryAxisSizingMode = "FIXED";
    wrapper.resizeWithoutConstraints(FRAME_FIXED_WIDTH, targetH);
    wrapper.x = nodeX;
    wrapper.y = nodeY;

    wrappers.push(wrapper);
  }

  figma.currentPage.selection = wrappers;
  sendStatus(`${wrappers.length} framed 540px`, "success");
}

// ─── Layout and component helpers ──────────────────────────────

// ⭐ Custom — pull layers out of auto-layout (absolute) and raise to top
async function customIgnoreAutoLayout(): Promise<void> {
  const selection = [...figma.currentPage.selection];
  if (selection.length === 0) { sendStatus("Select layers", "error"); return; }
  let count = 0;
  for (const node of selection) {
    const parent = node.parent;
    if (!parent || !("insertChild" in parent)) continue;
    if ("layoutPositioning" in node) (node as any).layoutPositioning = "ABSOLUTE";
    (parent as ChildrenMixin).insertChild((parent as ChildrenMixin).children.length, node);
    count++;
  }
  sendStatus(`${count} → top (absolute)`, "success");
}

// 🔲 Grid — arrange selection (or a section's children) into a grid, grouped by size
async function gridLayout(): Promise<void> {
  const GRID_GAP = 48, GROUP_GAP = 80, SECTION_PADDING = 100;
  const selection = [...figma.currentPage.selection];
  const sectionMode = selection.length === 1 && selection[0].type === "SECTION";
  const nodes: any[] = sectionMode ? [...(selection[0] as SectionNode).children] : selection;
  const section = sectionMode ? (selection[0] as SectionNode) : null;
  if (nodes.length < 2) { sendStatus("Select 2+ objects or a section", "error"); return; }

  const getPos = (n: any) => sectionMode ? { x: n.x, y: n.y } : { x: n.absoluteBoundingBox.x, y: n.absoluteBoundingBox.y };
  const minH = Math.min(...nodes.map((n) => Math.round(n.height)));
  const rowTolerance = Math.max(20, minH * 0.4);
  nodes.sort((a, b) => {
    const pa = getPos(a), pb = getPos(b);
    if (Math.abs(pa.y - pb.y) > rowTolerance) return pa.y - pb.y;
    return pa.x - pb.x;
  });

  const groupMap = new Map<string, any[]>();
  for (const node of nodes) {
    const key = `${Math.round(node.width)}x${Math.round(node.height)}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(node);
  }
  const sortedGroups = [...groupMap.values()].sort(
    (a, b) => Math.round(a[0].width) * Math.round(a[0].height) - Math.round(b[0].width) * Math.round(b[0].height)
  );

  if (sectionMode && section) {
    let currentGroupY = SECTION_PADDING;
    for (const group of sortedGroups) {
      const nodeW = Math.round(group[0].width), nodeH = Math.round(group[0].height);
      const cols = Math.ceil(Math.sqrt(group.length));
      group.forEach((node, i) => {
        node.x = SECTION_PADDING + (i % cols) * (nodeW + GRID_GAP);
        node.y = currentGroupY + Math.floor(i / cols) * (nodeH + GRID_GAP);
      });
      const rows = Math.ceil(group.length / cols);
      currentGroupY += rows * nodeH + (rows - 1) * GRID_GAP + GROUP_GAP;
    }
    let maxX = 0, maxY = 0;
    for (const node of nodes) { maxX = Math.max(maxX, node.x + node.width); maxY = Math.max(maxY, node.y + node.height); }
    section.resizeWithoutConstraints(maxX + SECTION_PADDING, maxY + SECTION_PADDING);
  } else {
    let startX = Infinity, startY = Infinity;
    for (const node of nodes) { const bb = node.absoluteBoundingBox; if (!bb) continue; if (bb.x < startX) startX = bb.x; if (bb.y < startY) startY = bb.y; }
    let currentGroupY = startY;
    for (const group of sortedGroups) {
      const nodeW = Math.round(group[0].width), nodeH = Math.round(group[0].height);
      const cols = Math.ceil(Math.sqrt(group.length));
      group.forEach((node, i) => {
        const targetAbsX = startX + (i % cols) * (nodeW + GRID_GAP);
        const targetAbsY = currentGroupY + Math.floor(i / cols) * (nodeH + GRID_GAP);
        const bb = node.absoluteBoundingBox; if (!bb) return;
        node.x += targetAbsX - bb.x;
        node.y += targetAbsY - bb.y;
      });
      const rows = Math.ceil(group.length / cols);
      currentGroupY += rows * nodeH + (rows - 1) * GRID_GAP + GROUP_GAP;
    }
  }
  sendStatus(`Grid: ${nodes.length} in ${sortedGroups.length} group(s)`, "success");
}

// 🔷 Component — wrap each selected object into a master component, preserving properties
async function makeComponents(): Promise<void> {
  const selection = [...figma.currentPage.selection];
  if (selection.length === 0) { sendStatus("Select objects", "error"); return; }
  const created: ComponentNode[] = [];

  for (const node of selection) {
    const parent = node.parent;
    if (!parent || !("insertChild" in parent)) continue;
    const insertIndex = (parent as ChildrenMixin).children.indexOf(node as SceneNode);
    const component = figma.createComponent();
    component.name = node.name;

    if (node.type === "FRAME") {
      const f = node as FrameNode;
      const transform = f.relativeTransform;
      component.resize(f.width, f.height);
      component.opacity = f.opacity;
      component.blendMode = f.blendMode;
      component.clipsContent = f.clipsContent;
      component.fills = JSON.parse(JSON.stringify(f.fills));
      component.strokes = JSON.parse(JSON.stringify(f.strokes));
      component.strokeWeight = f.strokeWeight as number;
      component.strokeAlign = f.strokeAlign;
      component.effects = JSON.parse(JSON.stringify(f.effects));
      if (f.cornerRadius !== figma.mixed) {
        component.cornerRadius = f.cornerRadius as number;
      } else {
        component.topLeftRadius = f.topLeftRadius;
        component.topRightRadius = f.topRightRadius;
        component.bottomLeftRadius = f.bottomLeftRadius;
        component.bottomRightRadius = f.bottomRightRadius;
      }
      if (f.layoutMode !== "NONE") {
        component.layoutMode = f.layoutMode;
        component.primaryAxisSizingMode = f.primaryAxisSizingMode;
        component.counterAxisSizingMode = f.counterAxisSizingMode;
        component.primaryAxisAlignItems = f.primaryAxisAlignItems;
        component.counterAxisAlignItems = f.counterAxisAlignItems;
        component.paddingLeft = f.paddingLeft;
        component.paddingRight = f.paddingRight;
        component.paddingTop = f.paddingTop;
        component.paddingBottom = f.paddingBottom;
        component.itemSpacing = f.itemSpacing;
      }
      (parent as ChildrenMixin).insertChild(insertIndex, component);
      component.relativeTransform = transform;
      for (const child of [...f.children]) {
        component.appendChild(child);
        if ("constraints" in child) (child as any).constraints = { horizontal: "SCALE", vertical: "SCALE" };
      }
      f.remove();
    } else {
      const bb = node.absoluteBoundingBox;
      if (!bb) continue;
      const parentAbsX = parent.type === "PAGE" ? 0 : (parent as SceneNode).absoluteTransform[0][2];
      const parentAbsY = parent.type === "PAGE" ? 0 : (parent as SceneNode).absoluteTransform[1][2];
      component.fills = [];
      component.clipsContent = false;
      component.resize(Math.round(bb.width), Math.round(bb.height));
      (parent as ChildrenMixin).insertChild(insertIndex, component);
      component.x = bb.x - parentAbsX;
      component.y = bb.y - parentAbsY;
      component.appendChild(node);
      const nodeBBAfter = (node as any).absoluteBoundingBox;
      if (nodeBBAfter) {
        (node as any).x -= nodeBBAfter.x - component.absoluteTransform[0][2];
        (node as any).y -= nodeBBAfter.y - component.absoluteTransform[1][2];
      }
      if ("constraints" in node) (node as any).constraints = { horizontal: "SCALE", vertical: "SCALE" };
    }
    created.push(component);
  }

  figma.currentPage.selection = created;
  sendStatus(`${created.length} component(s) created`, "success");
}

// ✂️ Slice ×2.67 — rescale selection by 2.67, round to even, stack into a section
async function scaleSelection267(): Promise<void> {
  const GAP = 80, SECTION_PADDING = 100, SCALE = 2.67;
  const selection = [...figma.currentPage.selection];
  if (selection.length === 0) { sendStatus("Select objects", "error"); return; }
  const roundEven = (v: number) => Math.round(v / 2) * 2;

  for (const node of selection) {
    if (!("rescale" in node)) continue;
    (node as any).rescale(SCALE);
    if ("resize" in node) (node as any).resize(roundEven((node as any).width), roundEven((node as any).height));
  }

  const section = figma.createSection();
  section.name = "Slice / 2.67";
  figma.currentPage.appendChild(section);

  let currentY = SECTION_PADDING, maxWidth = 0;
  for (const node of [...selection]) {
    section.appendChild(node);
    (node as any).x = SECTION_PADDING;
    (node as any).y = currentY;
    currentY += (node as any).height + GAP;
    maxWidth = Math.max(maxWidth, (node as any).width);
  }
  section.resizeWithoutConstraints(maxWidth + SECTION_PADDING * 2, currentY - GAP + SECTION_PADDING);
  figma.viewport.scrollAndZoomIntoView([section]);
  sendStatus("Slice ×2.67 done", "success");
}

// ─── Master-style component tools (Componentize / Pick+Attach / Bulk Swap) ──
// Reimplemented from the documented behaviour of the "Master" plugin
// (dominate.design) — component workflows, no proprietary code.

// Load every font used by a text node so its characters can be rewritten.
async function loadNodeFonts(t: TextNode): Promise<void> {
  try {
    const len = Math.max(t.characters.length, 1);
    for (const f of t.getRangeAllFontNames(0, len)) {
      try { await figma.loadFontAsync(f); } catch (_e) {}
    }
  } catch (_e) {
    try {
      const fn = t.fontName;
      if (fn !== figma.mixed) await figma.loadFontAsync(fn as FontName);
    } catch (_e2) {}
  }
}

// Copy per-node overrides from a source subtree onto an instance subtree, matching
// nodes positionally (same layer order & hierarchy). Only writes values that differ,
// so token-bound paints round-trip untouched and no no-op overrides are recorded.
async function copyOverridesTree(src: any, dst: any, depth: number = 0): Promise<void> {
  if (!src || !dst || depth > 60) return;

  // Text content
  if (src.type === "TEXT" && dst.type === "TEXT") {
    if (src.characters !== dst.characters) {
      await loadNodeFonts(dst as TextNode);
      try { (dst as TextNode).characters = src.characters; } catch (_e) {}
    }
  }

  // Fills / strokes — round-trip the whole paint array (keeps boundVariables), only if changed
  try {
    if ("fills" in src && "fills" in dst && src.fills !== figma.mixed && dst.fills !== figma.mixed) {
      const a = JSON.stringify(src.fills);
      if (a !== JSON.stringify(dst.fills)) dst.fills = JSON.parse(a);
    }
  } catch (_e) {}
  try {
    if ("strokes" in src && "strokes" in dst) {
      const a = JSON.stringify(src.strokes);
      if (a !== JSON.stringify(dst.strokes)) dst.strokes = JSON.parse(a);
    }
  } catch (_e) {}

  // Visibility
  try {
    if (typeof src.visible === "boolean" && dst.visible !== src.visible) dst.visible = src.visible;
  } catch (_e) {}

  // Nested instance swap → match the source's nested component
  if (src.type === "INSTANCE" && dst.type === "INSTANCE") {
    try {
      const sm = (src as InstanceNode).mainComponent;
      const dm = (dst as InstanceNode).mainComponent;
      if (sm && dm && sm.id !== dm.id) (dst as InstanceNode).swapComponent(sm);
    } catch (_e) {}
  }

  // Recurse by child index
  if ("children" in src && "children" in dst) {
    const sc = src.children, dc = dst.children;
    const n = Math.min(sc.length, dc.length);
    for (let k = 0; k < n; k++) await copyOverridesTree(sc[k], dc[k], depth + 1);
  }
}

// Build a master component that visually matches `src`, preserving the frame's layer
// structure so instances line up 1:1. Works on a clone — never mutates `src`.
// Returns { comp, wrapped } where wrapped=true means the source content sits one level
// deeper (non-frame nodes get wrapped inside the component).
async function buildMasterFrom(src: SceneNode): Promise<{ comp: ComponentNode; wrapped: boolean } | null> {
  const comp = figma.createComponent();
  comp.name = src.name.replace(/frame/gi, "component");

  if (src.type === "FRAME") {
    const f = src as FrameNode;
    comp.resizeWithoutConstraints(f.width, f.height);
    try { comp.opacity = f.opacity; } catch (_e) {}
    try { comp.blendMode = f.blendMode; } catch (_e) {}
    try { comp.clipsContent = f.clipsContent; } catch (_e) {}
    try { comp.fills = JSON.parse(JSON.stringify(f.fills)); } catch (_e) {}
    try { comp.strokes = JSON.parse(JSON.stringify(f.strokes)); } catch (_e) {}
    try { comp.strokeWeight = f.strokeWeight as number; } catch (_e) {}
    try { comp.strokeAlign = f.strokeAlign; } catch (_e) {}
    try { comp.effects = JSON.parse(JSON.stringify(f.effects)); } catch (_e) {}
    try {
      if (f.cornerRadius !== figma.mixed) comp.cornerRadius = f.cornerRadius as number;
      else {
        comp.topLeftRadius = f.topLeftRadius; comp.topRightRadius = f.topRightRadius;
        comp.bottomLeftRadius = f.bottomLeftRadius; comp.bottomRightRadius = f.bottomRightRadius;
      }
    } catch (_e) {}
    if (f.layoutMode !== "NONE") {
      try {
        comp.layoutMode = f.layoutMode;
        comp.primaryAxisSizingMode = f.primaryAxisSizingMode;
        comp.counterAxisSizingMode = f.counterAxisSizingMode;
        comp.primaryAxisAlignItems = f.primaryAxisAlignItems;
        comp.counterAxisAlignItems = f.counterAxisAlignItems;
        comp.paddingLeft = f.paddingLeft; comp.paddingRight = f.paddingRight;
        comp.paddingTop = f.paddingTop; comp.paddingBottom = f.paddingBottom;
        comp.itemSpacing = f.itemSpacing;
      } catch (_e) {}
    }
    // Move the (cloned) children into the component → identical structure
    const clone = f.clone();
    for (const child of [...(clone as FrameNode).children]) comp.appendChild(child);
    clone.remove();
    return { comp, wrapped: false };
  }

  if (!("clone" in src)) { comp.remove(); return null; }
  const clone = (src as any).clone() as SceneNode;
  comp.fills = [];
  try { comp.clipsContent = false; } catch (_e) {}
  comp.resizeWithoutConstraints(Math.max(Math.round(src.width), 1), Math.max(Math.round(src.height), 1));
  comp.appendChild(clone);
  clone.x = 0; clone.y = 0;
  return { comp, wrapped: true };
}

// Componentize: select N similar objects → one master + every object an instance (overrides kept)
async function createComponentFromObjects(): Promise<void> {
  const selection = [...figma.currentPage.selection];
  const nodes = selection.filter((n) => n.type !== "SECTION" && "clone" in n);
  if (nodes.length === 0) { sendStatus("Select objects", "error"); return; }

  const base = nodes[0];
  const baseBB = base.absoluteBoundingBox;
  const built = await buildMasterFrom(base);
  if (!built) { sendStatus("Can't create component", "error"); return; }
  const { comp, wrapped } = built;

  // Park the master to the left of the selection
  figma.currentPage.appendChild(comp);
  if (baseBB) { comp.x = baseBB.x - comp.width - H_GAP; comp.y = baseBB.y; }

  const instances: InstanceNode[] = [];
  for (const node of nodes) {
    const parent = node.parent;
    if (!parent || !("insertChild" in parent)) continue;
    const idx = (parent as ChildrenMixin).children.indexOf(node as SceneNode);
    const inst = comp.createInstance();
    (parent as ChildrenMixin).insertChild(idx, inst);
    inst.x = node.x; inst.y = node.y;
    try { inst.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01)); } catch (_e) {}
    if ("rotation" in node) { try { (inst as any).rotation = (node as any).rotation; } catch (_e) {} }
    const dst = wrapped && inst.children.length ? inst.children[0] : inst;
    await copyOverridesTree(node, dst);
    node.remove();
    instances.push(inst);
  }

  if (instances.length) figma.currentPage.selection = instances;
  sendStatus(`Component + ${instances.length} instance(s)`, "success");
}

// Pick Target: remember the selected component/instance as the attach/swap target
async function pickTarget(): Promise<void> {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) { sendStatus("Select 1 component or instance", "error"); return; }
  const node = sel[0];
  let comp: ComponentNode | ComponentSetNode | null = null;
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") comp = node as any;
  else if (node.type === "INSTANCE") comp = (node as InstanceNode).mainComponent as any;
  if (!comp) { sendStatus("Pick a component or instance", "error"); return; }
  await figma.clientStorage.setAsync("masterTarget", {
    id: comp.id, key: (comp as any).key || null, name: comp.name,
  });
  sendStatus(`🎯 Target: ${comp.name}`, "success");
}

// Resolve the stored target back to a concrete ComponentNode (local id, else library key)
async function resolveTarget(): Promise<ComponentNode | null> {
  const t: any = await figma.clientStorage.getAsync("masterTarget");
  if (!t) return null;
  let node: BaseNode | null = null;
  try { node = await figma.getNodeByIdAsync(t.id); } catch (_e) {}
  if ((!node || (node as any).removed) && t.key) {
    try { node = await figma.importComponentByKeyAsync(t.key); } catch (_e) {}
  }
  if (!node) return null;
  if (node.type === "COMPONENT") return node as ComponentNode;
  if (node.type === "INSTANCE") return (node as InstanceNode).mainComponent;
  if (node.type === "COMPONENT_SET") {
    const set = node as ComponentSetNode;
    if (set.defaultVariant) return set.defaultVariant;
    const first = set.children.find((c) => c.type === "COMPONENT");
    return (first as ComponentNode) || null;
  }
  return null;
}

// Attach: turn the selected objects into instances of the picked target (overrides kept).
// Existing instances are swapped natively; frames/groups get a fresh instance + tree-walk.
async function attachToTarget(): Promise<void> {
  const target = await resolveTarget();
  if (!target) { sendStatus("Pick a target first", "error"); return; }
  const sel = [...figma.currentPage.selection];
  if (sel.length === 0) { sendStatus("Select objects to attach", "error"); return; }

  const result: SceneNode[] = [];
  let count = 0;
  for (const node of sel) {
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET" || node.type === "SECTION") continue;
    if (node.type === "INSTANCE") {
      try { (node as InstanceNode).swapComponent(target); result.push(node); count++; } catch (_e) {}
      continue;
    }
    const parent = node.parent;
    if (!parent || !("insertChild" in parent)) continue;
    const idx = (parent as ChildrenMixin).children.indexOf(node as SceneNode);
    let inst: InstanceNode;
    try { inst = target.createInstance(); } catch (_e) { continue; }
    (parent as ChildrenMixin).insertChild(idx, inst);
    inst.x = node.x; inst.y = node.y;
    try { inst.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01)); } catch (_e) {}
    if ("rotation" in node) { try { (inst as any).rotation = (node as any).rotation; } catch (_e) {} }
    await copyOverridesTree(node, inst);
    node.remove();
    result.push(inst); count++;
  }
  if (count > 0) figma.currentPage.selection = result;
  sendStatus(count > 0 ? `Attached ${count} → ${target.name}` : "Nothing to attach", count > 0 ? "success" : "error");
}

// Bulk Swap: replace every instance of the selected source component with the picked target
async function bulkSwapToTarget(): Promise<void> {
  const target = await resolveTarget();
  if (!target) { sendStatus("Pick a target first", "error"); return; }
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) { sendStatus("Select 1 source component/instance", "error"); return; }

  const s = sel[0];
  let source: ComponentNode | ComponentSetNode | null = null;
  if (s.type === "COMPONENT" || s.type === "COMPONENT_SET") source = s as any;
  else if (s.type === "INSTANCE") source = (s as InstanceNode).mainComponent as any;
  if (!source) { sendStatus("Select a component or instance", "error"); return; }

  const sourceIds = new Set<string>();
  if (source.type === "COMPONENT_SET") {
    for (const c of (source as ComponentSetNode).children) if (c.type === "COMPONENT") sourceIds.add(c.id);
  } else sourceIds.add(source.id);
  if (sourceIds.has(target.id)) { sendStatus("Source = target", "error"); return; }

  const all = figma.root.findAllWithCriteria({ types: ["INSTANCE"] }) as InstanceNode[];
  let count = 0;
  for (const inst of all) {
    let mc: ComponentNode | null = null;
    try { mc = inst.mainComponent; } catch (_e) {}
    if (mc && sourceIds.has(mc.id)) {
      try { inst.swapComponent(target); count++; } catch (_e) {}
    }
  }
  sendStatus(`Swapped ${count} instance(s) → ${target.name}`, count > 0 ? "success" : "error");
}

// ─── Custom JSON "recipe" scripts ────────────────────────────────

function hexToRgb(hex: string): RGB {
  let h = (hex || "#000000").replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (isNaN(n) || h.length < 6) return { r: 0, g: 0, b: 0 };
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, typeof v === "number" && !isNaN(v) ? v : 0));
}

function fillTemplate(s: string, node: SceneNode, i: number, origName: string): string {
  return String(s == null ? "" : s)
    .replace(/\{w\}/g, String(Math.round(node.width)))
    .replace(/\{h\}/g, String(Math.round(node.height)))
    .replace(/\{i\}/g, String(i))
    .replace(/\{name\}/g, origName);
}

async function applyScriptOp(node: any, op: any, i: number, origName: string): Promise<void> {
  switch (op && op.op) {
    case "move":    if ("x" in node) { node.x += Number(op.dx) || 0; node.y += Number(op.dy) || 0; } break;
    case "pos":     if (op.x != null) node.x = Number(op.x); if (op.y != null) node.y = Number(op.y); break;
    case "resize":  if ("resize" in node) node.resize(op.w != null ? Number(op.w) : node.width, op.h != null ? Number(op.h) : node.height); break;
    case "opacity": if ("opacity" in node) node.opacity = clamp01(Number(op.value)); break;
    case "rotate":  if ("rotation" in node) node.rotation = Number(op.deg) || 0; break;
    case "corner":  if ("cornerRadius" in node) node.cornerRadius = Number(op.value) || 0; break;
    case "visible": node.visible = !!op.value; break;
    case "lock":    node.locked = !!op.value; break;
    case "fill":    if ("fills" in node) node.fills = [{ type: "SOLID", color: hexToRgb(op.color), opacity: op.opacity != null ? clamp01(Number(op.opacity)) : 1 }]; break;
    case "stroke":  if ("strokes" in node) { node.strokes = [{ type: "SOLID", color: hexToRgb(op.color) }]; if (op.weight != null && "strokeWeight" in node) node.strokeWeight = Number(op.weight); } break;
    case "rename":  node.name = fillTemplate(op.name, node as SceneNode, i, origName); break;
    case "text":    if (node.type === "TEXT") { const f = (node as TextNode).fontName; if (f !== figma.mixed) { await figma.loadFontAsync(f as FontName); (node as TextNode).characters = String(op.value == null ? "" : op.value); } } break;
  }
}

async function runScript(script: any): Promise<void> {
  const sel = [...figma.currentPage.selection];
  if (sel.length === 0) { sendStatus("Select objects", "error"); return; }
  const ops = script && Array.isArray(script.ops) ? script.ops : null;
  if (!ops || ops.length === 0) { sendStatus("Script has no ops", "error"); return; }
  let i = 0;
  for (const node of sel) {
    i++;
    const origName = node.name;
    for (const op of ops) {
      try { await applyScriptOp(node, op, i, origName); } catch (_e) {}
    }
  }
  sendStatus(`Ran ${ops.length} ops on ${sel.length}`, "success");
}

// ─── Custom user buttons: JSON "Code" scripts ────────────────────

async function runCustomFn(fn: string, script?: any): Promise<void> {
  if (fn === "__script") await runScript(script);
}

// ─── UI Setup ────────────────────────────────────────────────────

figma.showUI(__html__, { width: 250, height: 62, themeColors: true });

// ─── Window positioning ──────────────────────────────────────────

let uiPos = "center";
let lastW = 250;
let lastH = 62;

function repositionUI(pos: string): void {
  const b = figma.viewport.bounds;
  const z = figma.viewport.zoom || 1;
  const wc = lastW / z;
  const hc = lastH / z;
  const m = 16 / z;
  let x: number, y: number;
  switch (pos) {
    case "tl": x = b.x + m; y = b.y + m; break;
    case "tr": x = b.x + b.width - wc - m; y = b.y + m; break;
    case "bl": x = b.x + m; y = b.y + b.height - hc - m * 3.5; break;
    case "br": x = b.x + b.width - wc - m; y = b.y + b.height - hc - m * 3.5; break;
    default:   x = b.x + (b.width - wc) / 2; y = b.y + (b.height - hc) / 2; break;
  }
  try { figma.ui.reposition(x, y); } catch (_e) {}
}

(async () => {
  uiPos = (await figma.clientStorage.getAsync("uiPos")) || "center";
  figma.ui.postMessage({ type: "pos", pos: uiPos });
  repositionUI(uiPos);
})();

// ─── Translator helpers ──────────────────────────────────────────

function findAllTextNodes(nodes: ReadonlyArray<SceneNode>): TextNode[] {
  let result: TextNode[] = [];
  for (const node of nodes) {
    if (node.type === "TEXT") {
      result.push(node);
    } else if ("children" in node) {
      result = result.concat(findAllTextNodes((node as ChildrenMixin & SceneNode).children as SceneNode[]));
    }
  }
  return result;
}

function sendSelectionInfo() {
  const sel = figma.currentPage.selection;
  const count = sel.length;
  const hasSection = sel.some((n) => n.type === "SECTION");
  const hasFrames = sel.some((n) => n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE");
  const allDark = count > 0 && sel.every((n) => n.name.endsWith(" — Dark"));
  const hasAny = count > 0;
  const textCount = findAllTextNodes(sel).length;

  figma.ui.postMessage({
    type: "selection-info",
    count,
    hasSection,
    hasFrames,
    allDark,
    hasAny,
    textCount,
  });
}

// Track the last node added to the selection (for Replace's reference object)
let lastAddedId: string | null = null;
let prevSelIds = new Set<string>();
function trackLastAdded() {
  const ids = figma.currentPage.selection.map((n) => n.id);
  for (const id of ids) {
    if (!prevSelIds.has(id)) lastAddedId = id;
  }
  prevSelIds = new Set(ids);
}

figma.on("selectionchange", () => {
  trackLastAdded();
  sendSelectionInfo();
});
trackLastAdded();
sendSelectionInfo();


// ─── Audit: design-file checks for the automated visual-diff pipeline ─────
// Rules and wording follow the "Design checklist for autotests" (R01–R31).
// The plugin sees what the REST script cannot: variable names and their collections,
// so "not from the design system" is an exact check here, and a token can be named and bound.
//
// Автопочинка намеренно узкая и ограничена по построению, а не списком исключений:
//   • писать можно только в незаблокированный узел вне компонента, набора вариантов и инстанса
//     (auditWritable) — правка внутри мастера расходится по всему файлу;
//   • цвет привязывается только к токену, который во всех режимах коллекции даёт ровно тот же
//     цвет вместе с прозрачностью, и только если такой токен ровно один;
//   • числа (отступы, промежутки, скругления, толщина обводки, кегль, интерлиньяж) привязываются
//     только к токену, значение которого В ТОЧНОСТИ равно текущему литералу и одинаково во всех
//     режимах: такая привязка не двигает ни одного пикселя — см. Fix: привязка значений ниже;
//   • радиус живёт на СВОЕЙ кнопке (audit-fix-radius), потому что он единственный меняет число
//     на слое: только однородные углы, без существующей привязки к переменной, значение
//     пересчитывается заново на момент записи.
// Снятие обёрток пробовали и убрали: обёртка несёт прозрачность, обрезку, маску, поворот или
// абсолютное положение, а GROUP держит детей в системе координат деда — ребёнок уезжает.

type AuditFix =
  | { kind: "bindPaint"; target: "fills" | "strokes"; index: number; key: string; variableId: string }
  | { kind: "radius"; value: number }
  | { kind: "rename"; name: string };

type Finding = {
  rule: string;
  title: string;
  severity: "block" | "warn" | "hint";
  text: string;
  nodeId: string;
  nodeName: string;
  rootId: string;            // экран, на котором нашлось: по нему группируется комментарий
  rootName: string;
  block?: string;            // блок внутри экрана, чтобы было понятно, где искать
  hint?: string;
  fix?: AuditFix;
};

// Чек-лист целиком — те же номера, что на странице «Чек-лист макета под автотест».
// Заголовок, общий смысл и рекомендация лежат рядом: комментарий на макете собирается
// из этих трёх таблиц, поэтому ни одно правило не может оказаться без «что делать».
const AUDIT_TITLES: Record<string, string> = {
  R01: "Выбрано полотно, а не экран",
  R02: "Имя узла не по формату",
  R03: "Состояние описано одним словом",
  R04: "В имени нет темы",
  R05: "Ширина не по канве проекта",
  R06: "Скролл не помечен в имени",
  R07: "Полупрозрачность фрейма",
  R08: "Цвет без переменной",
  R09: "Текст без стиля",
  R10: "Не из дизайн-системы",
  R12: "Нет auto layout",
  R15: "Техническая заглушка в тексте",
  R16: "Снято глазом",
  R17: "Нарисовано вместо компонента",
  R19: "Генерик-имена слоёв",
  R20: "Системные зоны не названы",
  R21: "Растровая заливка без пометки",
  R23: "Нет негативных состояний",
  R28: "Лишние обёртки",
  R29: "Просится в компонент",
  R30: "Отступы и радиусы мимо дизайн-системы",
  R31: "Скругления не концентричны",
  B01: "Похоже на опечатку",
  B02: "Длинное тире в коротком тексте",
  B03: "Слово не из словаря",
  B04: "Градиент без переменной",
  B05: "Цвет иконки без переменной",
  B06: "Цвет тени без переменной",
};

// Одна строка на весь комментарий: в чём суть правила. Дальше идёт список слоёв.
const AUDIT_WHAT: Record<string, string> = {
  R01: "Ссылка для автотеста должна вести на конкретное состояние экрана, а не на доску со множеством экранов.",
  R02: "Имя эталона разбирается скриптом на части, поэтому формат обязателен и имя должно быть уникальным.",
  R03: "Состояние в имени перечисляет все измерения, от которых меняется вид экрана.",
  R04: "Тема в имени говорит прогону, какой эталон с каким сравнивать.",
  R05: "Экспорт эталона снимается в канве проекта: другая ширина даёт расхождение на каждом прогоне.",
  R06: "Экран выше видимой области снимается со скроллом, и это должно быть видно по имени.",
  R07: "Полупрозрачность уходит в экспорт: эталон получится выцветшим.",
  R08: "Сплошные заливки и обводки не привязаны к переменной библиотеки — автосравнение цвета невозможно.",
  R09: "Тексты без текстового стиля библиотеки: шрифт и размер не с чем сверить.",
  R10: "Переменные или стили заведены внутри файла, а не взяты из библиотеки дизайн-системы.",
  R12: "Контейнеры с текстом без auto layout: геометрия сравнивается с широким допуском.",
  R15: "Технические заглушки попадут в эталон как настоящий текст.",
  R16: "Скрытые слои попадут в эталон как содержимое, которого на экране нет.",
  R17: "Интерактив нарисован руками, а не взят из библиотеки.",
  R19: "Слои с генерик-именами в отчёте прогона нечем назвать.",
  R20: "Системную зону нечем исключить из сравнения, и она будет расходиться на каждом прогоне.",
  R21: "Растровые заливки меняются от аккаунта к аккаунту, а область не помечена как переменная.",
  R23: "Среди выбранных узлов нет негативных состояний.",
  R28: "Фрейм с единственным ребёнком того же размера, без заливки и отступов: лишний уровень удлиняет путь к слою в отчёте.",
  R29: "Блок повторяется на нескольких экранах и собран руками, а не инстансом компонента.",
  R30: "Отступы и радиусы заданы числом, а не переменной дизайн-системы.",
  R31: "Скругления не концентричны: у вложенного блока радиус должен быть меньше внешнего ровно на величину отступа.",
  B01: "В тексте есть то, что обычно оказывается опечаткой: буква из чужого алфавита, двойной пробел, пробел перед знаком.",
  B02: "В коротком интерфейсном тексте длинное тире почти всегда лишнее.",
  B03: "Слова нет ни в русском, ни в английском словаре, и в макетах оно встречается один-два раза.",
  B04: "Цвета в градиенте заданы вручную: ни один стоп не привязан к переменной библиотеки. Правило R08 смотрит только сплошные заливки и градиенты не разбирает вовсе.",
  B05: "Заливка векторной фигуры задана вручную. R08 векторы не разбирает, хотя цвет иконки сравнивается на прогоне так же, как любой другой.",
  B06: "Цвет тени или свечения задан вручную. Эффекты не разбирает ни одно правило чек-листа, а в экспорт они попадают.",
};

// Рекомендация — что именно сделать. Попадает в комментарий отдельной строкой.
const AUDIT_HINTS: Record<string, string> = {
  R01: "возьмите ссылку на конкретный экран внутри полотна — или выделите этот экран и запустите Find ещё раз.",
  R02: "переименуйте по формату «Экран / Блок / Состояние / Тема», например «Профиль / Карточка / Гость / Light».",
  R03: "перечислите в состоянии все измерения: пол, ранг, что открыто, есть ли клуб.",
  R04: "допишите в конец имени « / Light» или « / Dark».",
  R05: "поставьте экрану ширину 540; блок внутри экрана держите в диапазоне 484–540.",
  R06: "допишите в имя слово «скролл» — прогон снимет экран целиком.",
  R07: "верните фрейму непрозрачность 100 %, а затемнение держите отдельным слоем-подложкой.",
  R08: "привяжите заливку к токену дизайн-системы; однозначные случаи чинит кнопка Fix.",
  R09: "назначьте тексту текстовый стиль из библиотеки.",
  R10: "замените локальную переменную или стиль на токен дизайн-системы — по файловому автосравнение невозможно.",
  R12: "включите контейнеру auto layout, чтобы положение считалось, а не замерялось.",
  R15: "впишите реальный текст или пометьте переменной {…}.",
  R16: "удалите слой, если он остался от прошлой версии, или вынесите его в вариант компонента.",
  R17: "соберите элемент инстансом компонента из библиотеки.",
  R19: "дайте слою осмысленное имя — оно попадёт в отчёт прогона.",
  R20: "добавьте слои с именами Notch или Status bar сверху и Home indicator снизу.",
  R21: "добавьте в имя слоя {…} или слово avatar / photo — область станет переменной.",
  R23: "нарисуйте состояния «Ошибка», «Пусто», «Загрузка», «Тост», «Заблокирован» — иначе их некому проверять.",
  R28: "удалите обёртку вручную: она может нести layout или обрезку, которую скрипт не перенесёт безопасно.",
  R29: "соберите блок компонентом и расставьте инстансами — иначе правку придётся вносить столько же раз.",
  R30: "привяжите отступы и радиусы к переменным дизайн-системы.",
  R31: "внутренний радиус = внешний минус отступ; однозначные случаи чинит кнопка Radius.",
  B01: "перенаберите слово в одной раскладке; лишние пробелы уберите. Латинская буква внутри русского слова ломает сравнение текста намертво.",
  B02: "замените на двоеточие или запятую, либо разбейте на две строки.",
  B04: "привяжите каждый стоп градиента к токену дизайн-системы — стоп держит свою переменную отдельно от заливки.",
  B05: "привяжите заливку иконки к токену; если иконка приходит из библиотеки, проверьте, что цвет задан в самом компоненте, а не переопределён здесь.",
  B06: "привяжите цвет эффекта к токену или вынесите эффект в стиль библиотеки.",
  B03: "проверьте написание. Если слово правильное и просто редкое — продуктовое название, имя, сленг — используйте его в макетах ещё раз, и правило замолчит.",
};

const NODE_NAME_RE = /^[^/]+ \/ ([^/]+ \/ )?[^/]+ \/ (Light|Dark)\s*$/;
const GENERIC_NAME_RE = /^(Frame|Group|Rectangle|Ellipse|Component|Vector|Line|Polygon|Star|Slice|Union|Subtract|Intersect|Exclude) ?\d*$/i;
const PLACEHOLDER_TEXTS = new Set(["sub text", "subtext", "user name", "username", "text", "label", "lable", "lorem ipsum", "lorem", "placeholder", "title", "button", "name", "value", "heading", "body", "caption", "description"]);
const SYSTEM_LAYER_NAMES = ["notch", "status bar", "statusbar", "dynamic island", "home indicator", "navigation bottom bars"];
const INTERACTIVE_RE = /\b(button|switch|toggle|tab|input|radio|checkbox|slider|chip)\b/i;
const STATE_WIDGET_RE = /switch|radio|toggle|checkbox|(^|[^bc])lock/i;
const STATE_HINT_RE = /(Доступно с|Недоступно|Требуется|уровня VIP|Заблокирован|Locked|Unavailable)/i;
const NEGATIVE_STATE_RE = /(Ошибк|Пуст|Загрузк|Тост|Хинт|Модалк|Заблокирован|Error|Empty|Loading|Toast|Locked|Skeleton)/i;
// Буква одного алфавита вплотную к букве другого внутри слова: «Сart» с латинской C,
// «Ввод кoда» с латинской o. Глазом не видно, а сравнение текста ломает намертво.
const MIXED_ALPHABET_RE = /[A-Za-z][А-Яа-яЁё]|[А-Яа-яЁё][A-Za-z]/;
const DOUBLE_SPACE_RE = /\S {2,}\S/;
const SPACE_BEFORE_PUNCT_RE = /\s[.,!?:;]/;
// Длинное и среднее тире. В русской фразе длинное тире уместно, поэтому ругаемся только
// на короткую подпись — кнопку, лейбл, чип — и на тире без пробелов, набранное по-английски.
const LONG_DASH_RE = /[—–]/;
const TIGHT_DASH_RE = /\S[—–]\S/;
const SHORT_TEXT_LIMIT = 50;
// Что вообще отдаём словарю: слова от четырёх букв, без цифр, не капсом (капс — это
// аббревиатура, словарю её знать неоткуда) и в одном алфавите (смешанные ловит B01).
const WORD_SPLIT_RE = /[^A-Za-zА-Яа-яЁё\u0301-]+/;
// Сколько раз слово должно встретиться в макетах, чтобы считаться продуктовым и своим.
const WORD_KNOWN_AT = 3;
const IMAGE_MARKED_RE = /avatar|photo|image|аватар|фото|картинк|\{/i;
const SCROLL_RE = /скролл|scroll/i;
const CANVAS_WIDTH = 540;          // канва проекта
const BOARD_WIDTH = 600;           // шире — это полотно, а не экран
const SCREEN_HEIGHT = 900;         // от этой высоты узел считаем экраном
const SCROLL_HEIGHT = 1180;        // выше — экран со скроллом
const REPEAT_THRESHOLD = 3;        // столько одинаковых блоков — уже просится в компонент
const SPACING_FIELDS = ["itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom"];
const RADIUS_FIELDS = ["cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"];
const LIBRARY_SCAN_LIMIT = 200;

// Единственные узлы, в которые Fix имеет право писать: не заблокированные и не находящиеся
// внутри компонента, набора вариантов или инстанса. Правка внутри мастер-компонента расходится
// по всем его инстансам во всём файле, то есть выходит далеко за пределы проверяемого экрана.
function auditWritable(n: SceneNode): boolean {
  let p: BaseNode | null = n;
  while (p && p.type !== "PAGE" && p.type !== "DOCUMENT") {
    if ((p as any).locked) return false;
    if (p.type === "INSTANCE" || p.type === "COMPONENT" || p.type === "COMPONENT_SET") return false;
    p = p.parent;
  }
  return true;
}

function rgbToHex(c: RGB): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}

// cornerRadius is figma.mixed when the corners differ; fall back to the per-corner values so
// bottom-sheet-style shapes are not silently skipped. Mixed corners never get an auto-fix.
// Прозрачность входит в сравнение: краска #FFFFFF при 40 % и токен #FFFFFF при 100 % — разные цвета.
function paintKey(p: SolidPaint): string {
  const a = typeof p.opacity === "number" ? p.opacity : 1;
  return `${rgbToHex(p.color)}@${Math.round(a * 255).toString(16).padStart(2, "0").toUpperCase()}`;
}

function rgbaKey(c: any): string {
  const a = typeof c.a === "number" ? c.a : 1;
  return `${rgbToHex(c as RGB)}@${Math.round(a * 255).toString(16).padStart(2, "0").toUpperCase()}`;
}

function auditRadiusOf(n: SceneNode): { value: number; uniform: boolean } {
  const r = (n as any).cornerRadius;
  if (typeof r === "number") return { value: r, uniform: true };
  const corners = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"]
    .map((k) => (n as any)[k])
    .filter((v) => typeof v === "number") as number[];
  if (!corners.length) return { value: 0, uniform: true };
  return { value: Math.max.apply(null, corners), uniform: false };
}

// A radius at or past half the shorter side means a deliberately round shape ("pill"),
// which the concentric rule does not govern. Degenerate boxes are never pills.
function auditIsPill(n: SceneNode, r: number): boolean {
  const m = Math.min(n.width, n.height);
  if (m <= 1) return false;
  return r >= m / 2 - 0.5;
}

// A wrapper that carries any of these is doing visual work — it is not "pointless".
function wrapperIsPlain(f: SceneNode): boolean {
  const a = f as any;
  if (typeof a.opacity === "number" && a.opacity < 0.999) return false;
  if (a.blendMode && a.blendMode !== "PASS_THROUGH") return false;
  if (Array.isArray(a.reactions) && a.reactions.length) return false;
  if (a.isMask) return false;
  if (typeof a.rotation === "number" && Math.abs(a.rotation) > 0.01) return false;
  if (a.layoutPositioning === "ABSOLUTE") return false;
  if (Array.isArray(a.fills) && a.fills.length) return false;
  if (Array.isArray(a.strokes) && a.strokes.length) return false;
  if (Array.isArray(a.effects) && a.effects.length) return false;
  if (a.paddingLeft || a.paddingRight || a.paddingTop || a.paddingBottom) return false;
  return true;
}

type TokenMap = {
  byHex: Map<string, string[]>;      // цвет → библиотечные токены: для подсказки
  stableIds: Set<string>;            // из них те, чей цвет одинаков во всех режимах: только их привязываем
  nameById: Map<string, string>;
  localIds: Set<string>;
  libraryScanTruncated: boolean;
};

// Цвет токена в режиме по умолчанию — годится только для подсказки.
async function hexOfVariable(v: Variable): Promise<string | null> {
  const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
  if (!col) return null;
  const val: any = v.valuesByMode[col.defaultModeId];
  // Алиас указывает на другую переменную, а не хранит цвет: по нему сравнивать нечего.
  if (!val || typeof val !== "object" || val.type === "VARIABLE_ALIAS" || !("r" in val)) return null;
  return rgbaKey(val);
}

// Привязывать автоматически можно только токен, который во ВСЕХ режимах коллекции даёт один и тот
// же цвет. Иначе на тёмном экране «точно такой же цвет» превратится в другой, и это увидит уже
// пользователь, а не дизайнер.
async function stableKeyOfVariable(v: Variable): Promise<string | null> {
  const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
  if (!col || !col.modes.length) return null;
  let key: string | null = null;
  for (const m of col.modes) {
    const val: any = v.valuesByMode[m.modeId];
    if (!val || typeof val !== "object" || val.type === "VARIABLE_ALIAS" || !("r" in val)) return null;
    const k = rgbaKey(val);
    if (key === null) key = k;
    else if (key !== k) return null;
  }
  return key;
}

// hex → library colour tokens. Built from the team libraries (so a fully hardcoded file still gets
// suggestions) plus whatever is already bound inside the audited nodes.
async function buildTokenMap(roots: SceneNode[]): Promise<TokenMap> {
  const byHex = new Map<string, string[]>();
  const stableIds = new Set<string>();
  const nameById = new Map<string, string>();
  const localIds = new Set<string>();
  const seen = new Set<string>();
  let truncated = false;

  const addHex = (hex: string, id: string) => {
    const list = byHex.get(hex) || [];
    if (list.indexOf(id) < 0) list.push(id);
    byHex.set(hex, list);
  };

  for (const v of await figma.variables.getLocalVariablesAsync()) {
    localIds.add(v.id);
    nameById.set(v.id, v.name);
    seen.add(v.id);
  }

  try {
    let imported = 0;
    for (const col of await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()) {
      const vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
      for (const lv of vars) {
        if (lv.resolvedType !== "COLOR") continue;
        if (imported >= LIBRARY_SCAN_LIMIT) { truncated = true; break; }
        imported++;
        // Отдельный try на каждый импорт: один отказ не должен обрывать обход всей библиотеки.
        try {
          const v = await figma.variables.importVariableByKeyAsync(lv.key);
          if (!v) continue;
          seen.add(v.id);
          nameById.set(v.id, v.name);
          const hex = await hexOfVariable(v);
          if (hex) addHex(hex, v.id);
          if (await stableKeyOfVariable(v)) stableIds.add(v.id);
        } catch (_e) { /* недоступный токен пропускаем */ }
      }
      if (truncated) break;
    }
  } catch (_e) {
    // No library access (unpublished file, offline): suggestions fall back to what is bound here.
  }

  const remember = async (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const v = await figma.variables.getVariableByIdAsync(id);
    if (!v) return;
    nameById.set(id, v.name);
    const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
    if (col && !col.remote) { localIds.add(id); return; }
    if (v.resolvedType !== "COLOR") return;
    const hex = await hexOfVariable(v);
    if (hex) addHex(hex, id);
    if (await stableKeyOfVariable(v)) stableIds.add(id);
  };

  const walkVars = async (n: SceneNode) => {
    const bv = (n as any).boundVariables as Record<string, any> | undefined;
    if (bv) for (const val of Object.values(bv)) {
      for (const b of Array.isArray(val) ? val : [val]) if (b && b.id) await remember(b.id);
    }
    if ("children" in n) for (const c of (n as ChildrenMixin).children as SceneNode[]) await walkVars(c);
  };
  for (const r of roots) await walkVars(r);
  return { byHex, stableIds, nameById, localIds, libraryScanTruncated: truncated };
}

// The binding of a paint lives on the paint itself; node.boundVariables[prop] is not index-aligned
// with the paint array, so reading it by index can mistake a bound paint for an unbound one.
function paintBinding(p: Paint): string | null {
  const bv = (p as any).boundVariables;
  return bv && bv.color && bv.color.id ? String(bv.color.id) : null;
}

// Контекст на весь прогон: часть правил видна только при взгляде на всю выборку сразу —
// повторяющийся блок, дубль имени, уже существующий в файле токен такой величины.
type AuditCtx = {
  duplicateNames: Map<string, number>;
  repeated: Map<string, { count: number; samples: Array<{ node: SceneNode; root: SceneNode }> }>;
  scale: Set<number>;                                   // величины, у которых где-то уже есть переменная
  free: Map<string, { root: SceneNode; spacing: number[]; radius: number[] }>;
  styleRemote: Map<string, { remote: boolean; name: string }>;   // стиль из библиотеки или заведён в файле
  words: Map<string, { count: number; node: SceneNode; root: SceneNode }>;
};

function newAuditCtx(roots: SceneNode[]): AuditCtx {
  const duplicateNames = new Map<string, number>();
  for (const r of roots) duplicateNames.set(r.name, (duplicateNames.get(r.name) || 0) + 1);
  return { duplicateNames, repeated: new Map(), scale: new Set(), free: new Map(), styleRemote: new Map(), words: new Map() };
}

// Имя для безымянного фрейма — по тому, что внутри. Порядок важен: инстанс компонента
// говорит о назначении точнее всего, текст — следом, иконка — последней.
// Ничего внятного не нашлось — возвращаем null, и Fix такой слой не трогает.
function suggestedName(n: SceneNode): string | null {
  if (!("children" in n)) return null;
  const kids = ((n as ChildrenMixin).children as SceneNode[]).filter((k) => k.visible !== false);
  const clean = (v: string) => v.replace(/\s+/g, " ").trim();

  const instances = kids.filter((k) => k.type === "INSTANCE");
  if (instances.length === 1) {
    const name = clean(instances[0].name);
    if (name && !GENERIC_NAME_RE.test(name)) return name;
  }
  // Текст ищем вглубь: подпись кнопки обычно лежит не прямым ребёнком.
  const firstText = (from: SceneNode[], depth: number): string | null => {
    for (const k of from) {
      if (k.visible === false) continue;
      if (k.type === "TEXT") {
        const t = clean((k as TextNode).characters || "");
        if (t) return t.length > 24 ? t.slice(0, 24).trim() + "…" : t;
      }
      if (depth > 0 && "children" in k) {
        const deeper = firstText((k as ChildrenMixin).children as SceneNode[], depth - 1);
        if (deeper) return deeper;
      }
    }
    return null;
  };
  const text = firstText(kids, 3);
  if (text) return text;

  for (const k of kids) {
    if (k.type !== "VECTOR" && k.type !== "BOOLEAN_OPERATION" && k.type !== "COMPONENT") continue;
    const name = clean(k.name);
    if (name && !GENERIC_NAME_RE.test(name)) return name;
  }
  return null;
}

async function auditNode(root: SceneNode, tokens: TokenMap, ctx: AuditCtx): Promise<Finding[]> {
  const out: Finding[] = [];
  const push = (rule: string, severity: Finding["severity"], text: string, n: SceneNode, hint?: string, fix?: AuditFix) =>
    out.push({ rule, title: AUDIT_TITLES[rule] || rule, severity, text, nodeId: n.id, nodeName: n.name,
               rootId: root.id, rootName: root.name, block: n.id === root.id ? "" : blockNameOf(n, root), hint, fix });

  const name = root.name || "";
  const rootBox = (root as any).absoluteBoundingBox as Rect | null;
  // Экран, доска и блок проверяются по-разному: у доски нет ни темы, ни ширины канвы.
  const isScreen = root.height >= SCREEN_HEIGHT && root.width >= 300 && root.width <= BOARD_WIDTH;
  if (root.width > BOARD_WIDTH) {
    push("R01", "block", `${Math.round(root.width)}×${Math.round(root.height)} — это полотно, а не состояние экрана.`, root);
    return out;
  }

  if (!NODE_NAME_RE.test(name) || GENERIC_NAME_RE.test(name)) push("R02", "block", `"${name}" не по формату «Экран / Блок / Состояние / Тема».`, root);
  if ((ctx.duplicateNames.get(name) || 0) > 1) push("R02", "warn", `Имя встречается в выборке ${ctx.duplicateNames.get(name)} раз.`, root);
  if (!/\/\s*(Light|Dark)\s*$/.test(name)) push("R04", "warn", "В имени нет темы Light или Dark.", root);
  if (isScreen && Math.round(root.width) !== CANVAS_WIDTH) push("R05", "block", `Ширина экрана ${Math.round(root.width)}, канва проекта ${CANVAS_WIDTH}.`, root);
  else if (!isScreen && Math.round(root.width) >= 300 && (Math.round(root.width) < 484 || Math.round(root.width) > CANVAS_WIDTH)) push("R05", "block", `Ширина блока ${Math.round(root.width)} вне диапазона 484–${CANVAS_WIDTH}.`, root);
  if (root.height > SCROLL_HEIGHT && !SCROLL_RE.test(name)) push("R06", "warn", `Высота ${Math.round(root.height)} больше экрана, слова «скролл» в имени нет.`, root);
  if (typeof (root as any).opacity === "number" && (root as any).opacity < 0.999) push("R07", "warn", `Прозрачность фрейма ${Math.round((root as any).opacity * 100)} %.`, root);

  let hasStateWidgets = false, hasStateText = false, hasTopSystem = false, hasBottomSystem = false;
  const freeHere = { root, spacing: [] as number[], radius: [] as number[] };

  const visit = async (n: SceneNode, insideInstance: boolean) => {
    const ln = (n.name || "").toLowerCase();
    // Системная зона: отмечаем, что она названа, и внутрь не лезем — её содержимое
    // прогон всё равно исключает из сравнения.
    let systemZone = false;
    if (n !== root && SYSTEM_LAYER_NAMES.some((s) => ln.indexOf(s) >= 0)) {
      systemZone = true;
      const nb = (n as any).absoluteBoundingBox as Rect | null;
      if (rootBox && nb) {
        if (nb.y - rootBox.y < 100) hasTopSystem = true;
        if (rootBox.y + rootBox.height - (nb.y + nb.height) < 40) hasBottomSystem = true;
      }
    }
    // Скрытость проверяемого экрана не повод не проверять его: в исходнике корень
    // из этого правила исключён явно (p !== frame), иначе обход обрывается на первом узле
    // и экран получает ложные R20 вместо аудита.
    if (n !== root && n.visible === false) {
      if (!insideInstance) push("R16", "warn", `Слой "${n.name}" снят глазом.`, n);
      return;
    }

    const paintGroups: Array<{ target: "fills" | "strokes"; list: any; styleId: any }> = [
      { target: "fills", list: (n as any).fills, styleId: (n as any).fillStyleId },
      { target: "strokes", list: (n as any).strokes, styleId: (n as any).strokeStyleId },
    ];
    // Overrides inside an instance belong to the component, so only the instance node itself is judged.
    if (!insideInstance || n.type === "INSTANCE") {
      // Текст с посегментным стилем: fills относится ко всему узлу, запись стёрла бы раскраску
      // отдельных кусков. Такой узел уже помечен R09, красок не трогаем.
      const mixedText = n.type === "TEXT" && (n as TextNode).textStyleId === figma.mixed;
      // Запись в fills такому узлу стёрла бы посегментную раскраску, поэтому чинить его нельзя.
      // Но Find только читает: находку показываем, просто без автоправки.
      const canWrite = auditWritable(n);
      const writable = canWrite && !mixedText;
      for (const g of paintGroups) {
        if (!Array.isArray(g.list)) continue;
        if (g.styleId && g.styleId !== figma.mixed) continue;
        // Вектор — это иконка. R08 её не разбирает, но цвет у неё такой же сравниваемый,
        // как у всех, поэтому он уходит в собственное правило плагина.
        const iconish = n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION";
        (g.list as Paint[]).forEach((p, i) => {
          if (p.visible === false) return;
          // Градиент: у каждого стопа своя привязка, и ни одно правило чек-листа их не смотрит.
          if (p.type.indexOf("GRADIENT") === 0) {
            const stops = ((p as GradientPaint).gradientStops || []) as ReadonlyArray<ColorStop>;
            const free = stops.filter((st) => !(st.boundVariables && (st.boundVariables as any).color));
            if (free.length) {
              const where = g.target === "fills" ? "Заливка" : "Обводка";
              push("B04", "warn", `${where}-градиент у "${n.name}": ${free.length} из ${stops.length} стопов без переменной.`, n);
            }
            return;
          }
          if (p.type !== "SOLID") return;
          const boundId = paintBinding(p);
          if (!boundId && iconish) {
            const key = paintKey(p as SolidPaint);
            const ids = tokens.byHex.get(key) || [];
            push("B05", "warn", `Цвет ${key.split("@")[0]} у иконки "${n.name}" без переменной.`, n,
              ids.length === 1 ? `подходит токен "${tokens.nameById.get(ids[0])}"` : undefined);
            return;
          }
          if (iconish) return;                    // привязанную иконку R10 разберёт ниже общим проходом
          if (!boundId) {
            const key = paintKey(p as SolidPaint);
            const ids = tokens.byHex.get(key) || [];
            const safe = ids.filter((id) => tokens.stableIds.has(id));
            const only = ids.length === 1 ? ids[0] : null;
            const where = g.target === "fills" ? "Заливка" : "Обводка";
            const canBind = only && safe.length === 1 && safe[0] === only && writable;
            push("R08", "block", `${where} ${key.split("@")[0]} у "${n.name}" без переменной.`, n,
              canBind ? `подходит токен "${tokens.nameById.get(only as string)}" — чинится кнопкой Fix` :
              only ? `токен "${tokens.nameById.get(only as string)}" того же цвета, но привязать нужно вручную${
                writable ? ": цвет зависит от режима"
                : mixedText ? ": текст размечен кусками, запись стёрла бы раскраску"
                : ": слой заблокирован или лежит внутри компонента"}` :
              ids.length > 1 ? `${ids.length} токенов библиотеки с таким цветом — выберите вручную` : undefined,
              canBind ? { kind: "bindPaint", target: g.target, index: i, key, variableId: only as string } : undefined);
          } else if (tokens.localIds.has(boundId)) {
            push("R10", "warn", `Переменная "${tokens.nameById.get(boundId) || boundId}" у "${n.name}" заведена в файле, а не в библиотеке.`, n);
          }
        });
      }
      // Тени и свечения: цвет у них такой же, и в экспорт он попадает, но ни одно
      // правило чек-листа эффекты не смотрит.
      const effects = (n as any).effects;
      if (Array.isArray(effects) && !(n as any).effectStyleId) {
        let freeFx = 0;
        for (const fx of effects as Effect[]) {
          if (!fx || fx.visible === false || !("color" in fx)) continue;
          const bv2 = (fx as any).boundVariables;
          if (!(bv2 && bv2.color)) freeFx++;
        }
        if (freeFx) push("B06", "warn", `У "${n.name}" ${freeFx === 1 ? "цвет эффекта задан" : freeFx + " цвета эффектов заданы"} вручную.`, n);
      }

      // Стиль, заведённый внутри файла, — то же самое нарушение, что и локальная переменная.
      // Без этой проверки слой под локальным стилем выпадал и из R08 (его глушит styleId),
      // и из R10 — то есть проходил аудит полностью чистым.
      for (const sk of ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId", "gridStyleId"]) {
        const sid = (n as any)[sk];
        if (!sid || typeof sid !== "string") continue;
        let meta = ctx.styleRemote.get(sid);
        if (!meta) {
          try {
            const st = await figma.getStyleByIdAsync(sid);
            meta = { remote: st ? st.remote !== false : true, name: st ? st.name : sid };
          } catch (_e) { meta = { remote: true, name: sid }; }
          ctx.styleRemote.set(sid, meta);
        }
        if (!meta.remote) push("R10", "warn", `Стиль "${meta.name}" у "${n.name}" заведён в файле, а не в библиотеке.`, n);
      }
      // Привязка к локальной переменной бывает не только у цвета: радиус, отступ, размер шрифта.
      // Краски разобраны выше по самой краске, поэтому их ключи здесь пропускаем.
      const bvAll = ((n as any).boundVariables || {}) as Record<string, any>;
      const localSeen: Record<string, true> = {};
      const paintsJudged = n.type !== "VECTOR" && n.type !== "BOOLEAN_OPERATION";
      for (const k of Object.keys(bvAll)) {
        if (paintsJudged && (k === "fills" || k === "strokes")) continue;
        const v = bvAll[k];
        for (const one of (Array.isArray(v) ? v : [v])) {
          const id = one && one.id ? String(one.id) : "";
          if (!id || !tokens.localIds.has(id) || localSeen[id]) continue;
          localSeen[id] = true;
          push("R10", "warn", `Переменная "${tokens.nameById.get(id) || id}" у "${n.name}" заведена в файле, а не в библиотеке.`, n);
        }
      }
      if (n.type === "TEXT") {
        const styleId = (n as TextNode).textStyleId;
        const bv = ((n as any).boundVariables || {}) as Record<string, any>;
        if (styleId === figma.mixed) {
          push("R09", "warn", `Текст "${(n as TextNode).characters.slice(0, 24)}" размечен кусками — часть без стиля библиотеки.`, n);
        } else if (!styleId && !bv.fontSize && !bv.fontFamily) {
          push("R09", "block", `Текст "${(n as TextNode).characters.slice(0, 24)}" без текстового стиля библиотеки.`, n);
        }
      }
    }

    // Содержимое текста судим и внутри инстанса: заглушка в переопределении — такая же заглушка.
    if (n.type === "TEXT") {
      const t = ((n as TextNode).characters || "").trim();
      if (PLACEHOLDER_TEXTS.has(t.toLowerCase())) push("R15", "block", `Заглушка "${t}".`, n);
      if (STATE_HINT_RE.test(t)) hasStateText = true;
      const typo: string[] = [];
      if (MIXED_ALPHABET_RE.test(t)) typo.push("буква из чужого алфавита");
      if (DOUBLE_SPACE_RE.test(t)) typo.push("двойной пробел");
      if (SPACE_BEFORE_PUNCT_RE.test(t)) typo.push("пробел перед знаком");
      if (typo.length) push("B01", "warn", `"${t.slice(0, 40)}" — ${typo.join(", ")}.`, n);
      for (const w of t.split(WORD_SPLIT_RE)) {
        if (w.length < 4 || w === w.toUpperCase()) continue;
        if (MIXED_ALPHABET_RE.test(w)) continue;        // это уже находка B01
        const slot = ctx.words.get(w);
        if (slot) slot.count++;
        else ctx.words.set(w, { count: 1, node: n, root });
      }
      if (LONG_DASH_RE.test(t) && (t.length <= SHORT_TEXT_LIMIT || TIGHT_DASH_RE.test(t))) {
        push("B02", "hint", `"${t.slice(0, 40)}"${TIGHT_DASH_RE.test(t) ? " — тире без пробелов" : ""}.`, n);
      }
    }
    if (n.type === "INSTANCE" && STATE_WIDGET_RE.test(n.name || "")) hasStateWidgets = true;
    // Полноэкранная полупрозрачная плашка: в экспорте она выцветит весь кадр. Судим её и внутри
    // инстансов — затемнение почти всегда лежит внутри компонента «Модалка» или «Шторка».
    const ownBox = (n as any).absoluteBoundingBox as Rect | null;
    if (n !== root && rootBox && ownBox && typeof (n as any).opacity === "number" && (n as any).opacity < 0.999
      && ownBox.width >= rootBox.width - 1 && ownBox.height >= rootBox.height * 0.75) {
      push("R07", "warn", `Полноэкранный полупрозрачный слой "${n.name}" (${Math.round((n as any).opacity * 100)} %).`, n);
    }
    if (n !== root && !insideInstance && n.type !== "INSTANCE" && n.type !== "TEXT" && INTERACTIVE_RE.test(n.name || "")) {
      push("R17", "warn", `"${n.name}" похож на интерактив, но собран не инстансом компонента.`, n);
    }

    if (!insideInstance) {
      const fills = (n as any).fills;
      if (Array.isArray(fills) && fills.some((f: Paint) => f.type === "IMAGE" && f.visible !== false) && !IMAGE_MARKED_RE.test(n.name || "")) {
        push("R21", "warn", `Растровая заливка у "${n.name}" без пометки переменной области.`, n);
      }
      // Величины для R30 копим на весь прогон: «токен такой величины уже есть» видно
      // только если посмотреть, что в выборке к переменным всё-таки привязано.
      const bv = ((n as any).boundVariables || {}) as Record<string, any>;
      // Вне автолейаута эти поля ни на что не влияют, и Fix их не трогает:
      // считать их «отступами мимо дизайн-системы» значило бы обещать привязку, которой не будет.
      const lm = (n as any).layoutMode;
      const laidOut = lm === "HORIZONTAL" || lm === "VERTICAL";
      if (laidOut) for (const k of SPACING_FIELDS) {
        const v = (n as any)[k];
        if (typeof v !== "number" || v === 0) continue;
        if (bv[k]) ctx.scale.add(v); else freeHere.spacing.push(v);
      }
      const rad = (n as any).cornerRadius;
      if (typeof rad === "number" && rad !== 0 && !RADIUS_FIELDS.some((k) => bv[k])) freeHere.radius.push(rad);
    }

    if (!insideInstance && "children" in n) {
      const kids = (n as ChildrenMixin).children as SceneNode[];
      const hasText = kids.some((c) => c.type === "TEXT");
      const layout = (n as any).layoutMode;
      if (n !== root && (n.type === "FRAME" || n.type === "GROUP") && kids.length >= 2 && hasText && (!layout || layout === "NONE")) {
        push("R12", "warn", `"${n.name}" с текстом внутри без auto layout.`, n);
      }
      if (n !== root && GENERIC_NAME_RE.test(n.name || "") && (n.type === "INSTANCE" || hasText)) {
        const better = n.type === "INSTANCE" ? null : suggestedName(n);
        const canRename = !!better && auditWritable(n);
        push("R19", "warn", `"${n.name}" — имя по умолчанию.`, n,
          canRename ? `предлагается "${better}" — переименует кнопка Fix` :
          better ? `подходит "${better}", но слой заблокирован или лежит внутри компонента` :
          "по содержимому имя не вывести — назовите вручную",
          canRename ? { kind: "rename", name: better as string } : undefined);
      }
      // Повторяющийся блок считаем на весь прогон, вывод будет после обхода всех экранов.
      if (n !== root && (n.type === "FRAME" || n.type === "GROUP") && kids.length >= 2 && n.width >= 40) {
        const sig = `${n.name}|${Math.round(n.width)}×${Math.round(n.height)}|${kids.length}`;
        const slot = ctx.repeated.get(sig) || { count: 0, samples: [] as Array<{ node: SceneNode; root: SceneNode }> };
        slot.count++;
        if (slot.samples.length < 20) slot.samples.push({ node: n, root });
        ctx.repeated.set(sig, slot);
      }
      // The audited node itself is never a "wrapper" — removing it would delete the screen.
      if (n !== root && kids.length === 1 && (n.type === "FRAME" || n.type === "GROUP") && wrapperIsPlain(n)) {
        const k = kids[0];
        if (Math.abs(k.width - n.width) < 2 && Math.abs(k.height - n.height) < 2) {
          const clips = !!(n as any).clipsContent;
          push("R28", "hint", `"${n.name}" держит только "${k.name}" того же размера${clips ? ", но обрезает содержимое" : ""}.`, n);
        }
      }
      // GROUP children keep coordinates in the grandparent's space, so insets cannot be measured here.
      const outer = auditRadiusOf(n);
      // У фигуры со скруглениями по углам «внешнего радиуса» нет: сравнивать не с чем.
      if (outer.value && outer.uniform && n.type !== "GROUP" && !auditIsPill(n, outer.value)) {
        for (const k of kids) {
          if (k.visible === false) continue;
          const inner = auditRadiusOf(k);
          if (!inner.value || auditIsPill(k, inner.value)) continue;
          if (inner.value > outer.value + 0.5) {
            push("R31", "hint", `У "${k.name}" радиус ${inner.value} больше внешнего ${outer.value}.`, k);
            continue;
          }
          // Concentricity only makes sense for a child inset evenly on all four sides.
          const gl = k.x, gr = n.width - (k.x + k.width), gt = k.y, gb = n.height - (k.y + k.height);
          const even = Math.abs(gl - gr) < 1.5 && Math.abs(gt - gb) < 1.5 && Math.abs(gl - gt) < 1.5;
          if (!even || gl <= 0.5 || gl >= outer.value) continue;
          const expected = Math.round(outer.value - gl);
          if (Math.abs(inner.value - expected) <= 2) continue;
          const radiusBound = RADIUS_FIELDS.some((f) => ((k as any).boundVariables || {})[f]);
          const canSet = inner.uniform && !radiusBound && auditWritable(k);
          push("R31", "hint", `"${k.name}" R${inner.value} внутри R${outer.value} с отступом ${Math.round(gl)}: ожидалось ${expected}.`, k,
            canSet ? "чинится кнопкой Radius" :
            radiusBound ? "радиус приходит из переменной — менять нужно токен, а не слой" :
            !inner.uniform ? "углы разные, поправьте вручную" : "заблокирован или внутри компонента — поправьте вручную",
            canSet ? { kind: "radius", value: expected } : undefined);
        }
      }
    }

    if (!systemZone && "children" in n) for (const c of (n as ChildrenMixin).children as SceneNode[]) await visit(c, insideInstance || n.type === "INSTANCE");
  };

  await visit(root, false);

  if (isScreen && !hasTopSystem) push("R20", "warn", "Сверху нет слоя Notch или Status bar.", root);
  if (isScreen && !hasBottomSystem) push("R20", "warn", "Снизу нет слоя Home indicator.", root);
  const segs = name.split("/").map((x) => x.trim()).filter(Boolean);
  const stateSeg = NODE_NAME_RE.test(name) && segs.length >= 3 ? segs[segs.length - 2] : null;
  if ((hasStateWidgets || hasStateText) && stateSeg && stateSeg.split(/\s+/).filter(Boolean).length < 2) {
    push("R03", "warn", `Есть переключатели, замки или тексты про доступность, а состояние описано одним словом: "${stateSeg}".`, root);
  }
  if (freeHere.spacing.length || freeHere.radius.length) ctx.free.set(root.id, freeHere);
  return out;
}

// Selection → audit roots. A selected section contributes its frames; nothing selected means the
// top level of the current page. Only frame-like nodes are audited: a sticky note is not a screen.
// Полотно — фрейм шире канвы, внутри которого разложены экраны — раскрывается так же,
// как секция: проверять нужно экраны внутри, а не доску целиком.
function auditRoots(): SceneNode[] {
  const sel = [...figma.currentPage.selection];
  const roots: SceneNode[] = [];
  const frameish = (n: SceneNode) => n.type === "FRAME" || n.type === "COMPONENT" || n.type === "COMPONENT_SET" || n.type === "INSTANCE";
  const take = (n: SceneNode) => {
    if (n.type === "SECTION") { fromSection(n as SectionNode); return; }
    if (!frameish(n)) return;
    if (n.width > BOARD_WIDTH && "children" in n) {
      const kids = ((n as ChildrenMixin).children as SceneNode[]).filter((c) => frameish(c) || c.type === "SECTION");
      if (kids.length) { for (const c of kids) take(c); return; }
    }
    roots.push(n);
  };
  const fromSection = (sec: SectionNode) => { for (const c of sec.children as SceneNode[]) take(c); };
  if (sel.length) for (const n of sel) take(n);
  // Экраны часто разложены по секциям и доскам, поэтому обход страницы заходит и внутрь них.
  else for (const n of figma.currentPage.children as SceneNode[]) take(n);
  return roots;
}

async function collectFindings(roots: SceneNode[], reuse?: TokenMap): Promise<{ findings: Finding[]; tokens: TokenMap; ctx: AuditCtx }> {
  // Обход библиотеки дорогой, поэтому повторная проверка после починки переиспользует карту.
  const tokens = reuse || (await buildTokenMap(roots));
  const ctx = newAuditCtx(roots);
  const findings: Finding[] = [];
  for (const r of roots) findings.push(...(await auditNode(r, tokens, ctx)));

  const late = (rule: string, severity: Finding["severity"], text: string, n: SceneNode, root: SceneNode) =>
    findings.push({ rule, title: AUDIT_TITLES[rule] || rule, severity, text, nodeId: n.id, nodeName: n.name, rootId: root.id, rootName: root.name });

  // Правила, которые видно только на всей выборке сразу.
  for (const slot of ctx.repeated.values()) {
    if (slot.count < REPEAT_THRESHOLD) continue;
    for (const s of slot.samples) late("R29", "hint", `"${s.node.name}" собран руками и повторяется ${slot.count} раз.`, s.node, s.root);
  }
  for (const f of ctx.free.values()) {
    const known = f.spacing.filter((v) => ctx.scale.has(v));
    const off = f.spacing.filter((v) => !ctx.scale.has(v));
    // Чаще всего встречающиеся величины первыми: с них и начинают привязывать.
    const top = (arr: number[]) => {
      const uniq = Array.from(new Set(arr));
      uniq.sort((a, b) => arr.filter((x) => x === b).length - arr.filter((x) => x === a).length);
      return uniq.slice(0, 5).map((v) => `${v}px`).join(", ");
    };
    const parts: string[] = [];
    if (known.length) parts.push(`${known.length} — токен такой величины в выборке уже есть, осталось привязать: ${top(known)}`);
    if (off.length) parts.push(`${off.length} — величины вне шкалы: ${top(off)}`);
    if (f.radius.length) parts.push(`${f.radius.length} — радиусы без токена: ${top(f.radius)}`);
    if (parts.length) late("R30", "hint", "   • " + parts.join("\n   • "), f.root, f.root);
  }
  if (roots.length > 1 && !roots.some((r) => NEGATIVE_STATE_RE.test(r.name || ""))) {
    late("R23", "hint", `Среди ${roots.length} узлов нет имён вроде «Ошибка», «Пусто», «Загрузка», «Тост», «Заблокирован».`, roots[0], roots[0]);
  }

  const rank: Record<string, number> = { block: 0, warn: 1, hint: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { findings, tokens, ctx };
}

// Find has no window of its own: the whole outcome is one toast, and the jump to a problem
// layer stays as a canvas selection. Past this many layers the selection is noise and
// scrollAndZoomIntoView just backs out to the whole page, so the rest is only counted.
const AUDIT_SELECT_LIMIT = 300;

// currentPage.selection only reaches the page that is open; a node from anywhere else (or one
// deleted between the scan and the toast) can be counted but never shown.
function auditOnCurrentPage(n: BaseNode): boolean {
  let p: BaseNode | null = n;
  while (p) {
    if (p.type === "PAGE") return p.id === figma.currentPage.id;
    p = p.parent;
  }
  return false;
}

// ─── Комментарии на макете ──────────────────────────────────────────────
// В Plugin API комментариев нет вообще — ни одного метода. Поэтому ходим в REST
// прямо из плагина: домен разрешён в манифесте, ключ файла даёт figma.fileKey
// (для него нужен enablePrivatePluginApi), токен человек вставляет один раз
// в настройках и он лежит в clientStorage этой машины.

const FIGMA_API = "https://api.figma.com/v1";
// Комментарии группируются: одно правило на одном экране — один комментарий со списком слоёв.
// Поэтому лимит считается в комментариях, а не в находках, и до него доходят только очень
// большие выборки. Раньше лимит стоял на находках, и 40 штук выбирались на трёх-четырёх экранах.
const COMMENT_LIMIT = 150;         // сколько комментариев ставим за один прогон
const COMMENT_LAYER_LIMIT = 8;     // сколько слоёв перечисляем внутри одного комментария
const COMMENT_STEP = 44;           // лесенка: шаг между булавками, которые сели бы в одну точку
const COMMENT_INSET = 16;          // отступ лесенки от левого верхнего угла экрана
const COMMENT_NUDGE = 8;           // насколько булавка отходит от угла проблемного слоя
const DIGEST_LAYER_LIMIT = 6;      // сколько слоёв перечисляем в одном пункте сводки
// digestRules из чек-листа: по каждому месту отдельную булавку не ставим, всё
// собирается в один комментарий «Сборка макета» сверху по центру экрана.
const DIGEST_RULES = ["R16", "R17", "R28", "R29", "R30", "R31"];
const SEV_MARK: Record<string, string> = { block: "⛔", warn: "⚠️", hint: "○" };
const COMMENT_RULE = "─────────────────────";   // разделитель перед подвалом

// Токен уходит в заголовок HTTP, а туда можно только latin-1. При вставке из буфера
// легко прилипает неразрывный пробел или нулевой пробел — и запрос падает с невнятным
// «String contains non ISO-8859-1 code point». Поэтому чистим до печатного ASCII.
function cleanToken(raw: unknown): string {
  let out = "";
  const s = typeof raw === "string" ? raw : "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 33 && c <= 126) out += s[i];   // без пробелов и без всего за пределами ASCII
  }
  return out;
}

async function auditToken(): Promise<string> {
  try {
    return cleanToken(await figma.clientStorage.getAsync("figmaToken"));
  } catch (_e) {
    return "";
  }
}

// Блок, в котором нашлось: ближайший названный контейнер меньше экрана. Нужен, чтобы
// в комментарии было написано, где искать, а не только как называется сам слой.
function blockNameOf(n: SceneNode, root: SceneNode): string {
  const rb = (root as any).absoluteBoundingBox as Rect | null;
  let p: BaseNode | null = n.parent;
  let fallback = "";
  while (p && p.id !== root.id && p.type !== "PAGE" && p.type !== "DOCUMENT") {
    const name = (p as SceneNode).name || "";
    const pb = (p as any).absoluteBoundingBox as Rect | null;
    // Контейнер размером почти во весь экран блоком не считается: иначе блок один
    // на весь макет и комментарии снова схлопываются в один.
    const smaller = !rb || !pb || pb.height < rb.height * 0.8 || pb.width < rb.width * 0.8;
    if (name && smaller) {
      if (!fallback) fallback = name;
      if (!GENERIC_NAME_RE.test(name)) return name;
    }
    p = p.parent;
  }
  return fallback;
}

// Метка в тексте: по ней узнаём свой же комментарий и не вешаем его второй раз.
// Правило + слой, поэтому повторный прогон по тому же месту ничего не добавит.
function commentMarker(rule: string, nodeId: string, block?: string): string {
  // Имя блока входит в маркер: правило на разных блоках одного экрана — разные комментарии.
  const tag = block ? "@" + block.replace(/[\]\n\r]/g, " ").trim().slice(0, 40) : "";
  return "[booster:" + rule + tag + ":" + nodeId + "]";
}

// Комментарий собирается по образцу чек-листа: значок и заголовок капсом, блок,
// в чём суть правила, список слоёв, рекомендация. Разделитель и подвал с маркером
// и датой дописывает интерфейс в момент отправки — он же знает версию файла.
function commentText(group: Finding[]): string {
  const f = group[0];
  const mixed = group.some((g) => g.severity !== f.severity);
  const count: Record<string, number> = {};
  const order: string[] = [];
  for (const g of group) {
    const line = (mixed ? SEV_MARK[g.severity] + " " : "") + g.text + (g.hint ? " — " + g.hint : "");
    if (!count[line]) { count[line] = 0; order.push(line); }
    count[line]++;
  }
  const uniq = order.map((line) => line + (count[line] > 1 ? " ×" + count[line] : ""));

  const lines: string[] = [SEV_MARK[f.severity] + " " + (AUDIT_TITLES[f.rule] || f.rule).toUpperCase()];
  // Блок один на всю группу только если он у всех один — иначе он ничего не подскажет.
  const block = f.block && group.every((g) => g.block === f.block) ? f.block : "";
  if (block) lines.push("блок «" + block + "»");
  const what = AUDIT_WHAT[f.rule];
  if (what) { lines.push(""); lines.push(what); }
  // Находка про сам экран — одна строка, перечислять нечего.
  if (uniq.length === 1 && f.nodeId === f.rootId) {
    lines.push("");
    lines.push(uniq[0]);
  } else {
    lines.push("");
    lines.push(group.length > 1 ? "Слои — " + group.length + ":" : "Слои:");
    for (const line of uniq.slice(0, COMMENT_LAYER_LIMIT)) lines.push("   • " + line);
    if (uniq.length > COMMENT_LAYER_LIMIT) lines.push("   • …ещё " + (uniq.length - COMMENT_LAYER_LIMIT));
  }
  const hint = AUDIT_HINTS[f.rule];
  if (hint) { lines.push(""); lines.push("Рекомендация: " + hint); }
  return lines.join("\n");
}

// Комментарий всегда цепляется к самому экрану, а не к слою внутри: у слоя внутри
// инстанса составной id вида I4041:9063;3233:43784, и REST такой якорь не принимает.
// Положение задаётся смещением от левого верхнего угла экрана.
//   • сводка           — сверху по центру
//   • находка на слое  — у угла самого слоя
//   • находка на экране — лесенкой от угла, чтобы булавки не сели друг на друга
function anchorOnRoot(rootId: string, offset: { x: number; y: number }): any {
  return { node_id: rootId, node_offset: { x: Math.round(offset.x), y: Math.round(offset.y) } };
}

// Смещение слоя относительно экрана. Нет коробки ни у того, ни у другого — садим в угол.
function offsetInRoot(node: SceneNode, root: SceneNode): { x: number; y: number } | null {
  const nb = (node as any).absoluteBoundingBox as Rect | null;
  const rb = (root as any).absoluteBoundingBox as Rect | null;
  if (!nb || !rb) return null;
  return {
    x: Math.max(0, Math.min(nb.x - rb.x + COMMENT_NUDGE, rb.width)),
    y: Math.max(0, Math.min(nb.y - rb.y + COMMENT_NUDGE, rb.height)),
  };
}

// Сводка: по пункту на правило, внутри — слои. Текст берём из тех же таблиц,
// что и у обычных комментариев, чтобы формулировки не разъезжались.
function digestText(groups: Record<string, Finding[]>, order: string[]): string {
  const out: string[] = ["📋 СБОРКА МАКЕТА", "Замечания собраны в один комментарий, по каждому месту отдельный не ставится."];
  for (const rule of order) {
    const group = groups[rule];
    const seen: Record<string, true> = {};
    const lines: string[] = [];
    for (const g of group) {
      const line = g.text + (g.hint ? " — " + g.hint : "");
      if (seen[line]) continue;
      seen[line] = true;
      lines.push(line);
    }
    const head = "▸ " + (AUDIT_TITLES[rule] || rule) + (lines.length > 1 ? " — " + lines.length : "");
    const shown = lines.slice(0, DIGEST_LAYER_LIMIT).map((x) => "   • " + x);
    if (lines.length > DIGEST_LAYER_LIMIT) shown.push("   • …ещё " + (lines.length - DIGEST_LAYER_LIMIT));
    out.push("");
    out.push(head);
    for (const line of shown) out.push(line);
    const hint = AUDIT_HINTS[rule];
    if (hint) out.push("   Рекомендация: " + hint);
  }
  return out.join("\n");
}

// Сеть в плагине доступна ТОЛЬКО из интерфейса: в песочнице главного потока
// fetch отсутствует. Поэтому здесь мы лишь готовим посылку, а ходит за нас ui.html —
// ровно как это уже сделано для перевода.
async function requestAuditComments(findings: Finding[]): Promise<string> {
  if (!findings.length) return "";
  const token = await auditToken();
  if (!token) return "no comments — add a Figma token in Settings";
  // Длина в сообщении, иначе непонятно, что именно лежит в хранилище.
  if (token.length < 20) return "no comments — saved token is only " + token.length + " characters, paste it again in Settings";
  const key = figma.fileKey;
  if (!key) return "no comments — reimport the plugin from manifest";

  // Раскладка повторяет чек-лист: сводка сверху по центру экрана, находка на слое —
  // у самого слоя, общая по экрану — лесенкой от левого верхнего угла.
  // Якорь у всех один и тот же — сам экран; различает их только смещение.
  const roots: Record<string, SceneNode> = {};
  const byRoot: string[] = [];
  const digest: Record<string, { order: string[]; groups: Record<string, Finding[]> }> = {};
  const pinned: Record<string, { order: string[]; groups: Record<string, Finding[]> }> = {};

  for (const f of findings) {
    if (!roots[f.rootId]) {
      const r = await figma.getNodeByIdAsync(f.rootId);
      if (!r || r.removed || !("type" in r)) continue;
      roots[f.rootId] = r as SceneNode;
      byRoot.push(f.rootId);
      digest[f.rootId] = { order: [], groups: {} };
      pinned[f.rootId] = { order: [], groups: {} };
    } else if (!roots[f.rootId]) continue;
    if (DIGEST_RULES.indexOf(f.rule) >= 0) {
      // В сводке блок не различаем: она одна на экран по своей сути.
      const d = digest[f.rootId];
      if (!d.groups[f.rule]) { d.groups[f.rule] = []; d.order.push(f.rule); }
      d.groups[f.rule].push(f);
      continue;
    }
    // Остальное режем ещё и по блоку: так это делает чек-лист — комментарий садится
    // на каждый проблемный блок, а не один на весь экран.
    const key = f.rule + "|" + (f.block || "");
    const b = pinned[f.rootId];
    if (!b.groups[key]) { b.groups[key] = []; b.order.push(key); }
    b.groups[key].push(f);
  }

  const items: any[] = [];
  for (const rootId of byRoot) {
    const root = roots[rootId];
    const rb = (root as any).absoluteBoundingBox as Rect | null;
    const width = rb ? rb.width : root.width;

    // Сводка — сверху по центру. Одна на экран, сколько бы правил в неё ни попало.
    const d = digest[rootId];
    if (d.order.length) {
      items.push({
        marker: commentMarker("DIGEST", rootId),
        message: digestText(d.groups, d.order),
        client_meta: anchorOnRoot(rootId, { x: width / 2, y: 0 }),
      });
    }

    // Остальное — булавками. Находки уже отсортированы по серьёзности, порядок групп
    // наследует её: если лимит упрётся, блокирующее успеет встать первым.
    let slot = 0;
    for (const key of pinned[rootId].order) {
      const group = pinned[rootId].groups[key];
      const rule = group[0].rule;
      let offset: { x: number; y: number } | null = null;
      for (const g of group) {
        if (g.nodeId === rootId) break;                  // находка про сам экран — в лесенку
        const node = await figma.getNodeByIdAsync(g.nodeId);
        if (!node || node.removed || !("type" in node)) continue;
        offset = offsetInRoot(node as SceneNode, root);
        if (offset) break;
      }
      if (!offset) offset = { x: COMMENT_INSET, y: COMMENT_INSET + slot++ * COMMENT_STEP };
      items.push({
        marker: commentMarker(rule, rootId, group[0].block),
        message: commentText(group),
        client_meta: anchorOnRoot(rootId, offset),
      });
    }
  }

  if (!items.length) return "";
  figma.ui.postMessage({ type: "start-comments", token: token, fileKey: key, items: items, limit: COMMENT_LIMIT });
  return "comments are being posted…";
}

// Уборка своих комментариев. Своими считаем только те, в тексте которых стоит маркер
// [booster:…] — его руками никто не напишет. Комментарий, на который кто-то ответил,
// не трогаем: Figma удаляет ветку целиком вместе с чужим ответом.
// Удаление необратимо, поэтому первое нажатие только считает, второе удаляет.
let cleanArmed = false;

async function requestCommentCleanup(): Promise<void> {
  const token = await auditToken();
  if (!token) { sendStatus("Comments — add a Figma token in Settings first", "error", false, true); return; }
  const key = figma.fileKey;
  if (!key) { sendStatus("Comments — reimport the plugin from manifest", "error", false, true); return; }
  figma.ui.postMessage({ type: "start-clean", token: token, fileKey: key, confirm: cleanArmed });
}

// Словарь лежит в интерфейсе — в песочнице его разворачивать негде и незачем.
// Отправляем туда редкие слова и ждём ответ. Ответа нет за полминуты — идём дальше
// без орфографии: проверка не должна висеть из-за словаря.
let spellPending: ((bad: string[]) => void) | null = null;
let spellNote = "";

function requestSpellCheck(ctx: AuditCtx): Promise<Finding[]> {
  const rare: string[] = [];
  // Продуктовую лексику узнаём по повторам: «Кешбэк» на двадцати экранах — своё слово,
  // а не ошибка. Поэтому словарю показываем только то, что встретилось раз-другой.
  ctx.words.forEach((v, w) => { if (v.count < WORD_KNOWN_AT) rare.push(w); });
  spellNote = "";
  if (!rare.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    let done = false;
    const finish = (bad: string[], error?: string) => {
      if (done) return;
      done = true;
      spellPending = null;
      if (error) spellNote = " · spelling skipped: " + error;
      const out: Finding[] = [];
      for (const w of bad) {
        const slot = ctx.words.get(w);
        if (!slot) continue;
        out.push({
          rule: "B03", title: AUDIT_TITLES.B03, severity: "warn",
          text: `"${w}" — такого слова нет в словаре.`,
          nodeId: slot.node.id, nodeName: slot.node.name,
          rootId: slot.root.id, rootName: slot.root.name,
        });
      }
      resolve(out);
    };
    spellPending = (bad) => finish(bad);
    figma.ui.postMessage({ type: "start-spell", words: rare });
    setTimeout(() => finish([], "the dictionary did not answer in 30 seconds"), 30000);
  });
}

async function runAudit(): Promise<void> {
  const roots = auditRoots();
  if (!roots.length) { sendStatus("Nothing to check — select a screen or a block", "error"); return; }
  sendStatus("Checking…", "", true);
  // Скрытые слои внутри инстансов обход всё равно отбрасывает: не заставляем Figma их создавать.
  // Флаг глобальный, поэтому поднимаем его ровно на время обхода и возвращаем обратно —
  // оставленный поднятым, он спрятал бы скрытые инстансы от Replace и Swap all.
  const wasSkipping = figma.skipInvisibleInstanceChildren;
  let scan: { findings: Finding[]; tokens: TokenMap; ctx: AuditCtx };
  try {
    figma.skipInvisibleInstanceChildren = true;
    scan = await collectFindings(roots);
  } finally {
    figma.skipInvisibleInstanceChildren = wasSkipping;
  }
  const { findings, tokens } = scan;
  // Орфография: ответ приходит из интерфейса, поэтому ждём его до подсчёта и сортировки.
  const spelled = await requestSpellCheck(scan.ctx);
  if (spelled.length) {
    findings.push(...spelled);
    const rank: Record<string, number> = { block: 0, warn: 1, hint: 2 };
    findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }
  const blocks = findings.filter((f) => f.severity === "block").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  const hints = findings.filter((f) => f.severity === "hint").length;
  const fixable = findings.filter((f) => f.fix).length;

  // findings are already sorted worst-first, so a capped selection keeps the blocking ones.
  // One layer can carry several findings — it is selected once.
  // Сначала раскладываем по экранам, потом берём поровну с каждого: иначе весь лимит
  // съедает первый экран, и на остальных дизайнер не видит выделенным ничего.
  const byRoot: Array<{ root: string; nodes: SceneNode[] }> = [];
  const rootSlot: Record<string, SceneNode[]> = {};
  const seenNodes = new Set<string>();
  let offPage = 0, hidden = 0, selectable = 0;
  for (const f of findings) {
    if (seenNodes.has(f.nodeId)) continue;
    seenNodes.add(f.nodeId);
    const node = await figma.getNodeByIdAsync(f.nodeId);
    if (!node || node.removed || !("type" in node) || node.type === "PAGE" || node.type === "DOCUMENT") continue;
    if (!auditOnCurrentPage(node)) { offPage++; continue; }
    selectable++;
    if (!rootSlot[f.rootId]) { rootSlot[f.rootId] = []; byRoot.push({ root: f.rootId, nodes: rootSlot[f.rootId] }); }
    rootSlot[f.rootId].push(node as SceneNode);
  }
  const picked: SceneNode[] = [];
  for (let round = 0; picked.length < AUDIT_SELECT_LIMIT; round++) {
    let addedThisRound = 0;
    for (const slot of byRoot) {
      if (round >= slot.nodes.length) continue;
      if (picked.length >= AUDIT_SELECT_LIMIT) break;
      picked.push(slot.nodes[round]);
      addedThisRound++;
    }
    if (!addedThisRound) break;
  }
  hidden = selectable - picked.length;
  if (picked.length) {
    figma.currentPage.selection = picked;
    // Зум по сотне слоёв с разных экранов просто отъезжает на всю страницу — толку ноль.
    if (picked.length <= 30) figma.viewport.scrollAndZoomIntoView(picked);
  }

  const note = (tokens.libraryScanTruncated ? ` · library scan capped at ${LIBRARY_SCAN_LIMIT} colours` : "") + spellNote;
  if (!findings.length) {
    sendStatus(`Audit — no findings on ${plural(roots.length, "node", "nodes")}${note}`, "success");
    return;
  }
  // Комментарии на самом макете: правило, что не так и рекомендация — в том месте,
  // где нашлось. Итог по ним придёт отдельным тостом, когда интерфейс отработает.
  const commentNote = await requestAuditComments(findings);

  // Сколько экранов реально прошли — первым делом: именно этого числа не хватало,
  // когда казалось, что проверка обрывается на нескольких макетах.
  const parts = [`Audit — ${plural(findings.length, "finding", "findings")} on ${plural(roots.length, "node", "nodes")}`];
  if (blocks) parts.push(`${blocks} blocking`);
  if (warns) parts.push(plural(warns, "warning", "warnings"));
  if (hints) parts.push(plural(hints, "hint", "hints"));
  if (fixable) parts.push(`${fixable} auto-fixable`);
  if (hidden) parts.push(`showing first ${picked.length}`);
  if (offPage) parts.push(`${offPage} on other pages`);
  if (commentNote) parts.push(commentNote);
  sendStatus(parts.join(" · ") + note, "");
}

// ─── Fix: привязка значений ───────────────────────────────────────────────
// Смысл всей правки: привязка переменной, значение которой РАВНО текущему литералу, не двигает
// ни одного пикселя. Это и есть критерий безопасности, и другого здесь нет.
//   • кандидаты берутся живыми — локальные переменные плюс библиотечные, каталог не зашит;
//   • годится только FLOAT, который даёт ОДНО И ТО ЖЕ число во всех режимах своей коллекции
//     (алиасы разворачиваются): иначе «точно такое же» значение уедет в другом режиме;
//   • сравнение точное, без округлений и «почти совпадает»;
//   • скоуп переменной снимает неоднозначность: отступ 8 и радиус 8 не путаются, потому что у
//     первого требуется GAP, у второго CORNER_RADIUS. ALL_SCOPES подходит везде;
//   • если после фильтра по скоупу кандидатов больше одного — пропускаем и считаем в отчёт;
//   • пишем только в auditWritable-узлы, как уже сделано для цвета.

const VALUE_SCAN_LIMIT = 300;

type ValueField = VariableBindableNodeField | VariableBindableTextField;
type ValueToken = { id: string; name: string; scopes: ReadonlyArray<VariableScope> };
type ValueIndex = Map<number, ValueToken[]>;
// Одно поле или группа полей, которым подходит один и тот же токен (однородный радиус — все
// четыре угла сразу). Одна цель = одно значение в отчёте.
type ValueTarget = { fields: ValueField[]; value: number; scope: VariableScope };

// Точная сигнатура текущего API: setBoundVariable(field, Variable | null).
// Вариант с id устарел и падает при documentAccess: dynamic-page.
type ValueBindable = { setBoundVariable(field: ValueField, variable: Variable | null): void };

async function floatOfValue(val: any, depth: number): Promise<number | null> {
  if (typeof val === "number") return val;
  if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS" && depth < 5) {
    const target = await figma.variables.getVariableByIdAsync(String(val.id));
    if (!target) return null;
    return await stableFloatOfVariable(target, depth + 1);
  }
  return null;
}

// Число токена, если оно одинаково во ВСЕХ режимах коллекции. Иначе null — такой токен непригоден.
async function stableFloatOfVariable(v: Variable, depth: number): Promise<number | null> {
  if (v.resolvedType !== "FLOAT") return null;
  const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
  if (!col || !col.modes.length) return null;
  let value: number | null = null;
  for (const m of col.modes) {
    const n = await floatOfValue(v.valuesByMode[m.modeId], depth);
    if (n === null) return null;
    if (value === null) value = n;
    else if (value !== n) return null;
  }
  return value;
}

// Каталог строится заново на каждый прогон: переменную могли поменять между запусками плагина.
async function buildValueIndex(): Promise<ValueIndex> {
  const index: ValueIndex = new Map<number, ValueToken[]>();
  const seen = new Set<string>();

  const add = async (v: Variable) => {
    if (seen.has(v.id)) return;
    seen.add(v.id);
    const value = await stableFloatOfVariable(v, 0);
    if (value === null) return;
    const list = index.get(value) || [];
    list.push({ id: v.id, name: v.name, scopes: v.scopes });
    index.set(value, list);
  };

  for (const v of await figma.variables.getLocalVariablesAsync("FLOAT")) await add(v);

  try {
    let imported = 0;
    for (const col of await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()) {
      const vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
      for (const lv of vars) {
        if (lv.resolvedType !== "FLOAT") continue;
        if (imported >= VALUE_SCAN_LIMIT) break;
        imported++;
        // Отдельный try на каждый импорт: один отказ не должен обрывать обход библиотеки.
        try {
          const v = await figma.variables.importVariableByKeyAsync(lv.key);
          if (v) await add(v);
        } catch (_e) { /* недоступный токен пропускаем */ }
      }
      if (imported >= VALUE_SCAN_LIMIT) break;
    }
  } catch (_e) {
    // Нет доступа к библиотекам (черновик, офлайн) — работаем по локальным переменным.
  }

  return index;
}

function valueScopeFits(scopes: ReadonlyArray<VariableScope>, want: VariableScope): boolean {
  if (!scopes.length) return true; // пустой список Figma трактует как ALL_SCOPES
  return scopes.indexOf("ALL_SCOPES") >= 0 || scopes.indexOf(want) >= 0;
}

const GAP_FIELDS: ValueField[] = ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"];
const CORNER_FIELDS: ValueField[] = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"];
const STROKE_SIDE_FIELDS: ValueField[] = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"];

// Какие числа на узле вообще можно привязать. Ноль пропускаем: «ноль как токен» почти всегда
// не то, что человек имел в виду, а безопасность правки от этого не выигрывает.
function auditValueTargets(n: SceneNode): ValueTarget[] {
  const a = n as any;
  const bv = (a.boundVariables || {}) as Record<string, any>;
  const free = (f: string) => { const b = bv[f]; return !b || (Array.isArray(b) && !b.length); };
  const num = (x: any) => typeof x === "number" && isFinite(x) && x > 0;
  const out: ValueTarget[] = [];

  // Отступы и промежутки живут только в автолейауте — вне его эти поля ни на что не влияют.
  if (a.layoutMode === "HORIZONTAL" || a.layoutMode === "VERTICAL") {
    for (const f of GAP_FIELDS) if (num(a[f]) && free(f)) out.push({ fields: [f], value: a[f], scope: "GAP" });
    // При SPACE_BETWEEN промежуток считает сама Figma, записанное число не применяется.
    if (a.primaryAxisAlignItems !== "SPACE_BETWEEN" && num(a.itemSpacing) && free("itemSpacing")) {
      out.push({ fields: ["itemSpacing"], value: a.itemSpacing, scope: "GAP" });
    }
    // То же самое по поперечной оси: при SPACE_BETWEEN между рядами число не применяется.
    if (a.layoutWrap === "WRAP" && a.counterAxisAlignContent !== "SPACE_BETWEEN"
        && num(a.counterAxisSpacing) && free("counterAxisSpacing")) {
      out.push({ fields: ["counterAxisSpacing"], value: a.counterAxisSpacing, scope: "GAP" });
    }
  }

  // Скругления: одинаковые углы — один токен на все четыре, разные — каждый угол сам за себя.
  // Таблетку пропускаем: там число значит «скруглить полностью», и совпавший токен оказался бы
  // привязан к величине, которую Figma всё равно зажимает по высоте слоя.
  // Сам cornerRadius к переменной не привязывается — в Plugin API биндятся только четыре угла.
  // У эллипса, звезды и многоугольника их нет, поэтому привязать радиус там невозможно:
  // раньше запись в несуществующее поле падала и молча уходила в счётчик пропущенных.
  if ("topLeftRadius" in n && free("cornerRadius")) {
    if (num(a.cornerRadius) && CORNER_FIELDS.every(free) && !auditIsPill(n, a.cornerRadius)) {
      out.push({ fields: CORNER_FIELDS.slice(), value: a.cornerRadius, scope: "CORNER_RADIUS" });
    } else if (a.cornerRadius === figma.mixed) {
      for (const f of CORNER_FIELDS) if (num(a[f]) && free(f)) out.push({ fields: [f], value: a[f], scope: "CORNER_RADIUS" });
    }
  }

  // Толщина обводки — только если обводка вообще есть и хотя бы одна краска видима,
  // иначе привязка висит ни на чём: толщина записана, а показать её нечем.
  if (Array.isArray(a.strokes) && a.strokes.some((p: any) => p && p.visible !== false)) {
    if (num(a.strokeWeight) && free("strokeWeight")) {
      out.push({ fields: ["strokeWeight"], value: a.strokeWeight, scope: "STROKE_FLOAT" });
    } else if (a.strokeWeight === figma.mixed) {
      for (const f of STROKE_SIDE_FIELDS) if (num(a[f]) && free(f)) out.push({ fields: [f], value: a[f], scope: "STROKE_FLOAT" });
    }
  }

  // Текст: кегль и интерлиньяж. Интерлиньяж — только в пикселях: проценты и AUTO сравнивать не с чем.
  // Узел под текстовым стилем не трогаем совсем: переменная поверх стиля — это оверрайд, то есть
  // ровно то расхождение с китом, которое аудит и ищет.
  if (n.type === "TEXT" && !a.textStyleId) {
    if (num(a.fontSize) && free("fontSize")) out.push({ fields: ["fontSize"], value: a.fontSize, scope: "FONT_SIZE" });
    const lh = a.lineHeight;
    if (lh && typeof lh === "object" && lh.unit === "PIXELS" && num(lh.value) && free("lineHeight")) {
      out.push({ fields: ["lineHeight"], value: lh.value, scope: "LINE_HEIGHT" });
    }
  }

  return out;
}

// Запись в текстовый узел меняет раскладку строки, поэтому шрифт должен быть загружен.
async function auditLoadFonts(t: TextNode): Promise<boolean> {
  try {
    const fn = t.fontName;
    if (fn === figma.mixed) {
      for (const seg of t.getStyledTextSegments(["fontName"])) await figma.loadFontAsync(seg.fontName as FontName);
    } else {
      await figma.loadFontAsync(fn as FontName);
    }
    return true;
  } catch (_e) {
    return false;
  }
}

type ValueRun = { bound: number; noToken: number; ambiguous: number; skipped: number };

async function auditBindValues(roots: SceneNode[]): Promise<ValueRun> {
  const run: ValueRun = { bound: 0, noToken: 0, ambiguous: 0, skipped: 0 };
  const index = await buildValueIndex();
  if (!index.size) return run;

  const varCache = new Map<string, Variable | null>();
  const varById = async (id: string): Promise<Variable | null> => {
    const hit = varCache.get(id);
    if (hit !== undefined) return hit;
    let v: Variable | null = null;
    try { v = await figma.variables.getVariableByIdAsync(id); } catch (_e) { v = null; }
    varCache.set(id, v);
    return v;
  };

  const fontsLoaded = new Set<string>();

  const visit = async (n: SceneNode) => {
    if (auditWritable(n)) {
      for (const t of auditValueTargets(n)) {
        const cands = (index.get(t.value) || []).filter((c) => valueScopeFits(c.scopes, t.scope));
        if (!cands.length) { run.noToken++; continue; }
        if (cands.length > 1) { run.ambiguous++; continue; }
        const v = await varById(cands[0].id);
        if (!v) { run.skipped++; continue; }
        if (n.type === "TEXT" && !fontsLoaded.has(n.id)) {
          if (!(await auditLoadFonts(n as TextNode))) { run.skipped++; continue; }
          fontsLoaded.add(n.id);
        }
        try {
          for (const f of t.fields) (n as unknown as ValueBindable).setBoundVariable(f, v);
          run.bound++;
        } catch (_e) {
          run.skipped++;
        }
      }
    }
    // Внутрь компонента, набора вариантов и инстанса не заходим: писать там нельзя, правка
    // мастера разошлась бы по всему файлу.
    if (n.type === "INSTANCE" || n.type === "COMPONENT" || n.type === "COMPONENT_SET") return;
    if ("children" in n) for (const c of (n as ChildrenMixin).children as SceneNode[]) await visit(c);
  };

  for (const r of roots) await visit(r);
  return run;
}

// Applies only writes that cannot move, delete or restyle anything: binding a paint, a gap, a
// radius, a stroke weight or a text size to a variable that already carries exactly that value.
// Nothing is nudged, so no pixel moves. The radius geometry fix lives on its own button.
async function runAuditFix(): Promise<void> {
  const roots = auditRoots();
  if (!roots.length) { sendStatus("Nothing to fix — select a screen or a block", "error"); return; }
  sendStatus("Fixing…", "", true);
  const { findings } = await collectFindings(roots);
  let bound = 0, skipped = 0;

  // Один Cmd+Z на прогон: отсекаем всё, что плагин делал раньше, и кладём точку возврата.
  // Без commitUndo правки сливаются в общую пачку со всем, что было с прошлого коммита.
  await stylesBeginWrite("Booster — Audit Fix");

  for (const f of findings) {
    if (!f.fix || f.fix.kind !== "bindPaint") continue;
    const node = await figma.getNodeByIdAsync(f.nodeId);
    if (!node || node.removed || !("type" in node)) { skipped++; continue; }
    const n = node as SceneNode;
    try {
      const fix = f.fix;
      const v = await figma.variables.getVariableByIdAsync(fix.variableId);
      const list = (n as any)[fix.target];
      if (!v || !Array.isArray(list)) { skipped++; continue; }
      const copy = (list as Paint[]).slice();
      const paint = copy[fix.index];
      // Перепроверка на момент записи: цвет с прозрачностью, отсутствие привязки и право писать.
      if (!paint || paint.type !== "SOLID" || paintKey(paint as SolidPaint) !== fix.key || paintBinding(paint) || !auditWritable(n)) { skipped++; continue; }
      copy[fix.index] = figma.variables.setBoundVariableForPaint(paint as SolidPaint, "color", v);
      (n as any)[fix.target] = copy;
      bound++;
    } catch (_e) { skipped++; }
  }

  // Переименование безымянных фреймов. Имя пересчитывается на момент записи и разводится
  // с соседями: два «Войти» в одном родителе читаются в отчёте одинаково и путают.
  let renamed = 0;
  for (const f of findings) {
    if (!f.fix || f.fix.kind !== "rename") continue;
    const node = await figma.getNodeByIdAsync(f.nodeId);
    if (!node || node.removed || !("type" in node)) { skipped++; continue; }
    const nd = node as SceneNode;
    // Перепроверка на момент записи: имя всё ещё генерик, слой писуч, содержимое не изменилось.
    if (!GENERIC_NAME_RE.test(nd.name || "") || !auditWritable(nd)) { skipped++; continue; }
    const base = suggestedName(nd);
    if (!base) { skipped++; continue; }
    try {
      let name = base;
      const siblings = nd.parent && "children" in nd.parent
        ? ((nd.parent as ChildrenMixin).children as SceneNode[]).filter((k) => k !== nd).map((k) => k.name)
        : [];
      for (let i = 2; siblings.indexOf(name) >= 0 && i < 100; i++) name = base + " " + i;
      nd.name = name;
      renamed++;
    } catch (_e) { skipped++; }
  }

  const vals = await auditBindValues(roots);
  bound += vals.bound;
  skipped += vals.skipped;

  const parts: string[] = [bound ? `Bound ${plural(bound, "value", "values")}` : "Nothing that can be bound safely"];
  if (renamed) parts.push(`${plural(renamed, "layer", "layers")} renamed`);
  if (vals.noToken) parts.push(`${vals.noToken} had no token`);
  if (vals.ambiguous) parts.push(`${vals.ambiguous} ambiguous`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (bound) figma.commitUndo();   // закрываем шаг: весь прогон откатывается одним Cmd+Z
  sendStatus(parts.join(" · "), bound ? "success" : "error");
}

// Радиус — отдельная кнопка: в отличие от привязки, он МЕНЯЕТ число на слое, поэтому решение
// «чинить ли скругления» человек принимает сам, а не заодно с привязкой значений.
// Логика прежняя: только однородные углы, без существующей привязки к переменной, значение
// пересчитывается на момент записи, пишем только в auditWritable-узлы.
async function runAuditFixRadius(): Promise<void> {
  const roots = auditRoots();
  if (!roots.length) { sendStatus("Nothing to fix — select a screen or a block", "error"); return; }
  sendStatus("Fixing radii…", "", true);
  const { findings } = await collectFindings(roots);
  let radii = 0, skipped = 0;

  if (findings.some((f) => f.fix && f.fix.kind === "radius")) await stylesBeginWrite("Booster — Radius");

  for (const f of findings) {
    if (!f.fix || f.fix.kind !== "radius") continue;
    const node = await figma.getNodeByIdAsync(f.nodeId);
    if (!node || node.removed || !("type" in node)) { skipped++; continue; }
    const n = node as SceneNode;
    try {
      // Ожидаемое значение пересчитывается по живому родителю: правка соседнего узла в этом же
      // прогоне могла сделать посчитанное раньше число неверным.
      const parent = n.parent;
      if (!parent || !("type" in parent) || !auditWritable(n)) { skipped++; continue; }
      const pn = parent as SceneNode;
      const outer = auditRadiusOf(pn), inner = auditRadiusOf(n);
      if (!outer.value || !outer.uniform || !inner.uniform || pn.type === "GROUP" || auditIsPill(pn, outer.value)) { skipped++; continue; }
      const gl = n.x, gr = pn.width - (n.x + n.width), gt = n.y, gb = pn.height - (n.y + n.height);
      const even = Math.abs(gl - gr) < 1.5 && Math.abs(gt - gb) < 1.5 && Math.abs(gl - gt) < 1.5;
      const expected = Math.round(outer.value - gl);
      if (!even || gl <= 0.5 || gl >= outer.value || Math.abs(inner.value - expected) <= 2) { skipped++; continue; }
      if ("cornerRadius" in n && typeof (n as any).cornerRadius === "number") { (n as any).cornerRadius = expected; radii++; } else skipped++;
    } catch (_e) { skipped++; }
  }

  let line = radii ? `Radius fixed on ${plural(radii, "layer", "layers")}` : "No radius to fix";
  if (skipped) line += ` · ${skipped} skipped`;
  if (radii) figma.commitUndo();   // один Cmd+Z на прогон
  sendStatus(line, radii ? "success" : "error");
}

// ─── Styles: hand-set colour ⇄ design-system token ───────────────────────
// Two one-way operations, deliberately kept apart:
//
//   Delete — takes every colour binding off a layer (paint / stroke / effect style, variables
//            bound to paints, to gradient stops and to effect colours) and leaves exactly the
//            colour that is on screen right now, as a plain hex.
//   Fix    — the opposite direction: a layer whose colour was typed in by hand gets bound to the
//            colour token (local or library variable) that carries that exact colour. Exact
//            matches only, never "close".
//
// Both run in two steps — a scan that writes nothing and shows what is about to happen, and an
// apply the person confirms. Apply works from the scan's plan, and every single write is
// re-checked against the live node first, so a selection change between the two steps can never
// make the plugin write something the person did not see in the confirmation.
//
// ── Why the colour cannot shift (Delete) ──
// A SolidPaint in the plugin API carries ONE alpha: `color` is RGB only and `opacity` holds the
// whole transparency of that paint. A colour variable carries RGBA, and while it is bound Figma
// renders the token's alpha AS the paint's opacity — that is why the opacity field in the UI goes
// read-only and shows the token's percentage. So literalising means REPLACING opacity with the
// resolved alpha, never multiplying the two: multiplying would quietly fade every bound paint
// whose stored fallback opacity is not 1. Gradient stops and effect colours are RGBA end to end,
// so their alpha simply carries over. Node-level `opacity`, blend modes, masks and textStyleId
// are never touched, so the composite is unchanged.
// The resolved value is read with Variable.resolveForConsumer(node) — the only API that resolves
// aliases AND the node's own mode context, i.e. the exact colour the person is looking at.

// One candidate token for Fix. Nothing about any design system is embedded in the plugin: the
// catalogue is built at run time from what the open file already has —
//   • the file's own colour variables, and
//   • every library colour variable that is bound somewhere in the document.
// A library variable nobody in this file uses yet is not considered: reading its value would mean
// importing it, and the plugin never imports a variable just to look at it.
// n = name, id = variable id (bound directly, no import), v = value per mode in catalogue spelling
// ("#RRGGBB" or "#RRGGBB@NN%", aliases followed), s = scopes, t = theme-dependent,
// r = comes from a library, u = how many bindings in this document already use it.
type ColourToken = { n: string; id: string; v: string[]; s: string; t: boolean; r: boolean; u: number };

// A walk over every page can be long on a huge file; past this many layers the usage counts are
// good enough to rank by, and the run moves on.
const TOKEN_USAGE_NODE_LIMIT = 300000;

function countAliasIds(o: any, out: Map<string, number>, depth: number): void {
  if (!o || typeof o !== "object" || depth > 4) return;
  if (Array.isArray(o)) { for (const x of o) countAliasIds(x, out, depth + 1); return; }
  if (o.type === "VARIABLE_ALIAS" && typeof o.id === "string") {
    out.set(o.id, (out.get(o.id) || 0) + 1);
    return;
  }
  for (const k of Object.keys(o)) countAliasIds(o[k], out, depth + 1);
}

// Variable id → number of bindings in the whole document, current page first. Paint, stroke,
// effect and text-range bindings come from node.boundVariables; gradient stops carry theirs on
// the stop itself, so those are read from the paints.
async function documentVariableUsage(): Promise<Map<string, number>> {
  const uses = new Map<string, number>();
  try { await figma.loadAllPagesAsync(); } catch (_e) { /* pages already loaded */ }
  const current = figma.currentPage;
  const pages: PageNode[] = [current];
  for (const p of figma.root.children) if (p !== current) pages.push(p);

  let seen = 0;
  for (const page of pages) {
    const stack: SceneNode[] = [];
    for (let i = page.children.length - 1; i >= 0; i--) stack.push(page.children[i]);
    while (stack.length) {
      if (seen >= TOKEN_USAGE_NODE_LIMIT) return uses;
      const n = stack.pop() as SceneNode;
      seen++;
      try {
        const a = n as any;
        countAliasIds(a.boundVariables, uses, 0);
        for (const prop of ["fills", "strokes"]) {
          const list = prop in n ? a[prop] : null;
          if (!Array.isArray(list)) continue;
          for (const p of list) {
            if (!p || typeof p.type !== "string" || p.type.indexOf("GRADIENT") !== 0) continue;
            for (const s of p.gradientStops || []) {
              const id = boundColourId(s);
              if (id) uses.set(id, (uses.get(id) || 0) + 1);
            }
          }
        }
      } catch (_e) { /* one unreadable node never stops the walk */ }
      if ("children" in n) {
        const kids = (n as ChildrenMixin).children as SceneNode[];
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      }
      if (seen % 2000 === 0) await stylesYield();
    }
  }
  return uses;
}

// Every colour a variable can resolve to, in catalogue spelling: each mode, aliases followed
// through every mode of the target. A superset on purpose — the catalogue only nominates
// candidates; the binding itself is accepted only after the token is resolved against the node.
async function variableColourValues(v: Variable, depth: number, out: Set<string>): Promise<void> {
  if (depth > 4) return;
  for (const k of Object.keys(v.valuesByMode)) {
    const val: any = v.valuesByMode[k];
    if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS") {
      const target = await stylesVarById(String(val.id));
      if (target) await variableColourValues(target, depth + 1, out);
    } else if (val && typeof val === "object" && "r" in val) {
      out.add(colourKey(val as RGB, typeof val.a === "number" ? val.a : 1));
    }
  }
}

// Catalogue value → tokens carrying it. Built once per Fix run. Several tokens can share a value;
// the tie-breakers in fixRank decide which one wins.
async function buildColourCatalogue(): Promise<{ index: Map<string, ColourToken[]>; size: number }> {
  const uses = await documentVariableUsage();
  const vars = new Map<string, Variable>();
  try {
    for (const v of await figma.variables.getLocalVariablesAsync("COLOR")) {
      vars.set(v.id, v);
      stylesVarCache.set(v.id, v);
    }
  } catch (_e) { /* no local variables readable — library ones still count */ }
  for (const id of Array.from(uses.keys())) {
    if (vars.has(id)) continue;
    const v = await stylesVarById(id);
    if (v && v.resolvedType === "COLOR") vars.set(id, v);
  }

  const index = new Map<string, ColourToken[]>();
  let size = 0;
  for (const v of Array.from(vars.values())) {
    const values = new Set<string>();
    try { await variableColourValues(v, 0, values); } catch (_e) { continue; }
    if (!values.size) continue;
    const tok: ColourToken = {
      n: v.name, id: v.id, v: Array.from(values),
      s: (v.scopes || []).join(", "),
      t: await variableIsThemed(v.id, 0),
      r: !!v.remote,
      u: uses.get(v.id) || 0,
    };
    size++;
    for (const key of tok.v) {
      const list = index.get(key) || [];
      list.push(tok);
      index.set(key, list);
    }
  }
  return { index, size };
}

// Which slot a colour sits in. A token may only be bound where its scopes allow it, otherwise
// Figma hides it from that picker and the binding is a lie waiting to confuse the next designer.
type ColourSlot = "fill" | "textFill" | "stroke" | "effect";

function tokenFitsSlot(tok: ColourToken, slot: ColourSlot): boolean {
  const s = tok.s.toUpperCase();
  const has = (x: string) => s.indexOf(x) >= 0;
  if (has("ALL_SCOPES")) return true;
  if (slot === "stroke") return has("STROKE");
  if (slot === "effect") return has("EFFECT_COLOR");
  if (slot === "textFill") return has("ALL_FILLS") || has("TEXT_FILL");
  return has("ALL_FILLS") || has("FRAME_FILL") || has("SHAPE_FILL");
}

function stylesHex6(c: RGB): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return ("#" + h(c.r) + h(c.g) + h(c.b)).toUpperCase();
}

// The catalogue's own spelling: "#RRGGBB" at full opacity, "#RRGGBB@NN%" otherwise.
function colourKey(c: RGB, alpha: number): string {
  const pct = Math.round(Math.max(0, Math.min(1, alpha)) * 100);
  return pct >= 100 ? stylesHex6(c) : stylesHex6(c) + "@" + pct + "%";
}

// One 8-bit step of slack: the catalogue is rounded to hex, the live value is a float.
function sameColour(a: RGBA, c: RGB, alpha: number): boolean {
  const ch = (x: number, y: number) => Math.abs(Math.round(x * 255) - Math.round(y * 255)) <= 1;
  return ch(a.r, c.r) && ch(a.g, c.g) && ch(a.b, c.b) && Math.abs(a.a - alpha) <= 0.006;
}

function stylesYield(): Promise<void> {
  return new Promise<void>((res) => setTimeout(() => res(), 0));
}

// Прогресс раньше жил в панели. Панели больше нет: на большом прогоне — одно уведомление в
// начале, чтобы человек видел, что плагин работает, и дальше только итоговый тост.
function stylesAnnounce(count: number, what: string): void {
  if (count >= 1500) figma.notify(`${what} ${count} layers…`, { timeout: 2000 });
}

// Every scan starts from a clean cache: a variable edited between two runs of the plugin must not
// be judged from the copy the previous run happened to hold.
function resetStylesCaches(): void {
  stylesVarCache.clear();
  stylesThemedCache.clear();
}

// ── Scope ────────────────────────────────────────────────────────────────
// Selection with every descendant; nothing selected means the whole current page.
// Locked layers and remote (library) components / sets are left alone, together with whatever
// sits inside them. Layers inside instances ARE processed, but counted apart: a colour written
// there becomes an override on the instance.

type StylesScope = {
  nodes: SceneNode[];
  inInstance: Set<string>;
  locked: number;
  remote: number;
  label: string;
};

function stylesInsideInstance(n: BaseNode | null): boolean {
  let p: BaseNode | null = n;
  while (p && p.type !== "PAGE" && p.type !== "DOCUMENT") {
    if (p.type === "INSTANCE") return true;
    p = p.parent;
  }
  return false;
}

// A locked ancestor locks everything under it in the UI, so the whole subtree is off limits.
function stylesWritable(n: SceneNode): boolean {
  let p: BaseNode | null = n;
  while (p && p.type !== "PAGE" && p.type !== "DOCUMENT") {
    if ((p as any).locked) return false;
    if ((p.type === "COMPONENT" || p.type === "COMPONENT_SET") && (p as any).remote) return false;
    p = p.parent;
  }
  return true;
}

function collectStylesScope(): StylesScope {
  const nodes: SceneNode[] = [];
  const inInstance = new Set<string>();
  let locked = 0;
  let remote = 0;

  const walk = (n: SceneNode, ins: boolean) => {
    if ((n as any).locked) { locked++; return; }
    if ((n.type === "COMPONENT" || n.type === "COMPONENT_SET") && (n as any).remote) { remote++; return; }
    nodes.push(n);
    if (ins) inInstance.add(n.id);
    if ("children" in n) {
      const deeper = ins || n.type === "INSTANCE";
      for (const c of (n as ChildrenMixin).children as SceneNode[]) walk(c, deeper);
    }
  };

  const sel = figma.currentPage.selection;
  if (sel.length) for (const n of sel) walk(n, stylesInsideInstance(n.parent));
  else for (const n of figma.currentPage.children as SceneNode[]) walk(n, false);

  const label = sel.length
    ? `${sel.length} selected layer${sel.length === 1 ? "" : "s"} + everything inside`
    : `the whole page "${figma.currentPage.name}"`;
  return { nodes, inInstance, locked, remote, label };
}

// ── Variables ────────────────────────────────────────────────────────────

const stylesVarCache = new Map<string, Variable | null>();
async function stylesVarById(id: string): Promise<Variable | null> {
  const hit = stylesVarCache.get(id);
  if (hit !== undefined) return hit;
  let v: Variable | null = null;
  try { v = await figma.variables.getVariableByIdAsync(id); } catch (_e) { v = null; }
  stylesVarCache.set(id, v);
  return v;
}

// The colour the node actually shows: aliases followed, the node's own mode context applied.
function stylesResolve(v: Variable, node: SceneNode): RGBA | null {
  try {
    const r = v.resolveForConsumer(node);
    const val: any = r.value;
    if (r.resolvedType !== "COLOR" || !val || typeof val !== "object" || !("r" in val)) return null;
    return { r: val.r, g: val.g, b: val.b, a: typeof val.a === "number" ? val.a : 1 };
  } catch (_e) {
    return null;
  }
}

// Theme-dependent = the token does not resolve to the same colour in every mode, following
// aliases. That is the number the confirmation has to show: exactly these bindings freeze at the
// current mode, and dark theme stops working on those layers.
const stylesThemedCache = new Map<string, boolean>();
async function variableIsThemed(id: string, depth: number): Promise<boolean> {
  const hit = stylesThemedCache.get(id);
  if (hit !== undefined) return hit;
  if (depth > 4) return false;
  const v = await stylesVarById(id);
  if (!v) { stylesThemedCache.set(id, false); return false; }

  const keys = Object.keys(v.valuesByMode);
  let themed = false;
  if (keys.length <= 1) {
    const only: any = keys.length ? v.valuesByMode[keys[0]] : null;
    if (only && typeof only === "object" && only.type === "VARIABLE_ALIAS") {
      themed = await variableIsThemed(String(only.id), depth + 1);
    }
  } else {
    const sigs = new Set<string>();
    for (const k of keys) {
      const val: any = v.valuesByMode[k];
      if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS") {
        sigs.add("alias:" + val.id);
        if (await variableIsThemed(String(val.id), depth + 1)) themed = true;
      } else if (val && typeof val === "object" && "r" in val) {
        sigs.add(colourKey(val as RGB, typeof val.a === "number" ? val.a : 1));
      } else {
        sigs.add(String(val));
      }
    }
    if (sigs.size > 1) themed = true;
  }
  stylesThemedCache.set(id, themed);
  return themed;
}

// ── Delete: literalise ───────────────────────────────────────────────────

type StripStats = {
  changed: number;
  fillStyles: number;
  strokeStyles: number;
  effectStyles: number;
  paintVars: number;
  stopVars: number;
  effectVars: number;
  textRanges: number;
  textSkipped: number;
  unresolved: number;
  failed: number;
  varUses: Map<string, number>;
};

function newStripStats(): StripStats {
  return {
    changed: 0, fillStyles: 0, strokeStyles: 0, effectStyles: 0,
    paintVars: 0, stopVars: 0, effectVars: 0, textRanges: 0, textSkipped: 0,
    unresolved: 0, failed: 0, varUses: new Map<string, number>(),
  };
}

function boundColourId(o: any): string | null {
  const bv = o && o.boundVariables;
  return bv && bv.color && bv.color.id ? String(bv.color.id) : null;
}

// A plain copy without the binding. Everything else on the paint (blendMode, scaleMode, image
// hash, gradient transform …) is carried over untouched.
function withoutBoundVariables<T>(o: T): T {
  const c: any = {};
  for (const k of Object.keys(o as any)) if (k !== "boundVariables") c[k] = (o as any)[k];
  return c as T;
}

type LitPaints = { paints: Paint[]; bindings: number };

async function literalisePaints(list: ReadonlyArray<Paint>, node: SceneNode, st: StripStats): Promise<LitPaints> {
  const out: Paint[] = [];
  let bindings = 0;

  for (const p of list) {
    if (p.type === "SOLID") {
      const id = boundColourId(p);
      if (!id) { out.push(p); continue; }
      bindings++;
      st.paintVars++;
      st.varUses.set(id, (st.varUses.get(id) || 0) + 1);
      const lit: any = withoutBoundVariables(p);
      const v = await stylesVarById(id);
      const rgba = v ? stylesResolve(v, node) : null;
      if (rgba) {
        // Replace, never multiply — see the note at the top of this section.
        lit.color = { r: rgba.r, g: rgba.g, b: rgba.b };
        lit.opacity = rgba.a;
      } else {
        st.unresolved++;
      }
      out.push(lit as Paint);
    } else if (
      p.type === "GRADIENT_LINEAR" || p.type === "GRADIENT_RADIAL" ||
      p.type === "GRADIENT_ANGULAR" || p.type === "GRADIENT_DIAMOND"
    ) {
      const stops = (p as GradientPaint).gradientStops;
      let touched = false;
      const next: any[] = [];
      for (const s of stops) {
        const id = boundColourId(s);
        if (!id) { next.push(s); continue; }
        touched = true;
        bindings++;
        st.stopVars++;
        st.varUses.set(id, (st.varUses.get(id) || 0) + 1);
        const lit: any = withoutBoundVariables(s);
        const v = await stylesVarById(id);
        const rgba = v ? stylesResolve(v, node) : null;
        if (rgba) lit.color = { r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.a };
        else st.unresolved++;
        next.push(lit);
      }
      if (!touched) { out.push(p); continue; }
      const g: any = withoutBoundVariables(p);
      g.gradientStops = next;
      out.push(g as Paint);
    } else {
      out.push(p);
    }
  }
  return { paints: out, bindings };
}

type LitEffects = { effects: Effect[]; bindings: number };

// Only the colour binding comes off. A radius / spread / offset bound to a number variable is not
// colour and is carried over as it was.
async function literaliseEffects(list: ReadonlyArray<Effect>, node: SceneNode, st: StripStats): Promise<LitEffects> {
  const out: Effect[] = [];
  let bindings = 0;

  for (const e of list) {
    const id = boundColourId(e);
    if (!id) { out.push(e); continue; }
    bindings++;
    st.effectVars++;
    st.varUses.set(id, (st.varUses.get(id) || 0) + 1);

    const lit: any = withoutBoundVariables(e);
    const bv: any = (e as any).boundVariables || {};
    const rest: any = {};
    for (const k of Object.keys(bv)) if (k !== "color") rest[k] = bv[k];
    if (Object.keys(rest).length) lit.boundVariables = rest;

    const v = await stylesVarById(id);
    const rgba = v ? stylesResolve(v, node) : null;
    if (rgba) lit.color = { r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.a };
    else st.unresolved++;
    out.push(lit as Effect);
  }
  return { effects: out, bindings };
}

// A text node with per-range formatting reports fills / fillStyleId as figma.mixed, and writing
// node.fills would flatten the whole string to one colour. Those go range by range instead.
async function stripTextRanges(t: TextNode, st: StripStats, apply: boolean): Promise<boolean> {
  let segs: Array<{ start: number; end: number; fills: Paint[]; fillStyleId: string }>;
  try {
    segs = t.getStyledTextSegments(["fills", "fillStyleId"]) as any;
  } catch (_e) {
    st.textSkipped++;
    return false;
  }

  const plans: Array<{ start: number; end: number; paints: Paint[]; styled: boolean }> = [];
  for (const s of segs) {
    const styled = !!s.fillStyleId;
    const lit = await literalisePaints(s.fills || [], t, st);
    if (styled) st.fillStyles++;
    if (styled || lit.bindings) plans.push({ start: s.start, end: s.end, paints: lit.paints, styled });
  }
  if (!plans.length) return false;
  if (!apply) { st.textRanges += plans.length; return true; }

  // setRangeFills needs every font in the node loaded; a missing font makes that impossible, and
  // such a node is reported as skipped rather than half-written.
  try {
    for (const seg of t.getStyledTextSegments(["fontName"])) await figma.loadFontAsync(seg.fontName as FontName);
  } catch (_e) {
    st.textSkipped++;
    return false;
  }

  let wrote = false;
  for (const p of plans) {
    try {
      if (p.styled) { try { await t.setRangeFillStyleIdAsync(p.start, p.end, ""); } catch (_e) { /* older file: setRangeFills detaches it anyway */ } }
      t.setRangeFills(p.start, p.end, p.paints);
      st.textRanges++;
      wrote = true;
    } catch (_e) {
      st.failed++;
    }
  }
  return wrote;
}

// Read first, detach the style second, write the literals third — in that order, because the
// style is what supplies the paints we are about to keep.
async function stripNodeColours(n: SceneNode, st: StripStats, apply: boolean): Promise<boolean> {
  const a = n as any;
  let touched = false;

  if ("fills" in n) {
    if (n.type === "TEXT" && (a.fills === figma.mixed || a.fillStyleId === figma.mixed)) {
      if (await stripTextRanges(n as TextNode, st, apply)) touched = true;
    } else if (Array.isArray(a.fills)) {
      const styled = !!a.fillStyleId && a.fillStyleId !== figma.mixed;
      const lit = await literalisePaints(a.fills as Paint[], n, st);
      if (styled || lit.bindings) {
        if (styled) st.fillStyles++;
        touched = true;
        if (apply) {
          if (styled && typeof a.setFillStyleIdAsync === "function") await a.setFillStyleIdAsync("");
          a.fills = lit.paints;
        }
      }
    }
  }

  if ("strokes" in n && Array.isArray(a.strokes)) {
    const styled = !!a.strokeStyleId && a.strokeStyleId !== figma.mixed;
    const lit = await literalisePaints(a.strokes as Paint[], n, st);
    if (styled || lit.bindings) {
      if (styled) st.strokeStyles++;
      touched = true;
      if (apply) {
        if (styled && typeof a.setStrokeStyleIdAsync === "function") await a.setStrokeStyleIdAsync("");
        a.strokes = lit.paints;
      }
    }
  }

  if ("effects" in n && Array.isArray(a.effects)) {
    const styled = !!a.effectStyleId && a.effectStyleId !== figma.mixed;
    const lit = await literaliseEffects(a.effects as Effect[], n, st);
    if (styled || lit.bindings) {
      if (styled) st.effectStyles++;
      touched = true;
      if (apply) {
        if (styled && typeof a.setEffectStyleIdAsync === "function") await a.setEffectStyleIdAsync("");
        a.effects = lit.effects;
      }
    }
  }

  if (touched) st.changed++;
  return touched;
}


function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Version history first, then one Cmd+Z for the whole run: commitUndo() seals off whatever came
// before so the run starts a fresh undo entry, and the matching call after the writes closes it.
async function stylesBeginWrite(title: string): Promise<void> {
  figma.commitUndo();
  try {
    await figma.saveVersionHistoryAsync(title);
  } catch (_e) {
    // Version history is not available in every file (drafts, view-only) — not a reason to stop.
  }
}

// ── Delete: one press, one toast ─────────────────────────────────────────
// Scan first, so a run with nothing to do writes nothing and saves no version; then the writes.
// The whole result is one line through figma.notify — no panel, no second press.

// Темозависимые привязки — единственное, что человеку обязательно надо знать после Delete:
// именно они замерзают на текущем режиме и перестают следовать тёмной теме.
async function stripThemedCounts(st: StripStats): Promise<{ tokens: number; bindings: number }> {
  let tokens = 0;
  let bindings = 0;
  const entries: Array<{ id: string; uses: number }> = [];
  st.varUses.forEach((uses, id) => entries.push({ id, uses }));
  for (const e of entries) {
    if (await variableIsThemed(e.id, 0)) { tokens++; bindings += e.uses; }
  }
  return { tokens, bindings };
}

async function stylesDelete(): Promise<void> {
  resetStylesCaches();
  const scope = collectStylesScope();
  if (!scope.nodes.length) { sendStatus("Nothing in scope — select something or open a page with layers", "error"); return; }
  stylesAnnounce(scope.nodes.length, "Delete — reading");

  // Pass 1: what would change. Nothing is written here.
  const scan = newStripStats();
  const nodeIds: string[] = [];
  for (let i = 0; i < scope.nodes.length; i++) {
    const n = scope.nodes[i];
    let hit = false;
    try { hit = await stripNodeColours(n, scan, false); } catch (_e) { /* one bad node never stops the run */ }
    if (hit) nodeIds.push(n.id);
    if (i % 300 === 299) await stylesYield();
  }
  if (!nodeIds.length) { sendStatus("Nothing to detach", ""); return; }

  // Pass 2: the writes, inside one undo step with a version saved first.
  await stylesBeginWrite("Booster · Styles Delete — before");

  const st = newStripStats();
  let skipped = 0;
  for (let i = 0; i < nodeIds.length; i++) {
    const node = await figma.getNodeByIdAsync(nodeIds[i]);
    if (!node || node.removed || !("type" in node)) { skipped++; continue; }
    const n = node as SceneNode;
    // Re-checked against the live node: locked / remote could have changed since the scan.
    if (!stylesWritable(n)) { skipped++; continue; }
    try { await stripNodeColours(n, st, true); } catch (_e) { st.failed++; }
    if (i % 100 === 99) await stylesYield();
  }

  figma.commitUndo();

  const themed = await stripThemedCounts(st);
  skipped += st.textSkipped + st.failed;

  if (!st.changed) { sendStatus("Nothing to detach", ""); return; }
  let line = `Detached ${plural(st.changed, "layer", "layers")}`;
  if (themed.bindings) line += ` · ${plural(themed.bindings, "theme binding", "theme bindings")} frozen`;
  if (skipped) line += ` · ${skipped} skipped`;
  sendStatus(line, "success");
}

// ── Fix: scan → confirm → apply ──────────────────────────────────────────
// Only layers whose colour is hand-set — no style, no variable. A match has to be EXACT: the
// live colour, alpha included, equals one of the token's values. Nothing is ever nudged to look
// like a token, because that would silently change the design.
//
// The candidates come from the run-time catalogue (buildColourCatalogue): the file's own colour
// variables plus the library ones already bound somewhere in it. On top of the catalogue match,
// the chosen token is resolved against the node itself before it is planned. Binding it must leave the layer exactly the colour it is now in
// the mode the person is looking at — which is also what keeps a themed token's dark value from
// being mistaken for a light-mode match.

type FixBind = {
  nodeId: string;
  nodeName: string;
  slot: "fills" | "strokes" | "effects";
  index: number;
  key: string;
  tokId: string;
  token: string;
};

type FixPlan = {
  tokens: Map<string, ColourToken[]>;
  binds: FixBind[];
  unmatched: Map<string, number>;
  ambiguous: Array<{ key: string; chosen: string; other: string }>;
  scopeSkipped: number;
  alreadyBound: number;
  underStyle: number;
  verifyFailed: number;
  lookupFailed: number;
  mixedText: number;
  scanned: number;
  inInstance: number;
  locked: number;
  remote: number;
  scopeLabel: string;
};

function fixRank(a: ColourToken, b: ColourToken): number {
  // (b) a constant never changes the layer in any mode; a themed token would change it in dark.
  if (a.t !== b.t) return a.t ? 1 : -1;
  // (c) a library token over a variable that lives only in this file — the audit (R10) flags
  //     the latter as "not from the design system".
  if (a.r !== b.r) return a.r ? -1 : 1;
  // (d) otherwise the one this document actually leans on; the name only keeps the order stable.
  if (a.u !== b.u) return b.u - a.u;
  return a.n < b.n ? -1 : a.n > b.n ? 1 : 0;
}

// Narrow by exact value, then by scope, then rank — and verify against the live node before the
// candidate is accepted.
async function planColourBind(
  node: SceneNode, slot: ColourSlot, colour: RGB, alpha: number, plan: FixPlan
): Promise<ColourToken | null> {
  const key = colourKey(colour, alpha);
  const cands = plan.tokens.get(key);
  if (!cands || !cands.length) {
    plan.unmatched.set(key, (plan.unmatched.get(key) || 0) + 1);
    return null;
  }
  const fitting = cands.filter((t) => tokenFitsSlot(t, slot)).sort(fixRank);
  if (!fitting.length) { plan.scopeSkipped++; return null; }
  if (fitting.length > 1 && plan.ambiguous.length < 40) {
    plan.ambiguous.push({ key, chosen: fitting[0].n, other: fitting[1].n });
  }

  for (const tok of fitting) {
    const v = await stylesVarById(tok.id);
    if (!v) { plan.lookupFailed++; continue; }
    const rgba = stylesResolve(v, node);
    if (!rgba || !sameColour(rgba, colour, alpha)) { plan.verifyFailed++; continue; }
    return tok;
  }
  return null;
}

async function fixScanNode(n: SceneNode, inInstance: boolean, plan: FixPlan): Promise<void> {
  const a = n as any;
  const bindsBefore = plan.binds.length;

  const paintSlots: Array<{ prop: "fills" | "strokes"; styleId: any; slot: ColourSlot }> = [];
  if ("fills" in n) {
    if (n.type === "TEXT" && (a.fills === figma.mixed || a.fillStyleId === figma.mixed)) plan.mixedText++;
    else if (Array.isArray(a.fills)) paintSlots.push({ prop: "fills", styleId: a.fillStyleId, slot: n.type === "TEXT" ? "textFill" : "fill" });
  }
  if ("strokes" in n && Array.isArray(a.strokes)) paintSlots.push({ prop: "strokes", styleId: a.strokeStyleId, slot: "stroke" });

  for (const g of paintSlots) {
    if (g.styleId && g.styleId !== figma.mixed) { plan.underStyle++; continue; }
    const list = a[g.prop] as Paint[];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.type !== "SOLID" || p.visible === false) continue;
      if (boundColourId(p)) { plan.alreadyBound++; continue; }
      const alpha = typeof p.opacity === "number" ? p.opacity : 1;
      const tok = await planColourBind(n, g.slot, p.color, alpha, plan);
      if (tok) plan.binds.push({ nodeId: n.id, nodeName: n.name, slot: g.prop, index: i, key: colourKey(p.color, alpha), tokId: tok.id, token: tok.n });
    }
  }

  if ("effects" in n && Array.isArray(a.effects)) {
    if (a.effectStyleId && a.effectStyleId !== figma.mixed) { plan.underStyle++; }
    else {
      const list = a.effects as Effect[];
      for (let i = 0; i < list.length; i++) {
        const e: any = list[i];
        if (e.type !== "DROP_SHADOW" && e.type !== "INNER_SHADOW") continue;
        if (e.visible === false || !e.color) continue;
        if (boundColourId(e)) { plan.alreadyBound++; continue; }
        const alpha = typeof e.color.a === "number" ? e.color.a : 1;
        const tok = await planColourBind(n, "effect", e.color as RGB, alpha, plan);
        if (tok) plan.binds.push({ nodeId: n.id, nodeName: n.name, slot: "effects", index: i, key: colourKey(e.color as RGB, alpha), tokId: tok.id, token: tok.n });
      }
    }
  }

  if (inInstance && plan.binds.length > bindsBefore) plan.inInstance++;
}

async function stylesFix(): Promise<void> {
  resetStylesCaches();
  const scope = collectStylesScope();
  if (!scope.nodes.length) { sendStatus("Nothing in scope — select something or open a page with layers", "error"); return; }
  stylesAnnounce(scope.nodes.length, "Fix — reading");

  // The tokens this file can offer: its own colour variables + library ones already in use.
  const catalogue = await buildColourCatalogue();
  if (!catalogue.size) {
    sendStatus("Nothing to bind · no colour variables in this file yet", "");
    return;
  }

  const plan: FixPlan = {
    tokens: catalogue.index,
    binds: [], unmatched: new Map<string, number>(), ambiguous: [],
    scopeSkipped: 0, alreadyBound: 0, underStyle: 0, verifyFailed: 0, lookupFailed: 0, mixedText: 0,
    scanned: scope.nodes.length, inInstance: 0, locked: scope.locked, remote: scope.remote, scopeLabel: scope.label,
  };

  // Pass 1: what could be bound. Nothing is written here.
  for (let i = 0; i < scope.nodes.length; i++) {
    const n = scope.nodes[i];
    try { await fixScanNode(n, scope.inInstance.has(n.id), plan); } catch (_e) { /* one bad node never stops the run */ }
    if (i % 300 === 299) await stylesYield();
  }

  let unmatched = 0;
  plan.unmatched.forEach((n) => { unmatched += n; });

  if (!plan.binds.length) {
    let none = "Nothing to bind";
    if (unmatched) none += ` · ${plural(unmatched, "colour", "colours")} had no token`;
    sendStatus(none, "");
    return;
  }

  // Pass 2: the writes, inside one undo step with a version saved first.
  await stylesBeginWrite("Booster · Styles Fix — before");

  const touched = new Set<string>();
  const themed = new Set<string>();
  let skipped = 0;

  for (let i = 0; i < plan.binds.length; i++) {
    const b = plan.binds[i];
    try {
      const node = await figma.getNodeByIdAsync(b.nodeId);
      if (!node || node.removed || !("type" in node)) { skipped++; continue; }
      const n = node as SceneNode;
      if (!stylesWritable(n)) { skipped++; continue; }
      const a = n as any;
      const list = a[b.slot];
      if (!Array.isArray(list)) { skipped++; continue; }

      const v = await stylesVarById(b.tokId);
      if (!v) { skipped++; continue; }
      const copy = list.slice();

      if (b.slot === "effects") {
        const e: any = copy[b.index];
        // Re-checked at write time: still the same colour, still unbound.
        if (!e || !e.color || boundColourId(e) || colourKey(e.color as RGB, typeof e.color.a === "number" ? e.color.a : 1) !== b.key) { skipped++; continue; }
        copy[b.index] = figma.variables.setBoundVariableForEffect(e as Effect, "color", v);
        a.effects = copy;
      } else {
        const p: any = copy[b.index];
        if (!p || p.type !== "SOLID" || boundColourId(p) || colourKey(p.color as RGB, typeof p.opacity === "number" ? p.opacity : 1) !== b.key) { skipped++; continue; }
        copy[b.index] = figma.variables.setBoundVariableForPaint(p as SolidPaint, "color", v);
        a[b.slot] = copy;
      }
      touched.add(b.nodeId);
      // Токен, который в разных режимах даёт разный цвет, делает слой темозависимым: в тёмной
      // теме он теперь поедет за темой. Это и есть предупреждение, которое уходит хвостом в тост.
      if (await variableIsThemed(v.id, 0)) themed.add(b.nodeId);
    } catch (_e) {
      skipped++;
    }
    if (i % 100 === 99) await stylesYield();
  }

  figma.commitUndo();

  if (!touched.size) { sendStatus("Nothing to bind", ""); return; }
  let line = `Bound ${plural(touched.size, "layer", "layers")}`;
  if (unmatched) line += ` · ${plural(unmatched, "colour", "colours")} had no token`;
  if (themed.size) line += ` · ${themed.size} now theme-dependent`;
  if (skipped) line += ` · ${skipped} skipped`;
  sendStatus(line, "success");
}


figma.ui.onmessage = async (msg: { type: string }) => {
  switch (msg.type) {
    case "run-audit":
      await runAudit();
      break;
    case "run-audit-fix":
      await runAuditFix();
      break;
    case "audit-fix-radius":
      await runAuditFixRadius();
      break;
    // Токен для комментариев: лежит в clientStorage этой машины, в файл не пишется.
    case "save-figma-token": {
      const raw = String((msg as any).token || "");
      const t = cleanToken(raw);
      if (!t) {
        await figma.clientStorage.deleteAsync("figmaToken");
        figma.ui.postMessage({ type: "figma-token", has: false });
        sendStatus("Figma token cleared", "success");
        break;
      }
      // Сколько символов пришлось выкинуть — полезно знать: значит буфер принёс мусор.
      const dropped = raw.trim().length - t.length;
      if (t.length < 20) {
        sendStatus("That does not look like a Figma token — it is too short", "error");
        break;
      }
      await figma.clientStorage.setAsync("figmaToken", t);
      figma.ui.postMessage({ type: "figma-token", has: true });
      sendStatus(dropped > 0
        ? "Figma token saved · cleaned " + dropped + " stray character" + (dropped > 1 ? "s" : "")
        : "Figma token saved", "success");
      break;
    }
    // Интерфейс подтвердил, что посылка дошла. Без этого непонятно, где обрыв:
    // главный поток отправил и забыл, подтверждения не было.
    // Первый проход уборки: посчитали, но ничего не удалили.
    case "spell-result": {
      const m = msg as any;
      if (spellPending) spellPending(m.bad || []);
      if (m.error) console.log("spell-result error:", m.error);
      break;
    }
    case "clean-found": {
      const m = msg as any;
      if (!m.count) {
        cleanArmed = false;
        sendStatus("Comments — no audit comments in this file", "success");
        break;
      }
      cleanArmed = true;
      const kept = m.skipped ? ` · ${m.skipped} kept, someone replied to them` : "";
      const skill = m.fromSkill ? ` · ${m.fromSkill} of them from the checklist script` : "";
      sendStatus(`Comments — ${plural(m.count, "audit comment", "audit comments")} found${skill}${kept} · press Clean again to delete`, "");
      break;
    }
    case "clean-done": {
      const m = msg as any;
      cleanArmed = false;
      if (m.error) { sendStatus("Comments — " + m.error, "error", false, true); break; }
      const bits: string[] = [];
      if (m.deleted) bits.push(m.deleted + " deleted");
      if (m.skipped) bits.push(m.skipped + " kept, someone replied to them");
      if (m.failed) bits.push(m.failed + " failed" + (m.why ? " (" + m.why + ")" : ""));
      sendStatus("Comments — " + (bits.length ? bits.join(" · ") : "nothing to delete"),
        m.failed ? "error" : m.deleted ? "success" : "", false, !!m.failed);
      break;
    }
    case "clean-comments":
      await requestCommentCleanup();
      break;
    case "comments-ack":
      // Тоста здесь нет намеренно: сводка аудита уже сказала, что комментарии ставятся,
      // а второй тост поверх неё стирал бы её раньше, чем её успевают прочитать.
      console.log("comments-ack:", (msg as any).count);
      break;
    // Интерфейс отчитался, чем кончился постинг комментариев.
    case "comments-done": {
      const m = msg as any;
      if (m.error) { sendStatus("Comments — " + m.error, "error"); break; }
      const bits: string[] = [];
      if (m.posted) bits.push(plural(m.posted, "comment", "comments") + " posted");
      if (m.duplicates) bits.push(m.duplicates + " already commented");
      if (m.capped) bits.push(m.capped + " over the per-run cap");
      if (m.left) bits.push(m.left + " not sent");
      if (m.failed) bits.push(m.failed + " failed" + (m.why ? " (" + m.why + ")" : ""));
      // Если что-то не дошло, человеку нужна причина — такой тост не гасим сам.
      const commentsFailed = !!(m.failed || m.left || m.error);
      sendStatus("Comments — " + (bits.length ? bits.join(" · ") : "nothing to add"),
        commentsFailed ? "error" : m.posted ? "success" : "", false, commentsFailed);
      break;
    }
    case "get-figma-token":
      figma.ui.postMessage({ type: "figma-token", has: !!(await auditToken()) });
      break;
    case "styles-delete":
      await stylesDelete();
      break;
    case "styles-fix":
      await stylesFix();
      break;
    case "wrap-selection":
      await wrapToNewSelection(true);
      break;
    case "wrap-selection-light":
      await wrapToNewSelection(false);
      break;
    case "align-sections":
      await alignSections();
      break;
    case "expand-section":
      await expandSectionGrow("right");
      break;
    case "expand-section-left":
      await expandSectionGrow("left");
      break;
    case "replace-instance":
      await replaceWithInstance();
      break;
    case "find-similar":
      await findSimilar();
      break;
    case "toggle-dev-status":
      await toggleDevStatus();
      break;
    case "move-to-zero": {
      const sel = figma.currentPage.selection;
      if (sel.length === 1) {
        sel[0].x = 0;
        sel[0].y = 0;
      }
      break;
    }
    case "fix-selection":
      await fixSelection(true);
      break;
    case "fix-selection-light":
      await fixSelection(false);
      break;
    case "create-art-block":
      await createArtBlock();
      break;
    case "frame-border":
      await frameWithBorder();
      break;
    case "frame-540":
      await frame540();
      break;
    case "grid-layout":
      await gridLayout();
      break;
    case "make-component":
      await makeComponents();
      break;
    case "custom-absolute":
      await customIgnoreAutoLayout();
      break;
    case "slice-267":
      await scaleSelection267();
      break;
    case "create-component-from-objects":
      await createComponentFromObjects();
      break;
    case "pick-target":
      await pickTarget();
      break;
    case "attach-to-target":
      await attachToTarget();
      break;
    case "bulk-swap-to-target":
      await bulkSwapToTarget();
      break;
    case "custom-fn":
      await runCustomFn((msg as any).fn, (msg as any).script);
      break;
    case "get-custom": {
      const custom = (await figma.clientStorage.getAsync("customTools")) || null;
      figma.ui.postMessage({ type: "custom", custom });
      break;
    }
    case "save-custom":
      await figma.clientStorage.setAsync("customTools", (msg as any).custom);
      break;
    case "get-removed": {
      const removed = (await figma.clientStorage.getAsync("removedTools")) || null;
      // Сохранённый список подменяет набор умолчаний целиком, поэтому кнопка, добавленная
      // позже, у давнего пользователя появлялась бы в панели вопреки умолчанию.
      // Версия набора говорит интерфейсу, что пора доклеить новые скрытые разово.
      const seed = (await figma.clientStorage.getAsync("hiddenSeed")) || 0;
      figma.ui.postMessage({ type: "removed", removed, seed });
      break;
    }
    case "save-removed":
      await figma.clientStorage.setAsync("removedTools", (msg as any).removed);
      if ((msg as any).seed) await figma.clientStorage.setAsync("hiddenSeed", (msg as any).seed);
      break;
    case "notify":
      figma.notify((msg as any).text, (msg as any).error ? { error: true } : undefined);
      break;
    case "get-order": {
      const order = (await figma.clientStorage.getAsync("toolOrder")) || null;
      console.log("get-order:", order);
      figma.ui.postMessage({ type: "order", order });
      break;
    }
    case "save-order":
      await figma.clientStorage.setAsync("toolOrder", (msg as any).order);
      break;
    case "get-theme": {
      const light = (await figma.clientStorage.getAsync("lightTheme")) || false;
      console.log("get-theme:", light);
      figma.ui.postMessage({ type: "theme", light });
      break;
    }
    case "save-theme":
      await figma.clientStorage.setAsync("lightTheme", (msg as any).light);
      break;
    case "get-wf": {
      const wf = await figma.clientStorage.getAsync("wfTheme");
      figma.ui.postMessage({ type: "wf", on: wf == null ? true : wf });
      break;
    }
    case "save-wf":
      await figma.clientStorage.setAsync("wfTheme", (msg as any).on);
      break;
    case "reset-all":
      await figma.clientStorage.deleteAsync("uiPos");
      await figma.clientStorage.deleteAsync("lightTheme");
      await figma.clientStorage.deleteAsync("toolOrder");
      await figma.clientStorage.deleteAsync("customTools");
      await figma.clientStorage.deleteAsync("removedTools");
      await figma.clientStorage.deleteAsync("wfTheme");
      await figma.clientStorage.deleteAsync("masterTarget");
      uiPos = "center";
      figma.ui.postMessage({ type: "pos", pos: uiPos });
      figma.ui.postMessage({ type: "theme", light: false });
      figma.ui.postMessage({ type: "order", order: null });
      figma.ui.postMessage({ type: "custom", custom: null });
      figma.ui.postMessage({ type: "removed", removed: null });
      figma.ui.postMessage({ type: "wf", on: true });
      repositionUI(uiPos);
      figma.notify("Settings reset to default");
      break;
    case "set-pos":
      uiPos = (msg as any).pos || "center";
      await figma.clientStorage.setAsync("uiPos", uiPos);
      repositionUI(uiPos);
      break;
    case "resize": {
      // Only update a dimension when it's actually provided; keep the other as-is.
      // (Panels like Settings post width only — never let height become undefined.)
      const w = (msg as any).width, h = (msg as any).height;
      if (w != null && w > 0) lastW = Math.round(w);
      if (h != null && h > 0) lastH = Math.round(h);
      lastW = Math.max(lastW || 1, 1);
      lastH = Math.max(lastH || 1, 1);
      figma.ui.resize(lastW, lastH);
      repositionUI(uiPos);
      break;
    }
    case "run-translation": {
      const textNodes = findAllTextNodes(figma.currentPage.selection);
      if (textNodes.length === 0) {
        sendStatus("No text layers", "error");
        break;
      }
      const payload = textNodes.map((n) => ({ id: n.id, text: n.characters }));
      figma.ui.postMessage({
        type: "start-api-call",
        payload,
        target: (msg as any).target,
      });
      break;
    }
    case "apply-data": {
      try {
        const results = (msg as any).results as Array<{ id: string; translatedText: string }>;
        for (const item of results) {
          const node = await figma.getNodeByIdAsync(item.id);
          if (node && node.type === "TEXT") {
            const textNode = node as TextNode;
            let fontToLoad = textNode.fontName;
            if (fontToLoad === figma.mixed) {
              fontToLoad = textNode.getRangeFontName(0, 1) as FontName;
              await figma.loadFontAsync(fontToLoad);
              textNode.setRangeFontName(0, textNode.characters.length, fontToLoad);
            } else {
              await figma.loadFontAsync(fontToLoad);
            }
            textNode.characters = item.translatedText;
          }
        }
        figma.ui.postMessage({ type: "apply-data-success" });
        sendStatus(`${results.length} texts translated`, "success");
      } catch (_e) {
        figma.ui.postMessage({ type: "translate-error" });
        sendStatus("Translation apply error", "error");
      }
      break;
    }
  }
};
