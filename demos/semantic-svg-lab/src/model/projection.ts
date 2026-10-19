import type { Point, Rect } from "./circuit";

export interface Camera {
  scale: number;
  x: number;
  y: number;
}
export interface ViewSize {
  width: number;
  height: number;
}
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Keep symbols readable in narrow panes; the overview still shows the entire circuit. */
export function cameraFor(size: ViewSize, zoom: number, pan: Point): Camera {
  const base = Math.max(0.7, size.width / 1000);
  const scale = base * zoom;
  const centerX = Math.min(500, size.width / (2 * base) + 60) + pan.x;
  return { scale, x: size.width / 2 - centerX * scale, y: size.height / 2 - (260 + pan.y) * scale };
}
export function project(point: Point, camera: Camera): Point {
  return { x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y };
}
export function unproject(point: Point, camera: Camera): Point {
  return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale };
}
export function cameraTransform(camera: Camera): string {
  return `translate(${camera.x} ${camera.y}) scale(${camera.scale})`;
}
export function lensBox(size: ViewSize, position: Point): Rect {
  const width = Math.min(320, size.width - 24);
  const height = Math.min(420, size.height - 52);
  return {
    x: clamp(position.x * size.width - width / 2, 12, size.width - width - 12),
    y: clamp(position.y * size.height - height / 2, 36, size.height - height - 12),
    width,
    height,
  };
}
export function lensCamera(camera: Camera, box: Rect, magnification: number): Camera {
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return {
    scale: camera.scale * magnification,
    x: center.x + (camera.x - center.x) * magnification,
    y: center.y + (camera.y - center.y) * magnification,
  };
}
export function viewportBounds(camera: Camera, size: ViewSize): Rect {
  return {
    ...unproject({ x: 0, y: 0 }, camera),
    width: size.width / camera.scale,
    height: size.height / camera.scale,
  };
}
export function contains(box: Rect, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}
