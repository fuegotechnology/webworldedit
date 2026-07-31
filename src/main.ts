/**
 * Entry point. Boots the application and reports fatal errors to the user
 * instead of failing silently to a black canvas.
 */

import { WebWorldApp } from './app';

async function main(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
  const uiRoot = document.getElementById('ui-root');
  const boot = document.getElementById('boot');

  if (!canvas || !uiRoot) throw new Error('missing #viewport or #ui-root in the document');

  if (!('WebGL2RenderingContext' in window) || !canvas.getContext('webgl2')) {
    if (boot) boot.textContent = 'WebWorld needs WebGL2, which this browser does not support.';
    return;
  }

  try {
    const app = await WebWorldApp.create(canvas, uiRoot);
    (window as unknown as { webworld: WebWorldApp }).webworld = app;
    boot?.classList.add('hidden');
    setTimeout(() => boot?.remove(), 500);
    console.info('%cWebWorld ready', 'color:#4da3ff;font-weight:600', '— press ? for shortcuts');
  } catch (err) {
    console.error(err);
    if (boot) {
      boot.classList.remove('hidden');
      boot.textContent = `WebWorld failed to start: ${(err as Error).message}`;
    }
  }
}

void main();
