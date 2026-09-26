import type { ReactNode } from 'react';

/**
 * Line icons for the application shell.
 *
 * VENDORED PATH DATA, NOT A DEPENDENCY. These are the handful of Lucide icons
 * (ISC licence; see docs/DEPENDENCIES.md) the shell actually draws, copied as
 * plain SVG path strings. An icon package would bring hundreds of glyphs and a
 * component runtime to draw thirty, and the shell would then depend on its
 * tree-shaking working to stay small.
 *
 * DECORATIVE BY CONSTRUCTION. Every icon is `aria-hidden`: the control that
 * holds it carries the accessible name, so a screen reader never reads a
 * glyph's path as if it were a label.
 */

type Shape =
  | { readonly kind: 'path'; readonly d: string }
  | { readonly kind: 'circle'; readonly cx: number; readonly cy: number; readonly r: number }
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx: number;
    }
  | {
      readonly kind: 'ellipse';
      readonly cx: number;
      readonly cy: number;
      readonly rx: number;
      readonly ry: number;
    };

const path = (...ds: readonly string[]): Shape[] => ds.map((d) => ({ kind: 'path', d }));
const circle = (cx: number, cy: number, r: number): Shape => ({ kind: 'circle', cx, cy, r });
const rect = (x: number, y: number, width: number, height: number, rx: number): Shape => ({
  kind: 'rect',
  x,
  y,
  width,
  height,
  rx,
});

const ICONS = {
  repair: path(
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  ),
  convert: path('M8 3 4 7l4 4', 'M4 7h16', 'm16 21 4-4-4-4', 'M20 17H4'),
  split: [
    circle(6, 6, 3),
    circle(6, 18, 3),
    ...path('M20 4 8.12 15.88', 'M14.47 14.48 20 20', 'M8.12 8.12 12 12'),
  ],
  texture: path(
    'M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1',
    'M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1',
    'M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1',
  ),
  hollow: path(
    'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z',
    'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65',
    'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65',
  ),
  open: path(
    'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2',
  ),
  download: path('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'),
  upload: path('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'),
  settings: [
    ...path(
      'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    ),
    circle(12, 12, 3),
  ],
  help: [circle(12, 12, 10), ...path('M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01')],
  'chev-down': path('m6 9 6 6 6-6'),
  'chev-right': path('m9 18 6-6-6-6'),
  'chev-left': path('m15 18-6-6 6-6'),
  target: [circle(12, 12, 10), circle(12, 12, 6), circle(12, 12, 2)],
  zap: path(
    'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
  ),
  scan: [
    ...path(
      'M3 7V5a2 2 0 0 1 2-2h2',
      'M17 3h2a2 2 0 0 1 2 2v2',
      'M21 17v2a2 2 0 0 1-2 2h-2',
      'M7 21H5a2 2 0 0 1-2-2v-2',
    ),
    circle(12, 12, 3),
    ...path('m16 16-1.9-1.9'),
  ],
  orbit: [
    { kind: 'ellipse', cx: 12, cy: 12, rx: 10, ry: 4.5 },
    circle(12, 12, 2.5),
    ...path('M17.5 5.2 20 7.3l-3 .9'),
  ],
  pan: path(
    'M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2',
    'M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2',
    'M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8',
    'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
  ),
  fit: [
    ...path(
      'M8 3H5a2 2 0 0 0-2 2v3',
      'M21 8V5a2 2 0 0 0-2-2h-3',
      'M3 16v3a2 2 0 0 0 2 2h3',
      'M16 21h3a2 2 0 0 0 2-2v-3',
    ),
    rect(8, 8, 8, 8, 1),
  ],
  home: path(
    'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8',
    'M3 10a2 2 0 0 1 .71-1.53l7-6a2 2 0 0 1 2.58 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  ),
  compare: [rect(3, 3, 18, 18, 2), ...path('M12 3v18')],
  panel: [rect(3, 3, 18, 18, 2), ...path('M15 3v18')],
  'panel-left': [rect(3, 3, 18, 18, 2), ...path('M9 3v18')],
  cube: path(
    'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
    'm3.3 7 8.7 5 8.7-5',
    'M12 22V12',
  ),
  lock: [rect(3, 11, 18, 11, 2), ...path('M7 11V7a5 5 0 0 1 10 0v4')],
  history: path('M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'),
  loader: path('M21 12a9 9 0 1 1-6.22-8.56'),
  x: path('M18 6 6 18', 'M6 6l12 12'),
  alert: path(
    'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
    'M12 9v4',
    'M12 17h.01',
  ),
  ok: [circle(12, 12, 10), ...path('m9 12 2 2 4-4')],
  error: [circle(12, 12, 10), ...path('m15 9-6 6', 'm9 9 6 6')],
  info: [circle(12, 12, 10), ...path('M12 16v-4', 'M12 8h.01')],
} as const satisfies Readonly<Record<string, readonly Shape[]>>;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  readonly name: IconName;
  /** Rendered edge length in CSS pixels. */
  readonly size?: number;
  readonly className?: string;
}

export function Icon({ name, size = 16, className }: IconProps): ReactNode {
  const shapes: readonly Shape[] = ICONS[name];
  return (
    <svg
      className={className === undefined ? 'icon' : `icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes.map((shape, index) => {
        switch (shape.kind) {
          case 'path':
            return <path key={index} d={shape.d} />;
          case 'circle':
            return <circle key={index} cx={shape.cx} cy={shape.cy} r={shape.r} />;
          case 'rect':
            return (
              <rect
                key={index}
                x={shape.x}
                y={shape.y}
                width={shape.width}
                height={shape.height}
                rx={shape.rx}
              />
            );
          case 'ellipse':
            return <ellipse key={index} cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} />;
        }
      })}
    </svg>
  );
}
