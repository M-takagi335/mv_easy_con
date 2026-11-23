import { newLayer } from './model.ts';
import type { Animation, Layer, Parameters } from './model.ts';

export type Version = { id: string; name: string; layers: Layer[]; style: number; background: string };
export type AutoMv = { lyrics: string; starts: number[]; end: number | null; versions: Version[]; active: string | null };
export const emptyAutoMv: AutoMv = { lyrics: '', starts: [], end: null, versions: [], active: null };
export const lyricLines = (lyrics: string) => lyrics.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

export function recordStart(starts: number[], time: number, limit: number) {
  const rounded = Math.round(time * 1000) / 1000;
  return rounded >= 0 && rounded > (starts.at(-1) ?? -1) && rounded < limit
    ? [...starts, rounded] : starts;
}

export function editStart(starts: number[], index: number, time: number, end: number) {
  if (!Number.isFinite(time) || time < 0 || time <= (starts[index - 1] ?? -1) ||
      time >= (starts[index + 1] ?? end)) return starts;
  return starts.map((start, i) => i === index ? time : start);
}

const styles = [
  { base: '#101631', tint: '#252d58', accent: '#9caeff', text: '#f6f8ff', y: 525, size: 126, direction: 'down', shape: 'ellipse' },
  { base: '#251218', tint: '#512b30', accent: '#f1a182', text: '#fff3e7', y: 645, size: 103, direction: 'left', shape: 'rectangle' },
  { base: '#092521', tint: '#16453a', accent: '#81dfc1', text: '#effff7', y: 420, size: 118, direction: 'right', shape: 'ellipse' },
  { base: '#20162d', tint: '#3d2857', accent: '#e1abfa', text: '#fff5ff', y: 558, size: 112, direction: 'up', shape: 'rectangle' },
] as const;

function animation(template: string, start: number, end: number, params: Parameters): Animation {
  return { id: crypto.randomUUID(), template, start, end, params };
}

export function generateMv(lines: string[], starts: number[], end: number, duration: number, previousStyle: number, take = 0) {
  const style = (previousStyle + 1) % styles.length;
  const design = styles[style];
  const variation = ((take * 0.61803398875) % 1) - 0.5;
  const track = crypto.randomUUID();
  const lyrics = lines.map((text, i): Layer => {
    const start = starts[i];
    const stop = starts[i + 1] ?? end;
    const span = stop - start;
    const enter = Math.min(0.36, span * 0.22);
    const exit = Math.min(0.24, span * 0.17);
    const length = Math.max(1, Array.from(text).length);
    const fontSize = Math.min(design.size, 1460 / Math.min(length, 44), Math.sqrt(440_000 / length));
    return { ...newLayer('text', 1), textTrackId: track, name: '歌詞', text,
      y: design.y + (i % 3 - 1) * 32 + variation * 44, width: 1560, height: 420,
      color: design.text, fontSize, fontBold: style !== 1, start, end: stop, endExclusive: true,
      animations: [
        animation('fade-in', 0, enter, { opacity: 40 }),
        animation('slide-in', 0, enter, { direction: design.direction, distance: 72 + 18 * style }),
        animation('fade-out', span - exit, span, { opacity: 0 }),
      ] };
  });
  const backdrop: Layer = { ...newLayer('rectangle', 1), name: '背景', color: design.base,
    width: 1920, height: 1080, end: duration };
  const ambient: Layer = { ...newLayer(design.shape, 1), name: '背景の動き', color: design.tint,
    x: (style % 2 ? 420 : 1450) + variation * 200, y: style < 2 ? 840 : 170, width: 1510, height: 780,
    rotation: style % 2 ? -18 : 0, end: duration,
    animations: [animation('grow', 0, duration, { scale: 155 }),
      animation('color', 0, duration, { color: design.base })] };
  const accents = starts.filter((_, i) => i % 4 === 0).map((start, i): Layer => {
    const stop = Math.min(duration, starts[i * 4 + 4] ?? duration);
    const span = stop - start;
    const transition = Math.min(0.55, span * 0.25);
    return { ...newLayer(design.shape, 1), name: '場面転換', x: i % 2 ? 410 : 1510,
      y: design.y + 220, width: style % 2 ? 540 : 128, height: style % 2 ? 12 : 128,
      color: design.accent, start, end: stop, endExclusive: true,
      animations: [animation('fade-in', 0, transition, { opacity: 0 }),
        animation('slide-in', 0, transition, { direction: design.direction, distance: 100 }),
        animation('fade-out', span - transition, span, { opacity: 0 })] };
  });
  return { style, layers: [...lyrics, ...accents, ambient, backdrop] };
}
