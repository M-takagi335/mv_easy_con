import type { Layer } from './model.ts';
import type { Project, MusicAsset } from './project.ts';
import { lyricLines } from './autoMv.ts';

export const resolutions = [720, 1080, 1440, 2160] as const;
export type Settings = { name: string; resolution: typeof resolutions[number]; fps: 30 | 60;
  quality: 'standard' | 'high'; background: string };
export const defaultSettings: Settings = { name: '無題のMV', resolution: 1080, fps: 30, quality: 'standard', background: '#080910' };

const magic = 'MVEASY1\n';
const maxMetadata = 32 * 1024 * 1024;
export const maxPackagedAsset = 512 * 1024 * 1024;
const color = /^#[\da-f]{6}$/i;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const text = (x: unknown): x is string => typeof x === 'string';
const span = (x: Record<string, unknown>) => finite(x.start) && finite(x.end) && x.end > x.start;
const positive = (x: unknown) => finite(x) && x > 0;

function invalid(): never { throw new Error('プロジェクトファイルの内容が破損しているか、対応していません。'); }

function validLayer(x: unknown): boolean {
  if (!object(x) || !text(x.id) || !x.id || !text(x.name) || !text(x.text) ||
      !span(x) || Number(x.start) < 0 || !text(x.color) || !color.test(x.color) ||
      !['x', 'y', 'rotation'].every(key => finite(x[key])) ||
      !['width', 'height', 'fontSize'].every(key => positive(x[key])) ||
      (x.fontFamily !== undefined && !text(x.fontFamily)) ||
      !['fontBold', 'fontItalic', 'endExclusive'].every(key => x[key] === undefined || typeof x[key] === 'boolean') ||
      !Array.isArray(x.animations)) return false;
  return x.animations.every(a => object(a) && text(a.id) && text(a.template) &&
    span(a) && object(a.params) && Object.values(a.params).every(p => text(p) || finite(p)) &&
    (a.phase === undefined || (Array.isArray(a.phase) && a.phase.length === 2 && a.phase.every(finite))));
}

function validSettings(x: unknown): x is Settings {
  return object(x) && text(x.name) && resolutions.some(value => value === x.resolution) &&
    (x.fps === 30 || x.fps === 60) && (x.quality === 'standard' || x.quality === 'high') && text(x.background) && color.test(x.background);
}

export function validateProject(input: unknown): Project {
  if (!object(input) || !Array.isArray(input.layers) ||
      (input.version !== undefined && input.version !== 1) ||
      (input.settings !== undefined && !validSettings(input.settings)) ||
      (input.animationTime !== undefined && input.animationTime !== 'relative')) invalid();
  for (const layer of input.layers) {
    if (!object(layer) || !text(layer.id) || !layer.id) invalid();
    if (layer.kind === 'text-track') {
      if ((layer.name !== undefined && !text(layer.name)) || !Array.isArray(layer.clips) || !layer.clips.every(validLayer)) invalid();
    } else if (!['text', 'rectangle', 'ellipse'].includes(String(layer.kind)) || !validLayer(layer) ||
      (layer.textTrackId !== undefined && !text(layer.textTrackId))) invalid();
  }
  const project = input as Project;
  if (input.autoMv !== undefined) {
    const mv = input.autoMv;
    if (!object(mv) || !text(mv.lyrics) || !Array.isArray(mv.starts) ||
        mv.starts.length > lyricLines(mv.lyrics).length ||
        !mv.starts.every((time, i, times) => finite(time) && time >= 0 && (i === 0 || time > times[i - 1])) ||
        (mv.end !== null && (!positive(mv.end) || Number(mv.end) <= (mv.starts.at(-1) ?? -1))) ||
        !Array.isArray(mv.versions)) invalid();
    const ids = new Set<string>();
    for (const version of mv.versions) {
      if (!object(version) || !text(version.id) || !version.id || ids.has(version.id) ||
          !text(version.name) || !text(version.background) || !color.test(version.background) ||
          !finite(version.style) || !Number.isInteger(version.style) || version.style < -1 || version.style > 3 ||
          !Array.isArray(version.layers) || !version.layers.every(layer => object(layer) &&
            ['text', 'rectangle', 'ellipse'].includes(String(layer.kind)) && validLayer(layer) &&
            (layer.textTrackId === undefined || text(layer.textTrackId)))) invalid();
      ids.add(version.id);
    }
    if (mv.active !== null && (!text(mv.active) || !ids.has(mv.active))) invalid();
  }
  if (project.musicClips !== undefined && !Array.isArray(project.musicClips)) invalid();
  const music = project.musicClips ?? (project.music == null ? [] : [project.music]);
  for (const clip of music) {
    if (!object(clip) || !span(clip) || clip.start < 0 ||
        (clip.id !== undefined && !text(clip.id)) || !finite(clip.inPoint) || clip.inPoint < 0 ||
        !finite(clip.volume) || clip.volume < 0 || clip.volume > 1 || typeof clip.muted !== 'boolean' ||
        !object(clip.asset) || !text(clip.asset.id) || !clip.asset.id || !text(clip.asset.name) || !positive(clip.asset.duration) ||
        clip.asset.id !== music[0].asset.id) invalid();
  }
  return { ...project, music: music[0] ?? null, musicClips: music };
}

export function uniqueProjectIds(layers: Layer[], music: NonNullable<Project['musicClips']>) {
  const trackIds = new Set(layers.flatMap(layer => layer.textTrackId ? [layer.textTrackId] : []));
  const seen = new Set<string>();
  const unique = (id?: string, allowTrack = false) => {
    let result = id || crypto.randomUUID();
    while (seen.has(result) || (!allowTrack && trackIds.has(result))) result = crypto.randomUUID();
    seen.add(result);
    return result;
  };
  return {
    layers: layers.map(layer => ({ ...layer, id: unique(layer.id, layer.id === layer.textTrackId),
      animations: layer.animations.map(a => ({ ...a, id: unique(a.id) })) })),
    musicClips: music.map(clip => ({ ...clip, id: unique(clip.id) })),
  };
}

export async function readProjectFile(file: Blob) {
  const prefix = await file.slice(0, 12).arrayBuffer();
  const header = new TextDecoder().decode(prefix.slice(0, 8));
  if (header !== magic) {
    if (file.size > maxMetadata) invalid();
    return { project: validateProject(JSON.parse(await file.text())) };
  }
  if (prefix.byteLength !== 12) invalid();
  const size = new DataView(prefix).getUint32(8);
  if (!size || size > maxMetadata || 12 + size >= file.size || file.size - 12 - size > maxPackagedAsset) invalid();
  const manifest = JSON.parse(await file.slice(12, 12 + size).text());
  if (!object(manifest) || !text(manifest.mime) || !finite(manifest.assetSize) || manifest.assetSize !== file.size - 12 - size) invalid();
  const project = validateProject(manifest.project);
  if (!project.music || manifest.assetId !== project.music.asset.id) invalid();
  return { project, audio: file.slice(12 + size, undefined, manifest.mime) };
}

export function makeProjectFile(project: Project, asset?: MusicAsset) {
  if (!asset || !project.music) {
    const json = new TextEncoder().encode(JSON.stringify({ ...project, version: 1 }));
    if (json.length > maxMetadata) throw new Error('編集データが大きすぎます。');
    return new Blob([json], { type: 'application/json' });
  }
  if (!asset.file.size || asset.file.size > maxPackagedAsset) throw new Error('素材込み保存は音楽ファイル512 MBまでです。通常保存を利用してください。');
  const json = new TextEncoder().encode(JSON.stringify({
    project: { ...project, version: 1 }, assetId: project.music.asset.id, mime: asset.file.type, assetSize: asset.file.size,
  }));
  if (json.length > maxMetadata) throw new Error('編集データが大きすぎます。');
  const prefix = new Uint8Array(12);
  prefix.set(new TextEncoder().encode(magic));
  new DataView(prefix.buffer).setUint32(8, json.length);
  return new Blob([prefix, json, asset.file], { type: 'application/octet-stream' });
}

export function downloadFile(file: Blob, name: string, extension: string) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = (name.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'MV Easy') + extension;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
