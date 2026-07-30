/**
 * Application composition root.
 *
 * Instantiates every system, wires them through their event buses, and owns the
 * render loop. This is the only file that knows about all the systems at once —
 * everything else depends on narrow interfaces, which is what keeps the
 * architecture extensible (multiplayer, plugins and custom block packs all plug
 * in here).
 */

import * as THREE from 'three';

import { World } from './world/world';
import { WorldSink } from './edit/operations';
import { generateStarterWorld } from './world/generator';
import { loadAtlas, type Atlas } from './render/atlas';
import { ChunkRenderer } from './render/chunk-renderer';
import { Overlay } from './render/overlay';
import { CameraController } from './render/camera-controller';
import { Editor } from './edit/editor';
import { InputSystem } from './input/input';
import { AiAssistant } from './ai/assistant';
import { BlockPalette } from './ui/palette';
import { CommandBar, type Command } from './ui/command-bar';
import { PropertiesPanel } from './ui/properties';
import { HelpModal, Hotbar, StatusBar, Toasts, Toolbar, createCrosshair } from './ui/shell';
import {
  autosave,
  deserializeProject,
  downloadBlob,
  downloadJson,
  loadAutosave,
  pickFile,
  serializeProject,
} from './io/project';
import { detectAndRead, schematicToWorld, writeSchematic } from './io/schematic';
import { vec3 } from './core/types';

export class WebWorldApp {
  readonly world: World;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: CameraController;
  readonly chunks: ChunkRenderer;
  readonly overlay: Overlay;
  readonly editor: Editor;
  readonly input: InputSystem;
  readonly assistant: AiAssistant;

  private canvas: HTMLCanvasElement;
  private uiRoot: HTMLElement;
  private atlas: Atlas;
  private properties!: PropertiesPanel;
  private statusBar!: StatusBar;
  private toasts!: Toasts;
  private crosshair!: HTMLElement;
  private clock = new THREE.Clock();
  private frames = 0;
  private fps = 60;
  private lastFpsSample = performance.now();
  private lastAutosave = 0;
  private running = false;

  private constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, atlas: Atlas) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.atlas = atlas;

    // ---- rendering
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x0b0d12, 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x121722);
    this.scene.fog = new THREE.Fog(0x121722, 260, 620);

    // ---- world
    this.world = new World();
    this.camera = new CameraController(canvas);
    this.overlay = new Overlay();
    this.chunks = new ChunkRenderer(this.world, atlas);

    this.scene.add(this.chunks.group);
    this.scene.add(this.overlay.group);
    this.setupLighting();

    // ---- editing
    this.editor = new Editor(this.world, this.overlay, this.camera);
    this.assistant = new AiAssistant(this.editor);
    this.input = new InputSystem(canvas, this.editor, this.camera);

    this.buildUi();
    this.bindGlobalEvents();
    this.resize();
  }

  static async create(canvas: HTMLCanvasElement, uiRoot: HTMLElement): Promise<WebWorldApp> {
    const atlas = await loadAtlas();
    const app = new WebWorldApp(canvas, uiRoot, atlas);
    app.bootstrapWorld();
    app.start();
    return app;
  }

  // ------------------------------------------------------------- lighting

  private setupLighting(): void {
    const hemi = new THREE.HemisphereLight(0xdfeaff, 0x3b3f4a, 1.15);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff3e0, 1.35);
    sun.position.set(0.6, 1, 0.35).normalize().multiplyScalar(200);
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x9fb6ff, 0.35);
    fill.position.set(-0.5, 0.4, -0.6).normalize().multiplyScalar(200);
    this.scene.add(fill);
  }

  // ------------------------------------------------------------------- ui

  private buildUi(): void {
    const palette = new BlockPalette({
      atlas: this.atlas,
      onPick: (block) => this.editor.setActiveBlock(block.id),
      onSecondary: (block) => this.editor.assignHotbar(this.editor.settings.hotbarIndex, block.id),
    });
    palette.setActive(this.editor.settings.activeBlock);
    this.editor.events.on('settings:changed', (s) => palette.setActive(s.activeBlock));

    const toolbar = new Toolbar(this.editor);
    const hotbar = new Hotbar(this.editor, palette);
    this.statusBar = new StatusBar(this.editor);
    this.toasts = new Toasts(this.editor);
    const help = new HelpModal();
    this.crosshair = createCrosshair();

    this.properties = new PropertiesPanel({
      editor: this.editor,
      camera: this.camera,
      renderer: this.chunks,
      assistant: this.assistant,
      palette,
      onSave: () => this.saveProject(),
      onLoad: () => this.loadProject(),
      onExportSchem: () => this.exportSchematic(),
      onImportSchem: () => this.importSchematic(),
      onNewWorld: () => this.newWorld(),
      onShowHelp: () => help.show(),
    });

    const commandBar = new CommandBar(this.editor, this.assistant, this.buildCommands(help));

    this.uiRoot.append(
      commandBar.root,
      toolbar.root,
      this.properties.root,
      hotbar.root,
      this.statusBar.root,
      this.toasts.root,
      this.crosshair,
      help.root,
    );
  }

  private buildCommands(help: HelpModal): Command[] {
    const editor = this.editor;
    return [
      { id: 'save', label: 'Save project as JSON', hint: 'file', run: () => this.saveProject() },
      { id: 'open', label: 'Open project JSON', hint: 'file', run: () => this.loadProject() },
      { id: 'export', label: 'Export selection as .schem', hint: 'file', run: () => this.exportSchematic() },
      { id: 'import', label: 'Import .schem / .schematic', hint: 'file', run: () => this.importSchematic() },
      { id: 'new', label: 'New world', hint: 'file', run: () => this.newWorld() },
      { id: 'undo', label: 'Undo', hint: 'edit', run: () => editor.undo() },
      { id: 'redo', label: 'Redo', hint: 'edit', run: () => editor.redo() },
      { id: 'fill', label: 'Fill selection', hint: 'edit', run: () => editor.fillSelection() },
      { id: 'clear', label: 'Clear selection to air', hint: 'edit', run: () => editor.fillSelection(0) },
      { id: 'walls', label: 'Build walls around selection', hint: 'edit', run: () => editor.wallsInSelection() },
      { id: 'hollow', label: 'Hollow out selection', hint: 'edit', run: () => editor.hollowSelection() },
      { id: 'smooth', label: 'Smooth selection terrain', hint: 'edit', run: () => editor.smoothSelection() },
      { id: 'copy', label: 'Copy selection', hint: 'edit', run: () => editor.copySelection() },
      { id: 'paste', label: 'Paste clipboard', hint: 'edit', run: () => editor.pasteAtSelection() },
      { id: 'selectall', label: 'Select entire world', hint: 'select', run: () => editor.selectAll() },
      { id: 'deselect', label: 'Clear selection', hint: 'select', run: () => editor.selection.clear() },
      { id: 'focus', label: 'Focus camera on selection', hint: 'view', run: () => editor.focusSelection() },
      {
        id: 'fly',
        label: 'Toggle fly / orbit camera',
        hint: 'view',
        run: () => this.camera.setMode(this.camera.mode === 'fly' ? 'orbit' : 'fly'),
      },
      { id: 'grid', label: 'Toggle grid', hint: 'view', run: () => editor.update({ showGrid: !editor.settings.showGrid }) },
      { id: 'help', label: 'Show keyboard shortcuts', hint: 'help', run: () => help.show() },
    ];
  }

  // -------------------------------------------------------------- lifecycle

  private bindGlobalEvents(): void {
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('webworld:save', () => this.saveProject());
    document.addEventListener('webworld:open', () => this.loadProject());

    // Pointer lock only makes sense in fly mode; show a crosshair while locked.
    this.canvas.addEventListener('dblclick', () => this.camera.requestPointerLock());
    document.addEventListener('pointerlockchange', () => {
      this.crosshair.classList.toggle('visible', document.pointerLockElement === this.canvas);
    });

    window.addEventListener('beforeunload', (event) => {
      if (this.editor.history.entries.length > 0) {
        event.preventDefault();
        event.returnValue = '';
      }
    });

    // Renderer context loss (tab suspension, driver reset).
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.running = false;
      this.editor.notify('WebGL context lost — attempting to restore…', 'error');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.chunks.rebuildAll();
      this.running = true;
      this.loop();
      this.editor.notify('WebGL context restored', 'success');
    });
  }

  private bootstrapWorld(): void {
    const saved = loadAutosave();
    if (saved) {
      try {
        const result = deserializeProject(saved, this.world, this.editor, this.camera);
        this.editor.notify(`Restored autosave "${result.name}" (${result.blocks.toLocaleString()} blocks)`, 'success');
        return;
      } catch {
        this.editor.notify('Autosave was corrupt — starting a new world', 'warn');
      }
    }
    this.generateDefaultWorld();
  }

  private generateDefaultWorld(): void {
    const sink = new WorldSink(this.world);
    generateStarterWorld(this.world, sink, 192);
    this.camera.camera.position.set(60, 96, 60);
    this.camera.lookAt(new THREE.Vector3(0, 62, 0));
    this.editor.history.clear();
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.resize(width, height);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private loop = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);

    const dt = Math.min(0.1, this.clock.getDelta());
    this.camera.update(dt);
    this.chunks.update(this.camera.camera);
    this.input.tick();

    this.renderer.render(this.scene, this.camera.camera);

    // FPS sampling and once-per-second UI refreshes.
    this.frames++;
    const now = performance.now();
    if (now - this.lastFpsSample >= 500) {
      this.fps = (this.frames * 1000) / (now - this.lastFpsSample);
      this.frames = 0;
      this.lastFpsSample = now;
      this.statusBar.update(this.fps, this.camera, this.input.hit?.block ?? null);
      this.properties.updateStats();
    }

    // Autosave every 90 seconds when there is unsaved work.
    if (now - this.lastAutosave > 90_000 && this.editor.history.entries.length > 0) {
      this.lastAutosave = now;
      const project = serializeProject(this.world, this.editor, this.camera, {
        name: 'Autosave',
        minecraftVersion: this.atlas.manifest.version,
      });
      autosave(project);
    }
  };

  // ---------------------------------------------------------------- file io

  saveProject(): void {
    const project = serializeProject(this.world, this.editor, this.camera, {
      name: 'WebWorld Project',
      minecraftVersion: this.atlas.manifest.version,
    });
    downloadJson(project, `webworld-${new Date().toISOString().slice(0, 10)}.json`);
    autosave(project);
    this.editor.notify(`Saved ${project.chunks.length} chunks (${project.stats.blocks.toLocaleString()} blocks)`, 'success');
  }

  async loadProject(): Promise<void> {
    const file = await pickFile('application/json,.json');
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const result = deserializeProject(json, this.world, this.editor, this.camera);
      this.chunks.rebuildAll();
      for (const warning of result.warnings) this.editor.notify(warning, 'warn');
      this.editor.notify(`Loaded "${result.name}" — ${result.blocks.toLocaleString()} blocks`, 'success');
    } catch (err) {
      this.editor.notify(`Could not load project: ${(err as Error).message}`, 'error');
    }
  }

  async exportSchematic(): Promise<void> {
    const region = this.editor.selection.primary ?? this.world.computeBounds();
    if (!region) {
      this.editor.notify('Nothing to export — make a selection first', 'warn');
      return;
    }
    try {
      const bytes = await writeSchematic(this.world, region, { name: 'WebWorld Export' });
      downloadBlob(bytes as BlobPart, `webworld-${Date.now()}.schem`, 'application/octet-stream');
      this.editor.notify('Exported .schem (Sponge v2)', 'success');
    } catch (err) {
      this.editor.notify(`Export failed: ${(err as Error).message}`, 'error');
    }
  }

  async importSchematic(): Promise<void> {
    const file = await pickFile('.schem,.schematic,.nbt');
    if (!file) return;
    try {
      const { data, format } = await detectAndRead(file);
      const at = this.editor.cameraTargetBlock();
      const origin = vec3(at.x, Math.max(this.world.bounds.minY, at.y), at.z);
      const written = this.editor.run(`Import ${file.name}`, () =>
        schematicToWorld(data, this.world, origin, true),
      );
      this.editor.selection.set(
        origin,
        vec3(origin.x + data.width - 1, origin.y + data.height - 1, origin.z + data.length - 1),
      );
      this.editor.focusSelection();
      this.editor.notify(`Imported ${format} — ${written.toLocaleString()} blocks`, 'success');
      if (data.unknownBlocks.length > 0) {
        this.editor.notify(
          `${data.unknownBlocks.length} unmapped block types (${data.unknownBlocks.slice(0, 3).join(', ')}…)`,
          'warn',
        );
      }
    } catch (err) {
      this.editor.notify(`Import failed: ${(err as Error).message}`, 'error');
    }
  }

  newWorld(): void {
    if (!confirm('Discard the current world and start over?')) return;
    this.world.clear();
    this.editor.history.clear();
    this.editor.selection.clear();
    this.generateDefaultWorld();
    this.editor.notify('New world generated', 'success');
  }

  dispose(): void {
    this.stop();
    this.input.dispose();
    this.camera.dispose();
    this.chunks.dispose();
    this.overlay.dispose();
    this.renderer.dispose();
  }
}
