# GitHub Project Description

## Short description (repo "About" field, ~350 chars)

> WebWorld — a browser-based Minecraft world editor. A lightweight WorldEdit in your tab: Three.js instanced/greedy-meshed voxel rendering, chunk streaming with Web Workers, full brush/selection/clipboard toolset, undo–redo, `.schem` import/export, real Minecraft block textures pulled from the official client.jar, and an AI assistant that turns plain English into editor operations.

## Topics / tags

`minecraft` `worldedit` `voxel` `threejs` `typescript` `vite` `web-workers` `greedy-meshing` `level-editor` `schematic` `nbt` `ai-assistant` `webgl`

## Long description (README hero)

**WebWorld** is a production-grade, browser-native Minecraft world editor built on Three.js and TypeScript.
It renders large voxel worlds (512×512×256 and beyond) at 60 FPS using chunked greedy meshing executed in
Web Workers, hardware instancing for previews and gizmos, frustum + face culling, and a streaming chunk
manager that keeps only what you can see resident in GPU memory.

On top of the renderer sits a complete editing stack modelled on WorldEdit: region selections, fill and
replace, sphere/cube/cylinder brushes, terrain sculpting, line and shape generation, biome painting,
eyedropper, copy/cut/paste with rotate and mirror, and an unlimited undo/redo journal that records
compact per-chunk deltas rather than whole-world snapshots.

The AI assistant is not a mesh generator. Natural-language prompts ("build a medieval castle here",
"terraform this into rolling hills", "replace all stone with mossy cobblestone") are compiled into
*the same deterministic editor operations a human would issue*, staged as a translucent preview, and
only committed to the world when you accept them — which means every AI edit is reviewable, undoable,
and scriptable.

Block appearance is authentic: a build-time asset pipeline reads Mojang's official
`version_manifest_v2.json`, downloads the `client.jar` for the Minecraft version you choose, and extracts
block textures into a packed atlas consumed by the renderer.

### Highlights

- **Rendering** — greedy meshing, per-face culling, instanced overlays, worker-driven remesh, frustum culling
- **World** — infinite chunk grid, sparse storage, palette-compressed sections, JSON project save/load
- **Interop** — Sponge `.schem` v2/v3 import & export, gzip NBT reader/writer, structure-friendly palettes
- **Editing** — 12+ tools, multi-selection, grid snapping, WorldEdit-style keybinds
- **AI** — deterministic prompt → operation compiler with preview/accept/reject and a scripting API
- **UI** — modern dark shell: left toolbar, right properties panel, bottom hotbar, top command bar, resizable panels
- **Architecture** — modular ECS-style systems (render, world, edit, input, ai, io, ui) in strict TypeScript

### Roadmap

Multiplayer collaboration (CRDT edit streams) · plugin API · custom block packs · resource pack loading · AI scripting API.
