import * as THREE from 'three';

/**
 * Procedural textures. Walls are pure white so per-vertex facade colours tint
 * them; windows are dark and only lightly affected by the tint.
 */

function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas not supported');
  draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function repeating(texture: THREE.CanvasTexture): THREE.CanvasTexture {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** One bay × one floor: a window with a sill, surrounded by wall. */
export function createWindowTexture(): THREE.CanvasTexture {
  return repeating(
    canvasTexture(64, 64, (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 64, 64);
      // frame
      ctx.fillStyle = '#e6e6e6';
      ctx.fillRect(16, 10, 32, 38);
      // glass with a subtle reflection gradient
      const glass = ctx.createLinearGradient(18, 12, 46, 46);
      glass.addColorStop(0, '#7f98ab');
      glass.addColorStop(0.45, '#4d6375');
      glass.addColorStop(1, '#3a4b59');
      ctx.fillStyle = glass;
      ctx.fillRect(18, 12, 28, 34);
      // mullions
      ctx.fillStyle = '#e6e6e6';
      ctx.fillRect(31, 12, 2, 34);
      ctx.fillRect(18, 24, 28, 2);
      // sill
      ctx.fillStyle = '#c9c9c9';
      ctx.fillRect(14, 48, 36, 3);
    }),
  );
}

/** Ground-floor shopfront: large glazing with an awning-coloured band on top. */
export function createShopTexture(): THREE.CanvasTexture {
  return repeating(
    canvasTexture(64, 64, (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = '#d8d8d8';
      ctx.fillRect(0, 6, 64, 6);
      const glass = ctx.createLinearGradient(0, 16, 0, 60);
      glass.addColorStop(0, '#5f7687');
      glass.addColorStop(1, '#2f3d48');
      ctx.fillStyle = glass;
      ctx.fillRect(6, 18, 52, 42);
      ctx.fillStyle = '#efefef';
      ctx.fillRect(31, 18, 2, 42);
    }),
  );
}

/** Non-repeating sign with centred text. */
export function createSignTexture(text: string, background: string, foreground: string): THREE.CanvasTexture {
  return canvasTexture(512, 96, (ctx) => {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, 512, 96);
    ctx.fillStyle = foreground;
    ctx.font = 'bold 58px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 52);
  });
}

export interface SignStyle {
  text: string;
  background: string;
  foreground: string;
}

export interface SignAtlas {
  texture: THREE.CanvasTexture;
  /** UV rectangle [u0, v0, u1, v1] of a sign by its text. */
  uv: Map<string, [number, number, number, number]>;
  /** Width / height of every sign cell. */
  aspect: number;
}

/** All shop and landmark signs in one texture, so they render in a single draw call. */
export function createSignAtlas(styles: readonly SignStyle[]): SignAtlas {
  const cellW = 512;
  const cellH = 96;
  const canvas = document.createElement('canvas');
  canvas.width = cellW;
  canvas.height = cellH * styles.length;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas not supported');
  const uv = new Map<string, [number, number, number, number]>();
  styles.forEach((style, i) => {
    const y = i * cellH;
    ctx.fillStyle = style.background;
    ctx.fillRect(0, y, cellW, cellH);
    ctx.fillStyle = style.foreground;
    ctx.font = `bold ${style.text.length > 10 ? 48 : 58}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.text, cellW / 2, y + cellH / 2 + 3, cellW - 24);
    // Canvas y grows downwards, texture v upwards.
    const v1 = 1 - y / canvas.height;
    const v0 = 1 - (y + cellH) / canvas.height;
    uv.set(style.text, [0.004, v0 + 0.002, 0.996, v1 - 0.002]);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { texture, uv, aspect: cellW / cellH };
}
