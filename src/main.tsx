import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { defaults, evaluate } from './animation';
import { AutoWorkspace } from './AutoWorkspace';
import { editStart, emptyAutoMv, generateMv, lyricLines, recordStart } from './autoMv';
import type { Version } from './autoMv';
import { previewGeometry } from './geometry';
import type { Corner, Geometry } from './geometry';
import type { Pose } from './animation';
import { Icon } from './Icon';
import { adjacentEndpoint, animationTimelineSpan, CANVAS, DURATION, clamp, editAnimationSpan, editLayerSpan, groupLayers, initialAnimationSpan, migrateAbsoluteAnimations, newLayer, packLayers, reorderById, splitLayer, trackId, unpackLayers } from './model';
import type { Edge, Layer, Reorder } from './model';
import { formatTime, Timeline } from './Timeline';
import type { Selection } from './Timeline';
import { registry } from './templates';
import { TemplateLibrary } from './TemplateLibrary';
import { randomAnimations } from './randomAnimation';
import type { RandomGenre } from './randomAnimation';
import { applyAutomaticAnimations } from './autoAnimation';
import type { AnimationDensity } from './autoAnimation';
import { Scene } from './Scene';
import { createPlayhead, usePlayhead } from './playhead';
import type { Playhead } from './playhead';
import { FontPicker } from './FontPicker';
import { createBrowserFontProvider, resolveTextFont } from './fonts';
import type { FontOption } from './fonts';
import { editMusic, readMusic, sourceTime, splitMusic } from './music';
import type { MusicClip } from './music';
import { readProject, saveProject } from './project';
import type { MusicAsset } from './project';
import { defaultSettings, downloadFile, makeProjectFile, readProjectFile, uniqueProjectIds, validateProject } from './projectFile';
import type { Settings } from './projectFile';
import type { Project } from './project';
import { ExportDialog, loadExportModule } from './ExportDialog';
import { createHistory, equalProjectItems } from './history';
import { independentSelection, moveSelection, selectionKey } from './selection';
import './style.css';

const kinds = [['text', 'テキスト'], ['rectangle', '四角形'], ['ellipse', '円・楕円']] as const;
const heightKey = 'mv-easy.timeline-height';
const minimumTimelineHeight = 160;
const minimumWorkspaceHeight = 270;
const corners = [
  ['左上', [-1, -1]], ['右上', [1, -1]], ['左下', [-1, 1]], ['右下', [1, 1]],
] as const;

function savedTimelineHeight() {
  try {
    const value = Number(localStorage.getItem(heightKey));
    return Number.isFinite(value) && value >= minimumTimelineHeight ? value : null;
  } catch {
    return null;
  }
}
const objectFields = [
  ['x', '位置 X', -3840, 5760], ['y', '位置 Y', -2160, 3240],
  ['width', '幅', 1, 3840], ['height', '高さ', 1, 2160], ['rotation', '回転 (°)', -3600, 3600],
] as const;

function NumberField({ label, value, min, max, step = 1, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  function commit(event: FormEvent<HTMLInputElement>) {
    const input = event.currentTarget.value;
    if (input.trim() && Number.isFinite(Number(input))) onChange(clamp(Number(input), min, max));
    setDraft(null);
  }
  return <label>{label}<input type="number" min={min} max={max} step={step} value={draft ?? value}
    onChange={event => {
      setDraft(event.target.value);
      const next = event.target.valueAsNumber;
      if (Number.isFinite(next) && next >= min && next <= max) onChange(next);
    }} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>;
}

function PreviewScene({ playhead, ...props }: Omit<React.ComponentProps<typeof Scene>, 'time'> & { playhead: Playhead }) {
  return <Scene {...props} time={usePlayhead(playhead)} />;
}

function Timecode({ playhead }: { playhead: Playhead }) {
  return <strong>{formatTime(usePlayhead(playhead))}</strong>;
}

function App() {
  const [fontProvider] = useState(createBrowserFontProvider);
  const [fonts, setFonts] = useState<FontOption[]>([]);
  type EditData = { layers: Layer[]; musicClips: MusicClip[]; asset?: MusicAsset };
  const [history] = useState(() => createHistory<EditData>({ layers: [], musicClips: [] },
    (a, b) => a.asset === b.asset && equalProjectItems(a.layers, b.layers) && equalProjectItems(a.musicClips, b.musicClips)));
  const [{ layers, musicClips, asset }, setEditData] = useState(history.current);
  const [settings, setSettings] = useState(defaultSettings);
  const [detailed, setDetailed] = useState(false);
  const [autoMv, setAutoMv] = useState(emptyAutoMv);
  const [syncError, setSyncError] = useState('');
  const saved = useRef({ data: history.current, settings: defaultSettings, autoMv: emptyAutoMv });
  const dirty = saved.current.data !== history.current || saved.current.settings !== settings || saved.current.autoMv !== autoMv;
  const [projectMenu, setProjectMenu] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [loadingProject, setLoadingProject] = useState(false);
  const projectPicker = useRef<HTMLInputElement>(null);
  function setLayers(update: (items: Layer[]) => Layer[]) {
    setEditData(history.update(data => ({ ...data, layers: update(data.layers) })));
  }
  function setMusicClips(update: MusicClip[] | ((items: MusicClip[]) => MusicClip[])) {
    setEditData(history.update(data => ({ ...data, musicClips: typeof update === 'function' ? update(data.musicClips) : update })));
  }
  function finishEdit(cancel = false) { setEditData(history.finish(cancel)); }
  const [selection, setPrimarySelection] = useState<Selection | null>(null);
  const [expanded, setExpanded] = useState(() => new Set<string>());
  const [playhead] = useState(() => createPlayhead(0));
  const [selectedMusicId, setSelectedMusicId] = useState<string>();
  const music = musicClips.find(clip => clip.id === selectedMusicId);
  const musicSelected = music !== undefined;
  const [multiple, setMultiple] = useState<Selection[]>([]);
  const clipboard = useRef<{ data: EditData; targets: Selection[] } | null>(null);
  const groupDrag = useRef<{ data: EditData; targets: Selection[] } | null>(null);
  const timelineEditing = useRef(false);
  const saveQueue = useRef(Promise.resolve());
  const sceneGroups = useMemo(() => groupLayers(layers), [layers]);
  const [ready, setReady] = useState(false);
  const [loadingMusic, setLoadingMusic] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [animationError, setAnimationError] = useState('');
  const media = useRef<HTMLAudioElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const relinking = useRef(false);
  const duration = Math.max(DURATION, ...musicClips.map(clip => clip.end), ...layers.map(item => item.end));
  const musicEnd = Math.max(0, ...musicClips.map(clip => clip.end));
  const contentEnd = Math.max(musicEnd, ...layers.map(item => item.end));
  const playbackEnd = detailed && !autoMv.active ? duration : contentEnd;
  const activeAudio = useRef<MusicClip | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [timelineHeight, setTimelineHeight] = useState(savedTimelineHeight);
  const editor = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const previewDrag = useRef<{
    id: string; pointer: number; x: number; y: number; base: Geometry; next: Geometry;
    pose: Pose; corner?: Corner;
  } | null>(null);
  const resize = useRef<{ y: number; height: number; value: number } | null>(null);
  const addMenu = useRef<HTMLDivElement>(null);
  const clock = useRef(playhead.read());
  const frame = useRef<number | null>(null);
  const playbackSession = useRef(0);
  const nextLayer = useRef(5);
  const layer = musicSelected ? undefined : layers.find(item => item.id === selection?.layerId);
  const animation = layer?.animations.find(item => item.id === selection?.animationId);
  const animationRange = layer && animation ? animationTimelineSpan(layer, animation) : undefined;
  const primary = selectedMusicId ? { layerId: selectedMusicId } : selection;
  const selectedItems = multiple.length ? multiple : primary ? [primary] : [];

  function setSelection(target: Selection | null) {
    setMultiple([]);
    setPrimarySelection(target);
  }

  function selectItem(target: Selection, additive = false) {
    const items = additive && selectedItems.some(item => selectionKey(item) === selectionKey(target))
      ? selectedItems.filter(item => selectionKey(item) !== selectionKey(target))
      : [...(additive ? selectedItems : []), target];
    setMultiple(additive ? items : []);
    const last = items.at(-1);
    const audio = musicClips.some(item => item.id === last?.layerId);
    setPrimarySelection(audio ? null : last ?? null);
    setSelectedMusicId(audio ? last?.layerId : undefined);
  }

  function picked(items: Selection[]) {
    const keys = new Set(independentSelection(items).map(selectionKey));
    return {
      layers: layers.flatMap(item => {
        if (keys.has(item.id)) return [item];
        const animations = item.animations.filter(clip => keys.has(selectionKey({ layerId: item.id, animationId: clip.id })));
        return animations.length ? [{ ...item, animations }] : [];
      }),
      musicClips: musicClips.filter(item => keys.has(item.id!)), asset,
    };
  }

  function deleteItems() {
    const keys = new Set(independentSelection(selectedItems).map(selectionKey));
    setEditData(history.update(data => ({
      ...data,
      layers: data.layers.filter(item => !keys.has(item.id)).map(item => ({
        ...item, animations: item.animations.filter(clip => !keys.has(selectionKey({ layerId: item.id, animationId: clip.id }))),
      })),
      musicClips: data.musicClips.filter(item => !keys.has(item.id!)),
    })));
    setMultiple([]);
    setSelection(null);
    setSelectedMusicId(undefined);
  }

  function pasteItems(data: EditData, targets: Selection[], duplicate: boolean) {
    const whole = new Set(targets.filter(item => !item.animationId).map(item => item.layerId));
    const objects = data.layers.filter(item => whole.has(item.id));
    const effects = data.layers.filter(item => !whole.has(item.id));
    const clips = [...objects, ...data.musicClips];
    const origin = Math.min(...clips.map(item => item.start));
    let offset = duplicate ? Math.max(...clips.map(item => item.end)) - origin : clock.current - origin;
    // Preserve spacing by shifting the entire batch beyond any conflicting audio.
    const compatibleAudio = !musicClips.length || data.musicClips[0]?.asset.id === musicClips[0].asset.id;
    if (compatibleAudio && data.musicClips.length && musicClips.length) {
      offset = Math.max(offset, Math.max(...musicClips.map(item => item.end)) - Math.min(...data.musicClips.map(item => item.start)));
    }
    const ids = new Map<string, string>();
    const cloneEffect = (item: Layer['animations'][number]) => ({
      ...item, id: crypto.randomUUID(), params: { ...item.params },
      phase: item.phase && [...item.phase] as [number, number],
    });
    const copies = objects.map(item => {
      const id = crypto.randomUUID();
      const track = trackId(item);
      if (!ids.has(track)) ids.set(track, id);
      return { ...item, id, textTrackId: item.kind === 'text' ? ids.get(track) : undefined,
        start: item.start + offset, end: item.end + offset, animations: item.animations.map(cloneEffect) };
    });
    const audio = (compatibleAudio ? data.musicClips : [])
      .map(item => ({ ...item, id: crypto.randomUUID(), start: item.start + offset, end: item.end + offset }));
    const effectCopies = effects.flatMap(owner => owner.animations.map(item => ({ owner, item })));
    const first = Math.min(...effectCopies.map(({ owner, item }) => owner.start + item.start));
    const effectLength = Math.max(...effectCopies.map(({ owner, item }) => owner.start + item.end)) - first;
    const additions = effectCopies.flatMap(({ owner, item }) => {
      const destination = duplicate ? layers.find(candidate => candidate.id === owner.id) : layer;
      if (!destination) return [];
      const shift = duplicate ? effectLength : Math.max(clock.current, destination.start) - first + owner.start - destination.start;
      return [{ layerId: destination.id, clip: { ...cloneEffect(item), start: item.start + shift, end: item.end + shift } }];
    });
    if (!copies.length && !audio.length && !additions.length) return;
    setEditData(history.update(current => ({
      ...current, asset: audio.length && !current.musicClips.length ? data.asset : current.asset,
      musicClips: [...current.musicClips, ...audio],
      layers: [...current.layers.map(item => {
        const imported = additions.filter(entry => entry.layerId === item.id).map(entry => entry.clip);
        if (imported.length) openLayer(item.id);
        return imported.length ? { ...item, animations: [...item.animations, ...imported] } : item;
      }), ...copies],
    })));
    const next = [...copies, ...audio].map(item => ({ layerId: item.id! } as Selection))
      .concat(additions.map(entry => ({ layerId: entry.layerId, animationId: entry.clip.id })));
    const last = next.at(-1)!;
    const isAudio = audio.some(item => item.id === last.layerId);
    setPrimarySelection(isAudio ? null : last);
    setSelectedMusicId(isAudio ? last.layerId : undefined);
    setMultiple(next);
  }
  const template = animation && registry.get(animation.template);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  function restoreProject(project: Project, restoredAsset?: MusicAsset) {
    const unpacked = unpackLayers(project.layers);
    const relative = project.animationTime === 'relative' ? unpacked : unpacked.map(migrateAbsoluteAnimations);
    const restored = uniqueProjectIds(relative, project.musicClips ?? []);
    const nextSettings = project.settings ?? defaultSettings;
    pause();
    history.reset({ ...restored, asset: restoredAsset });
    const nextAuto = project.autoMv ?? emptyAutoMv;
    saved.current = { data: history.current, settings: nextSettings, autoMv: nextAuto };
    setAutoMv(nextAuto);
    setSyncError('');
    setEditData(history.current);
    setSettings(nextSettings);
    const first = restored.layers[0];
    setSelection(first ? { layerId: first.id } : null);
    setSelectedMusicId(restoredAsset ? undefined : restored.musicClips[0]?.id);
    setExpanded(new Set(first ? [first.id] : []));
    clipboard.current = null;
    nextLayer.current = project.layers.length + 1;
    clock.current = 0;
    playhead.update(0);
  }

  useEffect(() => {
    readProject().then(result => {
      if (result.project) restoreProject(validateProject(result.project), result.asset);
      setReady(true);
    }).catch(() => {
      setStorageError('保存済みプロジェクトを開けませんでした。');
      // Retry loading on reload. Do not overwrite the saved project with the sample.
    });
  }, []);

  function projectData(data: EditData): Project {
    return { version: 1, settings, layers: packLayers(data.layers), music: data.musicClips[0] ?? null,
      musicClips: data.musicClips, animationTime: 'relative', autoMv };
  }

  function persistProject(data: EditData) {
    const project = projectData(data);
    saveQueue.current = saveQueue.current.then(() =>
      saveProject(project, data.asset))
      .catch(() => setStorageError('プロジェクトを保存できませんでした。ブラウザーの空き容量を確認してください。'));
  }

  async function saveAndReload() {
    const data = history.current;
    const project = projectData(data);
    const write = saveQueue.current.then(() => saveProject(project, data.asset));
    saveQueue.current = write.catch(() => {});
    await write;
    saved.current = { data, settings, autoMv };
    window.location.reload();
  }

  function saveFile(packaged = false) {
    const data = history.current;
    try {
      if (packaged && data.musicClips.length && !data.asset) throw new Error('素材込み保存の前に音楽を再リンクしてください。');
      downloadFile(makeProjectFile(projectData(data), packaged ? data.asset : undefined), settings.name, '.mveasy');
      saved.current = { data, settings, autoMv };
      setProjectMenu(false);
      setStorageError('');
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : '保存できませんでした。');
    }
  }

  function newProject() {
    if (timelineEditing.current || loadingMusic) return;
    finishPreviewDrag();
    if (dirty && !window.confirm('未保存の変更があります。新規プロジェクトを作成しますか？')) return;
    restoreProject({ version: 1, settings: { ...defaultSettings }, layers: [], music: null, animationTime: 'relative' });
    setStorageError('');
    setProjectMenu(false);
    setReady(true);
  }

  async function openFile(file: File) {
    if (dirty && !window.confirm('未保存の変更があります。別のプロジェクトを開きますか？')) return;
    setLoadingProject(true);
    setStorageError('');
    try {
      const { project, audio } = await readProjectFile(file);
      let restoredAsset: MusicAsset | undefined;
      if (audio) {
        try {
          const { peaks } = await readMusic(audio);
          restoredAsset = { file: audio, peaks };
        } catch {
          setStorageError('同梱された音楽を再生できません。タイムラインから音楽を再リンクしてください。');
        }
      }
      restoreProject(project, restoredAsset);
      setReady(true);
    } catch (error) {
      setStorageError(error instanceof SyntaxError ? 'プロジェクトのJSONを読み込めませんでした。'
        : error instanceof Error ? error.message : 'プロジェクトを開けませんでした。');
    } finally {
      setLoadingProject(false);
    }
  }

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => persistProject(history.current), 350);
    return () => clearTimeout(timer);
  }, [ready, layers, musicClips, asset, settings, autoMv]);

  useEffect(() => {
    if (!ready) return;
    const preload = () => { void loadExportModule().catch(() => {}); };
    if (typeof window.requestIdleCallback === 'function') {
      const job = window.requestIdleCallback(preload, { timeout: 2000 });
      return () => window.cancelIdleCallback(job);
    }
    const job = window.setTimeout(preload, 1000);
    return () => window.clearTimeout(job);
  }, [ready]);

  useEffect(() => {
    const exit = (event: BeforeUnloadEvent) => {
      if (saved.current.data === history.current && saved.current.settings === settings) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', exit);
    return () => window.removeEventListener('beforeunload', exit);
  }, [history, settings]);

  useEffect(() => {
    const audio = media.current!;
    if (!asset) {
      audio.removeAttribute('src');
      audio.load();
      return;
    }
    const url = URL.createObjectURL(asset.file);
    audio.src = url;
    const clip = musicAt(clock.current);
    if (clip) audio.currentTime = sourceTime(clip, clock.current);
    return () => { audio.pause(); URL.revokeObjectURL(url); };
  }, [asset]);

  async function importMusic(file: File) {
    setLoadingMusic(true);
    setAudioError('');
    try {
      const decoded = await readMusic(file);
      const start = relinking.current && music ? music.start : 0;
      const inPoint = relinking.current && music ? Math.min(music.inPoint, Math.max(0, decoded.duration - 0.1)) : 0;
      const length = relinking.current && music ? Math.min(music.end - music.start, decoded.duration - inPoint) : decoded.duration;
      const id = crypto.randomUUID();
      const reference = { id, name: file.name, duration: decoded.duration };
      const imported = { id, asset: reference, start, end: start + length, inPoint,
        volume: music?.volume ?? 1, muted: music?.muted ?? false };
      const clips = relinking.current && music ? musicClips.map(clip => {
        if (clip === music) return imported;
        const offset = Math.min(clip.inPoint, Math.max(0, decoded.duration - 0.1));
        return { ...clip, asset: reference, inPoint: offset, end: clip.start + Math.min(clip.end - clip.start, decoded.duration - offset) };
      }) : [imported];
      setEditData(history.update(data => ({ ...data, musicClips: clips, asset: { file, peaks: decoded.peaks } })));
      setSelectedMusicId(id);
      if (!relinking.current) {
        setAutoMv(current => ({ ...current, starts: [], end: null }));
        setSyncError('');
        seek(0);
      }
      const limit = Math.max(DURATION, ...clips.map(clip => clip.end), ...layers.map(item => item.end));
      if (clock.current > limit) seek(limit);
    } catch {
      setAudioError('音声を読み込めませんでした。再生できる MP3・WAV・M4A ファイルを選んでください。');
    } finally {
      setLoadingMusic(false);
    }
  }

  function pause() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    activeAudio.current = undefined;
    media.current?.pause();
    setPlaying(false);
  }

  function musicAt(position: number) {
    return musicClips.find(clip => position >= clip.start && position < clip.end);
  }

  function togglePlayback() {
    if (frame.current !== null) {
      const active = activeAudio.current;
      if (active && asset && !media.current!.paused) {
        const position = clamp(active.start + media.current!.currentTime - active.inPoint, active.start, active.end);
        clock.current = position;
        playhead.update(position);
      }
      pause();
      return;
    }
    if (!ready || loadingMusic || timelineEditing.current) return;
    finishPreviewDrag();
    if (!playbackEnd || clock.current >= playbackEnd) {
      clock.current = 0;
      playhead.update(0);
    }
    let began = performance.now();
    let offset = clock.current;
    const audio = media.current!;
    const clips = asset ? [...musicClips].sort((a, b) => a.start - b.start) : [];
    let cursor = clips.findIndex(clip => clip.end > offset);
    let active: MusicClip | undefined;
    function startAudio(clip: MusicClip, position: number) {
      active = clip;
      activeAudio.current = clip;
      audio.currentTime = sourceTime(clip, position);
      audio.volume = clip.volume;
      audio.muted = clip.muted;
      const session = playbackSession.current;
      void audio.play().catch(() => {
        if (session !== playbackSession.current || frame.current === null) return;
        pause();
        setAudioError('音声を再生できませんでした。再リンクしてから再生してください。');
      });
    }
    function update(now: number) {
      let position = Math.min(playbackEnd, offset + Math.max(0, now - began) / 1000);
      const clip = active;
      if (clip) {
        position = audio.ended ? clip.end : clamp(clip.start + audio.currentTime - clip.inPoint, clip.start, clip.end);
        if (position >= clip.end - 0.00001) {
          position = clip.end;
          active = undefined;
          activeAudio.current = undefined;
          cursor++;
          began = now;
          offset = position;
          const next = clips[cursor];
          if (next && next.start <= position) {
            if (!audio.ended && Math.abs(sourceTime(next, position) - audio.currentTime) < 0.045) {
              active = next;
              activeAudio.current = next;
              audio.volume = next.volume;
              audio.muted = next.muted;
            } else startAudio(next, position);
          } else audio.pause();
        }
      } else if (clips[cursor] && position >= clips[cursor].start) {
        position = clips[cursor].start;
        startAudio(clips[cursor], position);
      }
      clock.current = position;
      playhead.update(position);
      if (position < playbackEnd) frame.current = requestAnimationFrame(update);
      else pause();
    }
    setAddOpen(false);
    setPlaying(true);
    playbackSession.current++;
    if (clips[cursor] && offset >= clips[cursor].start) startAudio(clips[cursor], offset);
    frame.current = requestAnimationFrame(update);
  }

  useEffect(() => {
    const isEditing = (target: EventTarget | null) => target instanceof Element &&
      target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    function onSpace(event: KeyboardEvent) {
      if (exportOpen || loadingProject) return;
      if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey &&
          !event.isComposing && event.keyCode !== 229 && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (ready && !loadingMusic && !timelineEditing.current && !previewDrag.current && !event.repeat) saveFile(!detailed && !!asset);
        return;
      }
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (!detailed) {
        if (isEditing(event.target) && !(event.target instanceof HTMLInputElement && event.target.type === 'range')) return;
        if (event.code === 'Space' && playing && autoMv.starts.length < lyricLines(autoMv.lyrics).length &&
            !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault();
          if (!event.repeat) markLyric();
        }
        return;
      }
      if (isEditing(event.target)) return;
      if (timelineEditing.current) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        if (key === 'a') {
          event.preventDefault();
          const effectsFocused = event.target instanceof Element && event.target.closest('.animation-row, .animation-settings');
          const targets = effectsFocused && layer
            ? layer.animations.map(item => ({ layerId: layer.id, animationId: item.id }))
            : [...layers, ...musicClips].map(item => ({ layerId: item.id! }));
          setMultiple(targets);
          return;
        }
        if (['c', 'x', 'v', 'd'].includes(key)) {
          event.preventDefault();
          if (frame.current !== null || previewDrag.current || groupDrag.current || event.repeat) return;
          if (key === 'v') {
            if (clipboard.current) pasteItems(clipboard.current.data, clipboard.current.targets, false);
          } else if (selectedItems.length) {
            const data = picked(selectedItems);
            if (key === 'd') pasteItems(data, selectedItems, true);
            else {
              clipboard.current = { data, targets: selectedItems };
              if (key === 'x') deleteItems();
            }
          }
          return;
        }
      }
      if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        if (key === 'escape' && !groupDrag.current && !previewDrag.current) {
          setSelection(null);
          setSelectedMusicId(undefined);
        }
        if (key === 'delete' || key === 'backspace') {
          event.preventDefault();
          if (selectedItems.length && frame.current === null && !groupDrag.current && !previewDrag.current) deleteItems();
          return;
        }
        if (key === 'arrowleft' || key === 'arrowright') {
          event.preventDefault();
          seek(clamp(clock.current + (key === 'arrowleft' ? -1 : 1) / settings.fps, 0, duration));
          return;
        }
      }
      if (!event.defaultPrevented && !event.isComposing && event.ctrlKey &&
          !event.altKey && !event.metaKey && (key === 'z' || (key === 'y' && !event.shiftKey))) {
        if (frame.current !== null || previewDrag.current || groupDrag.current) return;
        event.preventDefault();
        const restored = history.step(key === 'y' || event.shiftKey);
        setMultiple([]);
        setEditData(restored);
        if (selection) {
          const restoredLayer = restored.layers.find(item => item.id === selection.layerId);
          const splitSibling = layer && restoredLayer?.end !== layer.end
            ? restored.layers.find(item => trackId(item) === trackId(layer) &&
              item.start <= clock.current && clock.current < item.end)
            : undefined;
          const selected = restoredLayer ?? splitSibling;
          const animationId = selected?.animations.find(item => item.id === selection.animationId)?.id;
          setSelection(selected ? { layerId: selected.id, animationId } : null);
          if (selected && expanded.has(selection.layerId)) openLayer(selected.id);
        }
        if (!restored.musicClips.some(item => item.id === selectedMusicId)) setSelectedMusicId(undefined);
        const limit = Math.max(DURATION, ...restored.layers.map(item => item.end), ...restored.musicClips.map(item => item.end));
        if (clock.current > limit) {
          clock.current = limit;
          playhead.update(limit);
        }
        return;
      }
      if (!event.defaultPrevented && !event.isComposing && !event.repeat && event.code === 'KeyX' &&
          !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
          frame.current === null && !previewDrag.current && !groupDrag.current && !loadingMusic && ready) {
        event.preventDefault();
        cut();
        return;
      }
      if (event.defaultPrevented || event.code !== 'Space' || event.isComposing ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      if (!event.repeat) togglePlayback();
    }
    window.addEventListener('keydown', onSpace);
    return () => window.removeEventListener('keydown', onSpace);
  });

  useEffect(() => {
    function onJump(event: KeyboardEvent) {
      if (!detailed || exportOpen || loadingProject) return;
      if (event.defaultPrevented || !event.altKey || event.shiftKey || event.ctrlKey || event.metaKey ||
          event.isComposing || event.keyCode === 229 || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      if (timelineEditing.current) return;
      if (event.target instanceof Element &&
          event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      event.preventDefault();
      const endpoint = adjacentEndpoint(layers, clock.current, event.key === 'ArrowRight' ? 1 : -1, musicClips);
      if (endpoint !== undefined) seek(endpoint);
    }
    window.addEventListener('keydown', onJump);
    return () => window.removeEventListener('keydown', onJump);
  }, [layers, musicClips, asset, exportOpen, loadingProject, detailed]);

  useEffect(() => {
    if (!addOpen) return;
    function close(event: globalThis.PointerEvent) {
      if (!addMenu.current?.contains(event.target as Node)) setAddOpen(false);
    }
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [addOpen]);

  function seek(position: number) {
    finishPreviewDrag();
    pause();
    const clip = musicAt(position) ?? musicClips.find(item => item.start > position);
    if (clip && asset) media.current!.currentTime = sourceTime(clip, Math.max(position, clip.start));
    clock.current = position;
    playhead.update(position);
  }

  function openLayer(id: string) {
    setExpanded(current => new Set([...current, id]));
  }

  function addLayer(kind: Layer['kind']) {
    if (frame.current !== null) return;
    const item = newLayer(kind, nextLayer.current++);
    setLayers(current => [item, ...current]);
    setSelection({ layerId: item.id });
    setSelectedMusicId(undefined);
    setAddOpen(false);
  }

  function addLyric(target: Layer, source?: Layer) {
    if (frame.current !== null) return;
    const id = trackId(target);
    const siblings = layers.filter(item => trackId(item) === id).sort((a, b) => a.start - b.start);
    let start = clock.current;
    const length = source ? source.end - source.start : 2;
    for (const sibling of siblings) {
      if (start + length <= sibling.start) break;
      if (start < sibling.end) start = sibling.end;
    }
    const item: Layer = {
      ...(source ?? target), id: crypto.randomUUID(), textTrackId: id, start, end: start + length,
      endExclusive: true, name: target.name, text: source?.text ?? 'テキストを入力',
      animations: source?.animations.map(animation => ({
        ...animation, id: crypto.randomUUID(), params: { ...animation.params },
      })) ?? [],
    };
    setLayers(items => [...items, item]);
    setSelection({ layerId: item.id });
    seek(start);
    setSelectedMusicId(undefined);
    setAddOpen(false);
  }

  function updateLayer(id: string, update: (item: Layer) => Layer) {
    if (frame.current !== null) return;
    setLayers(items => items.map(item => item.id === id ? update(item) : item));
  }

  function startPreviewDrag(event: PointerEvent<HTMLButtonElement>, item: Layer, pose: Pose, corner?: Corner) {
    if (event.button !== 0 || frame.current !== null || previewDrag.current) return;
    event.currentTarget.focus({ preventScroll: true });
    history.begin();
    const { x, y, width, height } = item;
    const base = { x, y, width, height };
    previewDrag.current = { id: item.id, pointer: event.pointerId, x: event.clientX, y: event.clientY,
      base, next: base, pose, corner };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelection({ layerId: item.id });
    setSelectedMusicId(undefined);
  }

  function movePreviewDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = previewDrag.current;
    if (!drag || drag.pointer !== event.pointerId || frame.current !== null) return;
    const bounds = canvas.current!.getBoundingClientRect();
    drag.next = previewGeometry(drag.base, drag.pose,
      (event.clientX - drag.x) * CANVAS.width / bounds.width,
      (event.clientY - drag.y) * CANVAS.height / bounds.height, drag.corner);
    const next = drag.next;
    updateLayer(drag.id, item => ({ ...item, ...next }));
  }

  function finishPreviewDrag(pointer?: number, cancel = false) {
    const drag = previewDrag.current;
    if (!drag || (pointer !== undefined && pointer !== drag.pointer)) return;
    previewDrag.current = null;
    finishEdit(cancel);
  }

  const addAnimation = useCallback((id: string) => {
    if (!layer || !ready || frame.current !== null || timelineEditing.current || previewDrag.current) return false;
    const template = registry.get(id);
    if (!template || (template.textOnly && layer.kind !== 'text')) return false;
    const span = initialAnimationSpan(layer, clock.current);
    if (!span) {
      setAnimationError('再生位置からクリップの終了までに、アニメーションを追加できる1フレーム分の余裕がありません。');
      return false;
    }
    setAnimationError('');
    const clip = { id: crypto.randomUUID(), template: id, ...span,
      params: defaults(template) };
    updateLayer(layer.id, item => ({ ...item, animations: [...item.animations, clip] }));
    openLayer(layer.id);
    setSelection({ layerId: layer.id, animationId: clip.id });
    return true;
  }, [layer, history, ready]);

  const addRandom = useCallback((count: number, genre: RandomGenre) => {
    if (!layer || !ready || frame.current !== null || timelineEditing.current || previewDrag.current) return;
    const target = history.current.layers.find(item => item.id === layer.id);
    if (!target) return;
    const additions = randomAnimations(target, clock.current, count, genre);
    if (!additions.length) return 0;
    setEditData(history.update(data => ({ ...data, layers: data.layers.map(item =>
      item.id === target.id ? { ...item, animations: [...item.animations, ...additions] } : item) })));
    openLayer(target.id);
    setSelection({ layerId: target.id, animationId: additions[0].id });
    return additions.length;
  }, [layer, ready, history]);

  const autoAnimate = useCallback((density: AnimationDensity) => {
    if (!layer || !ready || frame.current !== null || timelineEditing.current || previewDrag.current) return;
    const result = applyAutomaticAnimations(history.current.layers, layer.id, density);
    if (result.added) {
      setEditData(history.update(data => ({ ...data, layers: result.layers })));
      setExpanded(current => new Set([...current, ...result.layers.filter(item =>
        item.kind === 'text' && trackId(item) === trackId(layer) && item.animations.length).map(item => item.id)]));
    }
    return result;
  }, [layer, ready, history]);

  function cut() {
    if (music) {
      const halves = splitMusic(music, clock.current);
      if (!halves) return;
      setMusicClips(items => items.flatMap(item => item.id === music.id ? halves : [item]));
      setSelectedMusicId(halves[1].id);
    } else if (layer) {
      const halves = splitLayer(layer, clock.current);
      if (!halves) return;
      setLayers(items => items.flatMap(item => item.id === layer.id ? halves : [item]));
      setSelection({ layerId: halves[1].id });
      setExpanded(current => {
        if (!current.has(layer.id)) return current;
        const next = new Set(current);
        next.delete(layer.id);
        halves.forEach(half => next.add(half.id));
        return next;
      });
    }
  }

  function edit(target: Selection, edge: Edge, delta: number, original?: Layer) {
    if (edge === 'move' && applyGroupMove(delta)) return;
    updateLayer(target.layerId, item => {
      const source = original ?? item;
      if (!target.animationId) {
        const siblings = layers.filter(entry => entry.id !== source.id && trackId(entry) === trackId(source));
        const earliest = Math.max(0, ...siblings.filter(entry => entry.end <= source.start).map(entry => entry.end));
        const latest = Math.min(duration, ...siblings.filter(entry => entry.start >= source.end).map(entry => entry.start));
        return editLayerSpan(source, edge, delta, latest, earliest);
      }
      return { ...item, animations: item.animations.map(clip => {
        if (clip.id !== target.animationId) return clip;
        const initial = source.animations.find(entry => entry.id === clip.id) ?? clip;
        return { ...clip, ...editAnimationSpan(initial, edge, delta, item, duration) };
      }) };
    });
  }

  function beginTimelineEdit(target: Selection, edge: Edge) {
    timelineEditing.current = true;
    history.begin();
    const included = selectedItems.some(item => selectionKey(item) === selectionKey(target));
    if (edge === 'move' && included && selectedItems.length > 1) {
      groupDrag.current = { data: history.current, targets: selectedItems };
    } else selectItem(target);
  }

  function applyGroupMove(delta: number) {
    const drag = groupDrag.current;
    if (!drag) return false;
    if (frame.current === null) {
      setEditData(history.update(data => ({
        ...data, ...moveSelection(drag.data.layers, drag.data.musicClips, drag.targets, delta, duration),
      })));
    }
    return true;
  }

  function removeSelection() {
    if (!layer || frame.current !== null) return;
    if (animation) {
      updateLayer(layer.id, item => ({ ...item, animations: item.animations.filter(clip => clip.id !== animation.id) }));
      setSelection({ layerId: layer.id });
      return;
    }
    setLayers(items => items.filter(item => item.id !== layer.id));
    setExpanded(current => {
      const next = new Set(current);
      next.delete(layer.id);
      return next;
    });
    setSelection(null);
  }

  function reorder(source: Selection, target: Reorder) {
    if (frame.current !== null) return;
    const id = source.animationId;
    if (id !== undefined) {
      updateLayer(source.layerId, item => ({ ...item, animations: reorderById(item.animations, id, target) }));
    } else {
      setLayers(items => {
        const groups = groupLayers(items).map(group => ({ id: trackId(group[0]), group }));
        return reorderById(groups, source.layerId, target).flatMap(group => group.group);
      });
    }
  }

  function markLyric() {
    const clip = activeAudio.current;
    const audio = media.current;
    if (!audio || !clip || audio.paused || audio.ended || audio.seeking) return;
    const time = clip.start + audio.currentTime - clip.inPoint;
    if (autoMv.starts.length >= lyricLines(autoMv.lyrics).length) return;
    const starts = recordStart(autoMv.starts, time, Math.min(clip.end, autoMv.end ?? musicEnd));
    if (starts === autoMv.starts) {
      setSyncError('前の記録より後の時刻で記録してください。');
      return;
    }
    setAutoMv({ ...autoMv, starts });
    setSyncError('');
  }

  function changeLyrics(lyrics: string) {
    const previous = lyricLines(autoMv.lyrics);
    const next = lyricLines(lyrics);
    const changed = previous.findIndex((line, index) => line !== next[index]);
    const starts = autoMv.starts.slice(0, changed < 0 ? next.length : changed);
    setAutoMv({ ...autoMv, lyrics, starts, end: starts.length === autoMv.starts.length ? autoMv.end : null });
    setSyncError('');
  }

  function switchVersion(id?: string) {
    const current = autoMv.versions.find(version => version.id === autoMv.active);
    let versions = autoMv.versions.map(version => version.id === current?.id
      ? { ...version, layers, background: settings.background } : version);
    if (!current && layers.length) {
      versions = [{ id: crypto.randomUUID(), name: '元の編集データ', layers, style: -1, background: settings.background }, ...versions];
    }
    let chosen: Version | undefined;
    if (id) chosen = versions.find(version => version.id === id);
    else {
      const lines = lyricLines(autoMv.lyrics);
      const end = autoMv.end ?? musicEnd;
      if (!asset || !lines.length || lines.length !== autoMv.starts.length ||
          end > musicEnd || end <= autoMv.starts[lines.length - 1]) return;
      const number = versions.filter(version => version.style >= 0).length + 1;
      const generated = generateMv(lines, autoMv.starts, end, musicEnd, current?.style ?? -1, number);
      chosen = { ...generated, id: crypto.randomUUID(), name: `生成結果 ${number}`, background: defaultSettings.background };
      versions = [...versions, chosen];
    }
    if (!chosen) return;
    const restored = uniqueProjectIds(chosen.layers, []).layers;
    seek(0);
    history.reset({ ...history.current, layers: restored });
    setEditData(history.current);
    setSettings({ ...settings, background: chosen.background });
    setAutoMv({ ...autoMv, versions, active: chosen.id });
    setSelection(restored[0] ? { layerId: restored[0].id } : null);
    setSelectedMusicId(undefined);
    setExpanded(new Set(restored[0] ? [trackId(restored[0])] : []));
    setSyncError('');
  }

  function changeMode(next: boolean) {
    finishPreviewDrag();
    pause();
    setDetailed(next);
    setAddOpen(false);
    setProjectMenu(false);
  }

  return <main className={detailed ? 'editor' : undefined} ref={editor} style={{
    '--timeline-height': timelineHeight === null ? undefined : `${timelineHeight}px`,
  } as CSSProperties}>
    {exportOpen && <ExportDialog settings={settings} onSettings={setSettings} onClose={() => setExportOpen(false)} onReload={saveAndReload}
      snapshot={{ layers, clips: musicClips, asset, duration: autoMv.active ? contentEnd || duration : duration, fontProvider }} />}
    <input ref={projectPicker} type="file" hidden accept=".mveasy,.json"
      onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) {
          setProjectMenu(false);
          void openFile(file);
        }
      }} />
    <audio ref={media} preload="auto" hidden />
    <input ref={picker} type="file" hidden accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4"
      onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file && frame.current === null) void importMusic(file);
      }} />
    {!detailed ? <AutoWorkspace mv={autoMv} ready={ready} busy={loadingProject || loadingMusic}
      musicName={musicClips[0]?.asset.name} hasAudio={!!asset && musicEnd > 0} musicEnd={musicEnd}
      playbackEnd={contentEnd} playing={playing} playhead={playhead}
      error={syncError || audioError || storageError}
      preview={layers.length > 0 ? <div className="canvas auto-canvas" style={{ background: settings.background }}>
        <PreviewScene playhead={playhead} groups={sceneGroups} fontProvider={fontProvider} />
      </div> : undefined}
      importMusic={() => {
        const missing = !asset && musicClips[0];
        relinking.current = !!missing;
        if (missing) setSelectedMusicId(missing.id);
        picker.current?.click();
      }}
      open={() => { pause(); projectPicker.current?.click(); }}
      save={() => saveFile(!!asset)} edit={() => changeMode(true)}
      play={togglePlayback} seek={seek} mark={markLyric}
      undo={() => {
        const undone = autoMv.starts.at(-1);
        if (undone !== undefined) seek(undone);
        setAutoMv({ ...autoMv, starts: autoMv.starts.slice(0, -1) });
        setSyncError('');
      }}
      setLyrics={changeLyrics}
      setStart={(index, time) => {
        const starts = editStart(autoMv.starts, index, time, Math.min(musicEnd, autoMv.end ?? musicEnd));
        if (starts === autoMv.starts) setSyncError('前後の歌詞の間に開始時刻を設定してください。');
        else { setAutoMv({ ...autoMv, starts }); setSyncError(''); }
      }}
      setEnd={time => {
        if (time > (autoMv.starts.at(-1) ?? 0) && time <= musicEnd) {
          setAutoMv({ ...autoMv, end: time }); setSyncError('');
        } else setSyncError('最後の歌詞の開始後から曲の終わりまでの時刻を指定してください。');
      }}
      generate={() => switchVersion()} restore={switchVersion}
      exportVideo={() => { pause(); setExportOpen(true); }} /> : <>
    <header className="app-header" inert={loadingProject}>
      <div className="brand"><span className="brand-icon"><Icon name="logo" size={22} /></span><h1>MV <em>Easy</em></h1></div>
      <span className="header-divider" />
      <input className="project-name" aria-label="プロジェクト名" value={settings.name} maxLength={120}
        onChange={event => setSettings({ ...settings, name: event.target.value })} />
      <div className="project-actions">
        <button type="button" onClick={() => changeMode(false)}>自動生成へ</button>
        <button type="button" onClick={() => saveFile()} disabled={!ready || loadingMusic}>保存</button>
        <button type="button" aria-label="保存の種類" aria-expanded={projectMenu} disabled={!ready || loadingMusic}
          onClick={() => setProjectMenu(!projectMenu)}>▾</button>
        {projectMenu && <div className="add-menu project-save-menu">
          <button type="button" onClick={() => saveFile()}>通常保存（編集データ）</button>
          <button type="button" onClick={() => saveFile(true)}>素材込み保存（音楽を同梱）</button>
          <button type="button" onClick={newProject}>新規プロジェクト</button>
        </div>}
        <button type="button" onClick={() => {
          if (timelineEditing.current) return;
          finishPreviewDrag();
          pause();
          projectPicker.current?.click();
        }}
          disabled={loadingMusic || !ready && !storageError}>開く</button>
        <button type="button" onClick={() => {
          if (timelineEditing.current) return;
          finishPreviewDrag();
          pause();
          setExportOpen(true);
        }} disabled={!ready || loadingMusic}>動画を書き出す</button>
        <label>背景 <input type="color" aria-label="背景色" value={settings.background}
          onChange={event => setSettings({ ...settings, background: event.target.value })} /></label>
      </div>
      <div className="add-area" ref={addMenu} onKeyDown={event => { if (event.key === 'Escape') setAddOpen(false); }}>
        <button type="button" className="primary add-button" aria-expanded={addOpen} disabled={playing || !ready || loadingMusic}
          onClick={() => setAddOpen(open => !open)}><Icon name="plus" />追加<Icon name="down" size={13} /></button>
        {addOpen && <div className="add-menu">{kinds.map(([kind, label]) =>
          <button type="button" key={kind} onClick={() => addLayer(kind)}><Icon name={kind} />{label}</button>)}
          {layer?.kind === 'text' && <button type="button" onClick={() => addLyric(layer)}>同じレイヤーに歌詞を追加</button>}
          <button type="button" onClick={() => { relinking.current = false; setAddOpen(false); picker.current?.click(); }}>♫ 音楽を読み込む</button>
        </div>}
      </div>
    </header>
    <div className="workspace" inert={loadingProject}>
      <TemplateLibrary kind={layer?.kind} playing={playing} onAdd={addAnimation} onAuto={autoAnimate} fontProvider={fontProvider}
        targetName={layer ? (layer.kind === 'text' ? layer.text || layer.name : layer.name) : undefined}
        onRandom={addRandom} />
      <section className="monitor" aria-label="プレビュー">
        <div className="monitor-head"><h2>プレビュー</h2><span>{settings.resolution * 16 / 9} × {settings.resolution}</span></div>
        <div className="stage">
          <div className="canvas" ref={canvas} style={{ background: settings.background }}>
            <PreviewScene playhead={playhead} groups={sceneGroups} fontProvider={fontProvider} renderObject={(item, pose, props) => {
              const selected = !playing && layer?.id === item.id;
              const pointerHandlers = {
                onPointerMove: movePreviewDrag,
                onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => finishPreviewDrag(event.pointerId, true),
                onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => finishPreviewDrag(event.pointerId),
              };
              return <>
                <button {...props} type="button" aria-label={item.name} disabled={playing}
                  className={props.className + (selected ? ' canvas-selected' : '')}
                  onClick={() => { setSelection({ layerId: item.id }); setSelectedMusicId(undefined); }}
                  onPointerDown={event => startPreviewDrag(event, item, pose)} {...pointerHandlers} />
                {selected && corners.map(([label, corner]) => <button type="button" key={label}
                  aria-label={`${item.name}の${label}をリサイズ`} className="preview-handle"
                  style={{ left: corner[0] < 0 ? 0 : '100%', top: corner[1] < 0 ? 0 : '100%',
                    cursor: corner[0] === corner[1] ? 'nwse-resize' : 'nesw-resize',
                    transform: `translate(-50%, -50%) scale(${1 / pose.scale})` }}
                  onPointerDown={event => startPreviewDrag(event, item, pose, corner)} {...pointerHandlers} />)}
              </>;
            }} />
          </div>
        </div>
        <div className="transport">
          <div className="timecode"><Icon name="clock" size={15} /><Timecode playhead={playhead} /><span>/ {formatTime(playbackEnd)}</span></div>
          <div className="transport-buttons">
            <button type="button" className="icon-button" aria-label="最初へ" onClick={() => seek(0)}><Icon name="first" /></button>
            <button type="button" className="primary play-button" aria-label={playing ? '一時停止' : '再生'}
              onClick={togglePlayback}>
              <Icon name={playing ? 'pause' : 'play'} size={19} /></button>
            <button type="button" className="icon-button" aria-label="最後へ" onClick={() => seek(playbackEnd)}><Icon name="last" /></button>
          </div>
          <span className="aspect">16:9</span>
        </div>
      </section>
      <aside className="inspector"
        onFocus={event => {
          if (event.target.matches('textarea, input[type="number"], input[type="color"], input[type="range"]')) history.begin();
        }}
        onBlur={event => {
          if (event.target.matches('textarea, input[type="number"], input[type="color"], input[type="range"]')) finishEdit();
        }}
        onPointerDown={event => {
          if (event.target instanceof HTMLInputElement && event.target.type === 'range') history.begin();
        }}
        onPointerUp={event => {
          if (event.target instanceof HTMLInputElement && event.target.type === 'range') finishEdit();
        }}
        onPointerCancel={event => {
          if (event.target instanceof HTMLInputElement && event.target.type === 'range') finishEdit(true);
        }}>
        <div className="panel-title"><Icon name="panel" size={17} /><h2>プロパティ</h2></div>
        {loadingMusic && <p role="status">音声と波形を読み込んでいます…</p>}
        {audioError && <p role="alert">{audioError}</p>}
        {storageError && <p role="alert">{storageError}</p>}
        {animationError && <p role="alert">{animationError}</p>}
        {musicSelected && music ? <>
          <div className="inspector-selection"><div><strong title={music.asset.name}>{music.asset.name}</strong><small>音楽</small></div>
            <button type="button" className="icon-button delete" aria-label="音楽を削除" disabled={playing || loadingMusic}
              onClick={() => {
                const remaining = musicClips.filter(item => item.id !== music.id);
                setMusicClips(remaining); setSelectedMusicId(undefined); setAudioError('');
                seek(Math.min(clock.current, Math.max(DURATION, ...layers.map(item => item.end), ...remaining.map(item => item.end))));
              }}><Icon name="trash" size={17} /></button>
          </div>
          <fieldset className="properties" disabled={playing || loadingMusic}>
            <div className="clip-range">{formatTime(music.start)} — {formatTime(music.end)}</div>
            {!asset && <p role="status">音声ファイルが見つかりません。</p>}
            <label>音量 {Math.round(music.volume * 100)}%
              <input type="range" min="0" max="1" step="0.01" value={music.volume}
                onChange={event => { const volume = event.target.valueAsNumber; setMusicClips(items => items.map(item => item.id === music.id ? { ...item, volume } : item)); }} />
            </label>
            <label className="music-mute"><input type="checkbox" checked={music.muted}
              onChange={event => { const muted = event.target.checked; setMusicClips(items => items.map(item => item.id === music.id ? { ...item, muted } : item)); }} />ミュート</label>
            <button type="button" className="primary music-relink" onClick={() => {
              relinking.current = true; picker.current?.click();
            }}>音声を再リンク</button>
          </fieldset>
        </> : layer ? <>
          <div className="inspector-selection"><span className="selection-icon"><Icon name={template?.icon ?? layer.kind} size={19} /></span>
            <div><strong>{template?.label ?? layer.name}</strong><small>{template ? layer.name : kinds.find(([kind]) => kind === layer.kind)?.[1]}</small></div>
            <button type="button" className="icon-button delete" aria-label={animation ? 'アニメーションを削除' : 'レイヤーを削除'}
              disabled={playing} onClick={removeSelection}><Icon name="trash" size={17} /></button></div>
          {animation ? <fieldset className="properties animation-settings" tabIndex={0} key={animation.id} disabled={playing}>
            <h3>アニメーション設定</h3>
            <div className="clip-range">{formatTime(animationRange!.start)} — {formatTime(animationRange!.end)}</div>
            {!template && <p role="status">このテンプレートは現在のバージョンでは再生できません。</p>}
            {template?.controls.map(control => {
              const value = animation.params[control.key] ?? control.initial;
              const change = (next: number | string) => updateLayer(layer.id, item => ({
                ...item, animations: item.animations.map(clip => clip.id === animation.id
                  ? { ...clip, params: { ...clip.params, [control.key]: next } } : clip),
              }));
              if ('min' in control) return <NumberField key={control.key} label={control.label}
                min={control.min} max={control.max} step={control.step} value={Number(value)} onChange={change} />;
              if ('options' in control) return <label key={control.key}>{control.label}
                <select value={value} onChange={event => change(event.target.value)}>
                  {control.options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select></label>;
              return <label key={control.key}>{control.label}<input type="color" value={String(value)}
                onChange={event => change(event.target.value)} /></label>;
            })}
          </fieldset> : <fieldset className="properties" key={layer.id} disabled={playing}>
            {layer.kind === 'text' && <>
              <label>テキスト<textarea rows={2} value={layer.text}
                onChange={event => { const text = event.target.value; updateLayer(layer.id, item => ({ ...item, text })); }} /></label>
              {!playing && <FontPicker family={layer.fontFamily} fonts={fonts} provider={fontProvider}
                unavailable={resolveTextFont(layer, fontProvider).unavailable}
                onLoad={async () => {
                  const installed = await fontProvider.list();
                  setFonts(installed);
                  return installed.length;
                }}
                onChange={fontFamily => updateLayer(layer.id, item => ({ ...item, fontFamily }))} />}
              <div className="font-toggles">
                <label><input type="checkbox" checked={resolveTextFont(layer, fontProvider).fontWeight >= 700}
                  onChange={event => { const fontBold = event.target.checked; updateLayer(layer.id, item => ({ ...item, fontBold })); }} />太字</label>
                <label><input type="checkbox" checked={layer.fontItalic ?? false}
                  onChange={event => { const fontItalic = event.target.checked; updateLayer(layer.id, item => ({ ...item, fontItalic })); }} />斜体</label>
              </div>
            </>}
            <h3>位置・サイズ</h3>
            <div className="field-grid">
              {objectFields.map(([key, label, min, max]) => <NumberField key={key} label={label} min={min} max={max}
                value={layer[key]} onChange={value => updateLayer(layer.id, item => ({ ...item, [key]: value }))} />)}
              {layer.kind === 'text' && <NumberField label="文字サイズ" min={1} max={720} value={layer.fontSize}
                onChange={fontSize => updateLayer(layer.id, item => ({ ...item, fontSize }))} />}
            </div>
            <label>カラー<span className="color-field"><input type="color" value={layer.color}
              onChange={event => { const color = event.target.value; updateLayer(layer.id, item => ({ ...item, color })); }} />
              <span>{layer.color.toUpperCase()}</span></span></label>
          </fieldset>}
        </> : <p>タイムラインかプレビューでレイヤーを選択してください。</p>}
      </aside>
    </div>
    <div className="timeline-divider" role="separator" aria-label="タイムラインの高さ"
      aria-orientation="horizontal" onPointerDown={event => {
        if (event.button !== 0 || resize.current) return;
        event.preventDefault();
        const height = event.currentTarget.nextElementSibling!.getBoundingClientRect().height;
        resize.current = { y: event.clientY, height, value: height };
        event.currentTarget.setPointerCapture(event.pointerId);
        editor.current?.classList.add('resizing-timeline');
      }} onPointerMove={event => {
        const drag = resize.current;
        if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const available = editor.current!.clientHeight - editor.current!.querySelector('.app-header')!.clientHeight - event.currentTarget.offsetHeight;
        drag.value = Math.round(clamp(drag.height + drag.y - event.clientY, minimumTimelineHeight,
          Math.max(minimumTimelineHeight, available - minimumWorkspaceHeight)));
        setTimelineHeight(drag.value);
      }} onLostPointerCapture={() => {
        const drag = resize.current;
        resize.current = null;
        editor.current?.classList.remove('resizing-timeline');
        if (drag && drag.value !== drag.height) {
          try { localStorage.setItem(heightKey, String(drag.value)); } catch { /* Storage may be unavailable. */ }
        }
      }} />
    <div inert={loadingProject} style={{ display: 'contents' }}><Timeline layers={layers} selection={musicSelected ? null : selection} expanded={expanded} playhead={playhead}
      duration={duration} musicClips={musicClips} peaks={asset?.peaks} selectedItems={selectedItems}
      onSelectMusic={id => { if (id) selectItem({ layerId: id }); }} onEditMusic={(edge, delta, original) => {
        if (frame.current !== null || loadingMusic) return;
        if (edge === 'move' && applyGroupMove(delta)) return;
        const next = editMusic(original, edge, delta);
        if (musicClips.some(item => item.id !== original.id &&
          next.start < item.end - 1e-8 && next.end > item.start + 1e-8)) return;
        const clips = musicClips.map(item => item.id === original.id ? next : item);
        setMusicClips(clips);
        const limit = Math.max(DURATION, ...clips.map(item => item.end), ...layers.map(item => item.end));
        if (clock.current > limit) seek(limit);
        if (asset) media.current!.currentTime = sourceTime(next, clamp(clock.current, next.start, next.end));
      }}
      playing={playing} onReorder={reorder}
      onSelect={selectItem} onSeek={seek} onEdit={edit}
      onEditStart={beginTimelineEdit} onEditFinish={cancel => {
        timelineEditing.current = false;
        groupDrag.current = null;
        finishEdit(cancel);
      }}
      onRename={(id, name) => {
        if (frame.current !== null) return;
        const previous = layers.find(item => trackId(item) === id)?.name;
        if (previous === undefined || previous === name) return;
        setLayers(items => items.map(item => trackId(item) === id ? { ...item, name } : item));
      }}
      onToggle={id => setExpanded(current => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      })} /></div>
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
