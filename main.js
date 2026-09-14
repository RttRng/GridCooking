const { Plugin, Notice, PluginSettingTab, Setting } = require("obsidian");

/* ============================================================
   GRID COOKING — v0.1
   Single `gridcooking` code block containing:
     name: <string>
     mult: <number>        (optional, default 1)
     ingredients:
       key: <NUM|X> <UNIT> <LABEL...>
     recepie:
       ID input1 input2 ...: <desc>

   v1 known simplifications (documented, not bugs):
   - Row order is "first appearance" order, not a full
     barycenter/crossing-minimization pass. Works fine for
     small/medium recipes; may look sub-optimal for very
     branchy ones.
   - A merge is assumed to consume a CONTIGUOUS block of rows
     (min..max of its inputs' rows). If row ordering leaves a
     gap, the merge cell will visually swallow the row(s) in
     between too. Fixing this properly needs a real
     crossing-minimization layout pass — left for v2.
   ============================================================ */

const DEFAULT_SETTINGS = {
  ingredientDisplayOrder: "num-unit-label", // or "label-num-unit"
};

// ---------- Parsing ----------

function parseBlock(source) {
  const lines = source.split("\n");
  const result = { name: "", mult: 1, ingredients: new Map(), steps: [] };

  let section = null; // null | 'ingredients' | 'recepie'

  for (let raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim()) continue;

    const topLevel = /^(\S+):\s*(.*)$/.exec(line.trim());
    const isIndented = /^\s+/.test(line) && line.trim().length > 0;

    if (!isIndented) {
      const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim();

      if (key === "name") {
        result.name = value;
        section = null;
      } else if (key === "mult") {
        const n = parseFloat(value.replace(",", "."));
        result.mult = isNaN(n) ? 1 : n;
        section = null;
      } else if (key === "ingredients") {
        section = "ingredients";
      } else if (key === "recepie" || key === "recipe") {
        section = "recepie";
      }
      continue;
    }

    // indented line -> belongs to current section
    const trimmed = line.trim();
    if (section === "ingredients") {
      const m = /^(\S+?):\s*(.+)$/.exec(trimmed);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const rest = m[2].trim().split(/\s+/);
      const numTok = rest.shift();
      const unit = rest.shift() || "";
      const label = rest.join(" ");
      const isX = /^x$/i.test(numTok);
      const num = isX ? null : parseFloat(numTok.replace(",", "."));
      result.ingredients.set(key, {
        key,
        num: isX ? null : (isNaN(num) ? null : num),
        isX,
        unit,
        label,
      });
    } else if (section === "recepie") {
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const head = trimmed.slice(0, colonIdx).trim().split(/\s+/);
      // IDs and input references must share one casing convention, or a
      // reference to an earlier step silently fails to match. Lowercase
      // everything (ingredient keys are already lowercase by convention).
      const id = head.shift().toLowerCase();
      const inputs = head.map((s) => s.toLowerCase());
      const desc = trimmed.slice(colonIdx + 1).trim();
      result.steps.push({ id, inputs, desc });
    }
  }

  return result;
}

// ---------- Layout ----------
// Produces: { rows: [ {segments:[{startCol,endCol,label,kind,gray}], } ], maxCol }

function layout(parsed) {
  const { ingredients, steps } = parsed;

  // usage count per id (how many times referenced as input, across all steps)
  const totalUses = new Map();
  for (const step of steps) {
    for (const inp of step.inputs) {
      totalUses.set(inp, (totalUses.get(inp) || 0) + 1);
    }
  }

  // instance registry: base id -> { usesSoFar, currentInstance }
  // an "instance" = { row, startCol, label, kind }
  const instanceState = new Map(); // id -> {usesSoFar:0, activeInstance: {...}}
  const rows = []; // array of {segments:[]}

  function newRow() {
    rows.push({ segments: [] });
    return rows.length - 1;
  }

  function openSegment(row, startCol, label, kind, gray) {
    rows[row].segments.push({ startCol, endCol: null, label, kind, gray: !!gray });
  }

  function closeOpenSegment(row, endCol) {
    const segs = rows[row].segments;
    const seg = segs[segs.length - 1];
    if (seg && seg.endCol === null) seg.endCol = endCol;
  }

  // seed ingredient base instances lazily (only created when first referenced,
  // OR if never referenced, still shown as a leftover row at the end)
  const ingredientRow = new Map(); // key -> row
  const ingredientColumn = 0;

  function ensureIngredientInstance(key) {
    if (ingredientRow.has(key)) return ingredientRow.get(key);
    const ing = ingredients.get(key);
    const row = newRow();
    const label = ing
      ? formatIngredient(ing, parsed.mult)
      : `? ${key}`;
    openSegment(row, ingredientColumn, label, "ingredient", false);
    ingredientRow.set(key, row);
    instanceState.set(key, { usesSoFar: 0, row, col: ingredientColumn });
    return row;
  }

  // resolve an input reference at a given consuming column.
  // returns {row} of the instance to merge, and closes it appropriately.
  function resolveInput(id, atCol) {
    // make sure the base thing exists (ingredient leaf or step already processed)
    if (!instanceState.has(id)) {
      // must be an ingredient not yet touched
      ensureIngredientInstance(id);
    }
    const state = instanceState.get(id);
    state.usesSoFar += 1;

    if (state.usesSoFar === 1) {
      // first use: consume the instance's own row directly
      closeOpenSegment(state.row, atCol);
      return state.row;
    } else {
      // reuse: mirror the history of the original row into a fresh
      // duplicate row, marked with a small copy icon.
      const dupRow = newRow();
      const allSegments = rows[state.row].segments;
      // Only mirror THIS id's own lineage. state.row may since have become
      // a shared trunk row for a sibling merge (another step that also
      // consumed this id) — that sibling's segment has startCol > state.col
      // and must not be copied into the duplicate.
      const ownSegments = allSegments.filter((seg) => seg.startCol <= state.col);
      ownSegments.forEach((seg, i) => {
        const isLast = i === ownSegments.length - 1;
        // The last segment in this id's own history is extended up to the
        // point of reuse (atCol) even if it was already closed earlier —
        // otherwise the dormant gap between when it closed and now renders
        // as a stray empty cell.
        const endCol = isLast ? atCol : seg.endCol;
        rows[dupRow].segments.push({
          startCol: seg.startCol,
          endCol,
          label: i === 0 ? "\u29C9 " + seg.label : seg.label,
          kind: seg.kind,
          gray: false,
          isDuplicate: true,
        });
      });
      return dupRow;
    }
  }

  let col = 1; // column 0 reserved for raw ingredients
  // Tracks, per step id, the full vertical row-range [minR,maxR] its own
  // merge cell already occupies — so a LATER step consuming that id knows
  // to swallow the whole range, not just the id's own anchor row.
  const stepBlock = new Map();
  for (const step of steps) {
    const consumedRows = step.inputs.map((inp) => resolveInput(inp, col));

    // The true vertical extent this step needs to swallow. A plain
    // ingredient (or a fresh duplicate row) only occupies its own single
    // row. But if an input is itself the output of an earlier merge step
    // that already rowspans several rows, a later step consuming it must
    // swallow that FULL range too — otherwise rows "trapped" inside that
    // earlier block are left with no cell at this column (stray empties),
    // and this step's own rowspan won't stretch to cover them either.
    let minR = Infinity;
    let maxR = -Infinity;
    step.inputs.forEach((inp, idx) => {
      const r = consumedRows[idx];
      let blockMax = r;
      const prior = stepBlock.get(inp);
      // Only inherit the prior block's extent if this input is still
      // living on that block's own anchor row — a freshly spun-off
      // duplicate row is always a single row on its own.
      if (prior && prior[0] === r) blockMax = prior[1];
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, blockMax);
    });
    const ownerRow = consumedRows.length ? minR : newRow();
    if (!consumedRows.length) {
      minR = ownerRow;
      maxR = ownerRow;
    }

    openSegment(ownerRow, col, step.desc || step.id, "step", false);
    instanceState.set(step.id, {
      usesSoFar: 0,
      row: ownerRow,
      col: col,
      label: step.desc || step.id,
    });
    step._ownerRow = ownerRow;
    step._consumedRows = consumedRows;
    step._blockMinR = minR;
    step._blockMaxR = maxR;
    step._col = col;
    stepBlock.set(step.id, [minR, maxR]);
    col += 1;
  }

  const maxCol = col; // one past last used column

  // close any still-open segments (final product / unused leftovers) at maxCol
  for (const row of rows) {
    const seg = row.segments[row.segments.length - 1];
    if (seg && seg.endCol === null) seg.endCol = maxCol;
  }

  return { rows, maxCol, steps };
}

function formatIngredient(ing, mult) {
  const settings = window.__gridCookingSettings || DEFAULT_SETTINGS;
  let numStr = "";
  if (!ing.isX && ing.num !== null) {
    const scaled = ing.num * mult;
    numStr = trimNum(scaled);
  }
  const parts =
    settings.ingredientDisplayOrder === "label-num-unit"
      ? [ing.label, numStr, ing.unit]
      : [numStr, ing.unit, ing.label];
  return parts.filter(Boolean).join(" ");
}

function trimNum(n) {
  return Math.round(n * 1000) / 1000 + "";
}

// ---------- Rendering ----------

function renderIngredientTable(container, parsed) {
  const table = container.createEl("table", { cls: "gc-ingredients" });
  const tbody = table.createEl("tbody");
  for (const ing of parsed.ingredients.values()) {
    const tr = tbody.createEl("tr");
    tr.createEl("td", { text: formatIngredient(ing, parsed.mult), cls: "gc-ing-cell" });
  }
}

function renderGrid(container, layoutResult) {
  const { rows, maxCol } = layoutResult;

  // Build matrix[row][col] with 'covered' or 'start' markers.
  const matrix = rows.map(() => new Array(maxCol).fill(null));

  // First pass: mark simple per-row segments (colspan only, rowspan=1)
  rows.forEach((row, r) => {
    for (const seg of row.segments) {
      for (let c = seg.startCol; c < seg.endCol; c++) {
        matrix[r][c] = { covered: true };
      }
      matrix[r][seg.startCol] = {
        start: true,
        colspan: seg.endCol - seg.startCol,
        rowspan: 1,
        label: seg.label,
        kind: seg.kind,
        gray: seg.gray,
      };
    }
  });

  // Second pass: apply merge rowspans at each step's column, across the
  // contiguous min..max row range of its consumed rows (v1 simplification),
  // widened to include any nested block a consumed input already spans
  // (see _blockMinR/_blockMaxR in layout()).
  for (const step of layoutResult.steps) {
    const consumed = step._consumedRows;
    if (!consumed || consumed.length < 2) continue;
    const minR = step._blockMinR;
    const maxR = step._blockMaxR;
    const c = step._col;
    const span = maxR - minR + 1;
    // The owner cell may itself span more than one column (if it stayed
    // "open" across several columns before being consumed here) — swallow
    // that same width for every other row in the range, or a sliver of
    // those columns is left uncovered for them too.
    const ownerCell = matrix[step._ownerRow][c];
    const width = ownerCell && ownerCell.start ? ownerCell.colspan : 1;
    for (let r = minR; r <= maxR; r++) {
      if (r === step._ownerRow) {
        if (matrix[r][c] && matrix[r][c].start) matrix[r][c].rowspan = span;
      } else {
        for (let cc = c; cc < c + width; cc++) {
          matrix[r][cc] = { covered: true };
        }
      }
    }
  }

  // Third pass: once only ONE row still has any content from column c
  // onward, let that row's cells stretch down to fill the remaining table
  // height instead of leaving dead whitespace next to a thin single lane.
  const totalRows = rows.length;
  const lastEndCol = rows.map((row) =>
    row.segments.length ? row.segments[row.segments.length - 1].endCol : 0
  );
  for (let c = 0; c < maxCol; c++) {
    const survivors = [];
    for (let r = 0; r < totalRows; r++) {
      if (lastEndCol[r] > c) survivors.push(r);
    }
    if (survivors.length !== 1) continue;
    const r = survivors[0];
    const cell = matrix[r][c];
    if (cell && cell.start && cell.rowspan === 1) {
      const newSpan = totalRows - r;
      cell.rowspan = newSpan;
      for (let r2 = r + 1; r2 < totalRows; r2++) {
        matrix[r2][c] = { covered: true };
      }
    }
  }

  const table = container.createEl("table", { cls: "gc-grid" });
  const tbody = table.createEl("tbody");
  for (let r = 0; r < rows.length; r++) {
    const tr = tbody.createEl("tr");
    for (let c = 0; c < maxCol; c++) {
      const cell = matrix[r][c];
      if (cell && cell.covered) continue; // reserved by a rowspan/colspan above/left
      if (!cell) {
        // genuinely empty grid position: still needs a placeholder <td> or
        // every later row silently shifts columns leftward in the browser.
        tr.createEl("td", { cls: "gc-empty" });
        continue;
      }
      const td = tr.createEl("td", { text: cell.label });
      if (cell.colspan > 1) td.colSpan = cell.colspan;
      if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
      td.addClass("gc-cell");
      td.addClass("gc-" + cell.kind);
      if (cell.gray) td.addClass("gc-gray");
      if (cell.isDuplicate) td.addClass("gc-duplicate-row");
    }
  }
}

// ---------- Plugin ----------

module.exports = class GridCookingPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    window.__gridCookingSettings = this.settings;

    this.registerMarkdownCodeBlockProcessor("gridcooking", (source, el) => {
      try {
        const parsed = parseBlock(source);
        const wrapper = el.createDiv({ cls: "gc-wrapper" });
        wrapper.createEl("h4", { text: parsed.name || "(unnamed recipe)" });
        renderIngredientTable(wrapper, parsed);
        const layoutResult = layout(parsed);
        renderGrid(wrapper, layoutResult);
      } catch (e) {
        el.createEl("pre", { text: "Grid Cooking error: " + e.message });
        console.error(e);
      }
    });

    this.addCommand({
      id: "grid-cooking-create-recipe",
      name: "Create Recipe",
      editorCallback: (editor) => {
        const template =
          "```gridcooking\nname: New Recipe\nmult: 1\n\ningredients:\n  a: 100 g Ingredient\n\nrecepie:\n  A a: description\n```\n";
        editor.replaceSelection(template);
      },
    });

    this.addCommand({
      id: "grid-cooking-add-multiplier",
      name: "Add Multiplier line",
      editorCallback: (editor) => {
        const cursor = editor.getCursor();
        const totalLines = editor.lineCount();
        let fenceStart = -1;
        let fenceEnd = -1;
        for (let i = cursor.line; i >= 0; i--) {
          if (/^```gridcooking\s*$/.test(editor.getLine(i))) {
            fenceStart = i;
            break;
          }
          if (/^```\s*$/.test(editor.getLine(i))) break;
        }
        if (fenceStart === -1) {
          new Notice("Cursor is not inside a gridcooking block.");
          return;
        }
        for (let i = fenceStart + 1; i < totalLines; i++) {
          if (/^```\s*$/.test(editor.getLine(i))) {
            fenceEnd = i;
            break;
          }
        }
        let hasMult = false;
        let nameLine = -1;
        for (let i = fenceStart + 1; i < fenceEnd; i++) {
          const line = editor.getLine(i);
          if (/^\s*mult:/.test(line)) hasMult = true;
          if (/^\s*name:/.test(line)) nameLine = i;
        }
        if (hasMult) {
          new Notice("mult: line already present.");
          return;
        }
        const insertAt = nameLine !== -1 ? nameLine + 1 : fenceStart + 1;
        editor.replaceRange("mult: 1\n", { line: insertAt, ch: 0 });
      },
    });

    this.addSettingTab(new GridCookingSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    window.__gridCookingSettings = this.settings;
  }
};

class GridCookingSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Grid Cooking Settings" });

    new Setting(containerEl)
      .setName("Ingredient display order")
      .setDesc("How ingredient lines are rendered.")
      .addDropdown((drop) => {
        drop
          .addOption("num-unit-label", "Number, Unit, Label (500 g Mascarpone)")
          .addOption("label-num-unit", "Label, Number, Unit (Mascarpone 500 g)")
          .setValue(this.plugin.settings.ingredientDisplayOrder)
          .onChange(async (value) => {
            this.plugin.settings.ingredientDisplayOrder = value;
            await this.plugin.saveSettings();
          });
      });
  }
}