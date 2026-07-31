# WebWorld

**A browser-based Minecraft world editor — a lightweight WorldEdit in your tab.**

WebWorld is a production-grade voxel world editor built on Three.js and TypeScript. It renders large
worlds (512×512×256 and beyond) at 60 FPS using chunked greedy meshing in Web Workers, gives you a
complete WorldEdit-style toolset, and includes an AI assistant that compiles plain English into
*reviewable editor operations* rather than opaque geometry.

Block textures are authentic: a build-time pipeline reads Mojang's official version manifest,
downloads the `client.jar` for the Minecraft version you choose, and packs its block textures into an
atlas.

---

## Quick start

```bash
npm install
npm run assets      # optional but recommended — fetches real Minecraft textures
npm run dev         # http://localhost:5173
```

Without `npm run assets` the editor still works: it generates a procedural colour atlas from the
block registry's palette so nothing is blocked on a download.

```bash
npm run build       # typecheck + production bundle into dist/
npm run preview     # serve the production build
npm run typecheck   # tsc --noEmit
npm run test:all    # 143 checks (logic + render path)
```

### Fetching Minecraft textures

The asset pipeline talks to `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json`,
resolves the version you pick, downloads its `client.jar`, extracts
`assets/minecraft/textures/block/*.png`, normalises them (first frame of animated strips, hi-res packs
downsampled to 16×16) and writes `public/assets/atlas.png` + `atlas.json`.

```bash
npm run assets                # interactive picker of recent releases
npm run assets -- 1.21.1      # explicit version
npm run assets -- --latest    # latest release
npm run assets -- --list      # list available versions
```

The downloaded jar is cached in `.cache/` and everything it produces is gitignored. Minecraft assets
are Mojang's property and are never committed to this repository — each user fetches them locally.

---

## Feature tour

### Editing

| Tool | Key | What it does |
|---|---|---|
| Select | `1` | LMB sets pos 1, RMB sets pos 2. Shift+click banks the region into a multi-selection. |
| Place / Break | `2` | LMB breaks, RMB places. Drag to paint. |
| Brush | `3` | Sphere / cube / cylinder, adjustable radius, hollow mode, air-only masking. |
| Fill | `4` | Fills the selection (also `Enter`). RMB fills with air. |
| Replace | `5` | Swap one block for another across the selection; RMB picks the source block. |
| Sculpt | `6` | Raise/lower terrain with a cosine-falloff brush; Ctrl smooths. |
| Paint Biome | `7` | Repaints the surface with a layered biome recipe (10 biomes). |
| Eyedropper | `8` | Picks the clicked block as active. |
| Line | `9` | Two-click 3D Bresenham line with live preview. |
| Shape | `0` | Sphere, cylinder, pyramid or box generator, solid or hollow. |
| Flood Fill | `-` | Replaces a connected volume of identical blocks. |
| Stamp | `=` | Pastes the clipboard with a live translucent preview. |

Plus: walls, hollow shell, smooth, expand/contract, stack, move, rotate 90°, mirror on any axis,
copy / cut / paste (with clipboard rotate and mirror), select-all, selection content analysis, and
unlimited undo/redo.

### Camera

Fly mode (WASD + Space/Shift, Ctrl to sprint, RMB or pointer-lock to look, scroll to change speed) and
orbit mode (`O` to toggle). `F` frames the selection. Grid snapping and a toggleable ground grid.

### AI assistant

Type into the top command bar. Prompts are compiled into a JSON plan of editor operations, rendered as
a translucent instanced preview, and only written to the world when you press **Apply** — as a single
undoable transaction.

```
Build a medieval castle here
Create a huge snowy mountain
Plant a dense forest
Replace all stone with mossy cobblestone
Generate a river
Terraform this into rolling hills
Build a rustic village of 10 houses
Dig a large lake here
Build a glass dome radius 20
Flatten this area
```

The planner is **local, deterministic and offline** — no API key needed. You can optionally point it at
any OpenAI-compatible endpoint (Properties → World → AI assistant); the model is asked to emit the
same plan schema, and its response is validated against the local operation registry, so a model can
never trigger behaviour the editor doesn't already implement.

Because preview and commit replay the identical resolved block writes with the identical seed, what
you see is exactly what you get.

### Interop

- **Projects** — `Ctrl+S` / `Ctrl+O`. JSON with palette + run-length encoded chunks, referencing blocks
  by Minecraft name so projects survive registry changes. Autosaves to `localStorage` every 90s.
- **Schematics** — export the selection as Sponge `.schem` v2 (gzipped NBT); import Sponge v2/v3 and
  legacy MCEdit `.schematic`. Round-trip tested block-for-block.
- **NBT** — a complete little-endian-free (Java, big-endian) NBT reader/writer including every array
  type, gzip via native `CompressionStream`.

---

## Keyboard shortcuts

Press `?` in the app for the full list.

| | |
|---|---|
| `W A S D` / `Space` / `Shift` | Fly |
| `Ctrl` (hold) | Sprint |
| `O` / `F` / `G` | Orbit toggle / focus selection / grid |
| `1`…`0`, `-`, `=` | Switch tool |
| `Q` / `E` | Brush radius |
| `Shift`+`1`…`9` | Hotbar slot |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+C` / `X` / `V` | Copy / cut / paste |
| `Ctrl+A` / `Enter` / `Delete` | Select all / fill / clear |
| `Ctrl+R` / `Ctrl+M` | Rotate / mirror clipboard |
| `Ctrl+K` | Focus the AI command bar |
| `Ctrl+S` / `Ctrl+O` | Save / open project |
| `Esc` | Clear selection & preview |

---

## Architecture

Modular ECS-style systems communicating over typed event buses. Each system depends only on narrow
interfaces, which is what makes the roadmap items (multiplayer, plugins, block packs) additive rather
than invasive.

```
src/
├── core/          types (Vec3, Region, BlockChange), typed EventBus
├── world/
│   ├── blocks.ts      block registry: ids, MC names, categories, per-face textures
│   ├── chunk.ts       16³ sparse sections, palette+RLE serialization
│   ├── world.ts       infinite chunk grid, mutation API, DDA raycast
│   └── generator.ts   terrain, mountains, hills, forests, rivers
├── render/
│   ├── mesher.ts        greedy meshing + per-vertex AO (pure, testable)
│   ├── mesh.worker.ts   worker wrapper, transferable buffers
│   ├── chunk-renderer.ts worker pool, priority queue, streaming, frustum culling
│   ├── material.ts      patched Lambert shader: atlas tiling + AO
│   ├── atlas.ts         client.jar atlas loader + procedural fallback
│   ├── overlay.ts       cursor, selection, brush footprint, instanced previews
│   └── camera-controller.ts  fly + orbit
├── edit/
│   ├── operations.ts  every mutation as a pure function over a BlockSink
│   ├── editor.ts      the command surface — tools, shortcuts and AI all call this
│   ├── history.ts     delta-based undo journal with a memory budget
│   ├── selection.ts   cuboid + multi-selection
│   ├── tools.ts       tool state machines
│   └── biomes.ts      layered surface recipes
├── input/         pointer→tool routing, picking, WorldEdit-style keybinds
├── ai/
│   ├── intents.ts     the operation schema (the AI's contract)
│   ├── parser.ts      offline rule-based prompt compiler
│   ├── structures.ts  castle, village, house, tower, bridge, wall, pyramid, dome
│   ├── provider.ts    optional LLM bridge + response validation
│   └── assistant.ts   plan → preview → accept pipeline
├── io/            nbt.ts, schematic.ts, project.ts
└── ui/            dom.ts, palette.ts, command-bar.ts, properties.ts, shell.ts, styles.css
```

### Key design decisions

**`BlockSink` indirection.** Every operation writes through a sink interface. `WorldSink` mutates the
world; `PreviewSink` accumulates a block list. This one abstraction is why *every* operation —
including all AI structures — is previewable for free, with no duplicated "preview version" of any
generator.

**Deltas, not snapshots.** Undo records `{x,y,z,before,after}` tuples captured by the world's batch
recorder, so a 2-million-block terraform costs only the blocks it actually changed.

**Padded volumes.** Chunks are meshed from an 18³ volume (the chunk plus one block of each neighbour),
so the worker can cull faces against adjacent chunks with zero cross-chunk locking.

**Blocks by name at rest.** Chunk storage uses `Uint16` runtime ids for speed, but every serialized
form (project JSON, `.schem`) references `minecraft:` names.

---

## Performance

- Greedy meshing — a solid 16³ chunk collapses to **6 quads** (verified by test)
- Per-face culling against neighbours, plus per-vertex ambient occlusion
- A pool of `hardwareConcurrency-1` mesh workers with nearest-chunk-first scheduling
- Frustum culling, streaming view distance, and GPU unload outside the radius
- Sparse chunks: an empty section allocates nothing; it frees its array when it empties
- Instanced rendering for previews and overlays — a 350k-block AI proposal is one draw call
- Transferable typed arrays: geometry crosses the worker boundary with zero copies

Tunables live in Properties → World (view distance, move speed) and `ChunkRenderer.viewDistance`.

---

## Roadmap

- **Multiplayer collaboration** — the operation schema in `ai/intents.ts` and the delta journal in
  `edit/history.ts` are designed to be serialized onto a CRDT edit stream.
- **Plugin API** — tools already conform to a `Tool` interface and operations to `BlockSink`; a plugin
  registers into `TOOLS` and the operation table.
- **Custom block packs** — `BlockRegistry.register()` accepts definitions at runtime.
- **Resource packs** — the atlas loader is pluggable; point it at a different packed atlas.
- **AI scripting API** — `AiOperation[]` is already the scripting format; exposing
  `assistant.execute()` publicly is the remaining step.

---

## Testing

```bash
npm test          # 97 logic checks
npm run test:render   # 46 render-path checks
npm run test:all      # both
```

**Logic suite (97 checks)**

- **Core/ops** — fill, brush, replace, line, flood fill, clipboard rotate×4 and mirror×2 identities
- **Chunk memory** — lazy allocation on first write, array freed when a section empties
- **Undo journal** — delta capture, undo/redo, nested transactions collapsing to one entry
- **Mesher** — single block → 6 quads / 36 indices; solid 16³ chunk → 6 quads (greedy merge);
  interior culling; neighbour-padding face culling; translucent-pass routing
- **Generators & structures** — terrain, forest, mountain, river, castle, house, village, tower;
  bridges and walls verified gap-free *and* full-width across four span angles
- **AI** — all 10 documented example prompts compile to the right operations; size adjectives scale
  output; garbage input yields an empty plan at confidence 0; remote-plan validation rejects unknown
  operations and strips non-finite numbers
- **IO** — NBT round-trip (all tag types incl. bigint & UTF-8), `.schem` round-trip block-for-block,
  chunk palette+RLE round-trip, project JSON round-trip
- **UI** — atlas fallback, palette rendering/search/filter, DOM helpers, selection semantics

**Render suite (46 checks)**

A GPU isn't available in CI, so this covers everything up to the driver call:

- Mesher output loaded into real `THREE.BufferGeometry` — attribute/index count consistency,
  no out-of-range indices, no NaN, all geometry inside chunk bounds
- The `ChunkRenderer`'s hand-assigned bounding sphere proven to contain every emitted vertex
- Frustum culling checked with real `THREE.Frustum` math (in front / behind / off-axis / beyond far)
- The voxel material's `onBeforeCompile` executed against the **genuine Lambert shader source from the
  installed three version**, asserting every varying declared in the vertex stage is consumed in the
  fragment stage and that the injected GLSL is balanced

That last group guards the one failure mode that presents as a silent black screen: the shader patch
anchors on upstream `#include` tokens, so a `three` upgrade could break rendering without any type or
build error. Verified by fault injection — corrupting the `map_fragment` anchor fails the suite.

**Not covered:** actual GPU rasterisation (no browser in this environment) and the live Mojang
download in `npm run assets` (the extract/pack logic is tested against a synthetic jar; the network
call itself is not).

## License

MIT — see [LICENSE](LICENSE). Minecraft assets fetched by `npm run assets` remain the property of
Mojang Studios and are not distributed with this project.
