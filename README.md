# Grid Cooking (v0.1)

A minimal, hand-rolled Obsidian plugin. No build step — `main.js` is plain JS,
loaded directly by Obsidian.

## Install (manual, for testing)

1. In your vault, go to `.obsidian/plugins/` and create a folder `grid-cooking`.
2. Copy `manifest.json`, `main.js`, and `styles.css` into that folder.
3. In Obsidian: Settings → Community plugins → turn off Restricted mode (if on)
   → find "Grid Cooking" in the list → enable it.
4. Reload Obsidian (Ctrl/Cmd+R via the command palette, "Reload app without saving")
   if it doesn't show up immediately.

## Usage

Run the command **"Grid Cooking: Create Recipe"** to insert a template block,
or write one by hand:

```gridcooking
name: Tiramisu
mult: 1

ingredients:
  mas: 500 g Mascarpone
  pis: 2 ks Piškoty
  vjc: 2 ks Vejce
  ckr: 100 g Cukr
  kfe: 2 hrnky Káva
  kao: X posyp Kakao hořké

recepie:
  A vjc: Pasterizovat, 10min, 60C
  B ckr A: Smíchat žloutky a cukr
  C A: sníh z bílků
  D B C mas: Smíchat
  E pis kfe D: Navrstvit do zapékací mísy
  F E kao: Posypat
  G F: Lednice
```

Switch to Reading mode to see the ingredient list and the grid diagram.
Change `mult:` to scale all ingredient amounts (numbers only — `X` amounts,
like "to taste" items, are never scaled).

## Known v1 limitations (by design, to revisit later)

- **Row order** is just "first appearance" order — no crossing-minimization
  pass yet. Works fine for small/medium recipes; branchy ones may look a bit
  arbitrary in vertical ordering (doesn't affect correctness, just tidiness).
- **Merges spanning non-adjacent rows**: if two inputs to a merge aren't
  next to each other in the current row order, the merge cell will currently
  just swallow the row(s) in between too (a "contiguous range" simplification).
  A real fix needs a proper layered-graph reordering pass — planned for v2,
  once we see it actually bite on a real recipe.
- No split-node syntax — put e.g. "yolk only" in a step's description instead;
  reuse via a second reference to the same ingredient/step id already works
  and triggers the gray duplicate-lane rendering.

## Files

- `manifest.json` — plugin metadata
- `main.js` — parser, layout algorithm, renderer, commands, settings
- `styles.css` — grid/table styling (uses Obsidian CSS variables, so it
  follows your theme automatically)
