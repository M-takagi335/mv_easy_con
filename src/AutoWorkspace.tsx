import type { ReactNode } from 'react';
import type { AutoMv } from './autoMv';
import { lyricLines } from './autoMv';
import { usePlayhead } from './playhead';
import type { Playhead } from './playhead';
import { formatTime } from './Timeline';

type Props = {
  mv: AutoMv; ready: boolean; busy: boolean; musicName?: string; hasAudio: boolean;
  musicEnd: number; playbackEnd: number; playing: boolean; playhead: Playhead;
  preview?: ReactNode; error: string;
  importMusic: () => void; open: () => void; save: () => void; edit: () => void;
  play: () => void; seek: (time: number) => void; mark: () => void; undo: () => void;
  setLyrics: (text: string) => void; setStart: (index: number, time: number) => void;
  setEnd: (time: number) => void; generate: () => void; restore: (id: string) => void;
  exportVideo: () => void;
};

function Transport({ playhead, limit, playing, disabled, play, seek }: {
  playhead: Playhead; limit: number; playing: boolean; disabled: boolean;
  play: () => void; seek: (time: number) => void;
}) {
  const time = Math.min(usePlayhead(playhead), limit);
  return <div className="auto-transport">
    <button type="button" disabled={disabled} onClick={play}>{playing ? '一時停止' : '再生'}</button>
    <input type="range" aria-label="再生位置" min={0} max={limit || 1} step="0.001"
      value={time} disabled={disabled} onChange={event => seek(event.target.valueAsNumber)} />
    <span>{formatTime(time)} / {formatTime(limit)}</span>
  </div>;
}

function TimeInput({ label, value, max, change }: {
  label: string; value: number; max: number; change: (time: number) => void;
}) {
  const displayed = Number(value.toFixed(3));
  return <input type="number" aria-label={label} min={0} max={max} step="0.001" key={value}
    defaultValue={displayed}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
    onBlur={event => {
      const field = event.currentTarget;
      if (field.valueAsNumber !== displayed) change(field.valueAsNumber);
      field.value = String(displayed);
    }} />;
}

export function AutoWorkspace(props: Props) {
  const { mv, busy, musicEnd, hasAudio, playing, ready, preview } = props;
  const lines = lyricLines(mv.lyrics);
  const next = mv.starts.length;
  const end = mv.end ?? musicEnd;
  const canGenerate = ready && !busy && hasAudio && next > 0 && next === lines.length &&
    end <= musicEnd && end > mv.starts[next - 1];
  return <div className="auto-app" inert={busy}>
    <header className="auto-header">
      <h1>MV Easy</h1>
      <nav aria-label="プロジェクト">
        <button type="button" onClick={props.open}>開く</button>
        <button type="button" disabled={!ready} onClick={props.save}>プロジェクトを保存</button>
        <button type="button" disabled={!ready} onClick={props.edit}>詳細編集</button>
      </nav>
    </header>
    <div className="auto-grid">
      <section className="auto-card">
        <h2>音楽と歌詞</h2>
        <div className="auto-row">
          <button type="button" disabled={!ready || playing} onClick={props.importMusic}>
            {hasAudio ? '音楽を変更' : '音楽を読み込む'}</button>
          {props.musicName && <span className="auto-filename" title={props.musicName}>{props.musicName}</span>}
        </div>
        <label className="auto-field">歌詞
          <textarea rows={5} value={mv.lyrics} placeholder="歌詞を改行ごとに貼り付け"
            disabled={!ready || playing} onChange={event => props.setLyrics(event.target.value)} />
        </label>
        <div className="auto-sync">
          <div className="auto-row"><h2>歌詞を同期</h2><span>{next} / {lines.length} 行</span></div>
          <p>曲を再生し、歌い出しでスペースキーを押します。</p>
          <p className="auto-current" aria-live="polite">{lines[next] ?? (lines.length ? '同期完了' : '歌詞を入力してください')}</p>
          {lines[next + 1] && <p className="auto-next">次の行　{lines[next + 1]}</p>}
          <Transport playhead={props.playhead} limit={musicEnd} playing={playing}
            disabled={!hasAudio || !ready} play={props.play} seek={props.seek} />
          <div className="auto-row">
            <button type="button" disabled={!hasAudio || !playing || next >= lines.length} onClick={props.mark}>時刻を記録</button>
            <button type="button" disabled={!next} onClick={props.undo}>1つ戻る</button>
          </div>
          {next > 0 && <details className="auto-times"><summary>記録時刻を修正</summary>
            <ol>{mv.starts.map((start, index) => <li key={index}>
              <span>{lines[index]}</span>
              <TimeInput label={`${index + 1}行目の開始秒`} value={start} max={musicEnd}
                change={time => props.setStart(index, time)} />
            </li>)}</ol>
            <label className="auto-row">最後の歌詞の終了秒
              <TimeInput label="最後の歌詞の終了秒" value={end} max={musicEnd} change={props.setEnd} />
            </label>
          </details>}
        </div>
        {props.error && <p className="auto-error" role="alert">{props.error}</p>}
        <button type="button" className="primary auto-generate" disabled={!canGenerate}
          onClick={props.generate}>{mv.active ? 'もう一度生成' : 'MVを自動生成'}</button>
      </section>
      <section className="auto-card">
        <div className="auto-row"><h2>プレビュー</h2>
          {mv.active && mv.versions.length > 0 && <label className="auto-versions">生成履歴
            <select value={mv.active} onChange={event => props.restore(event.target.value)}>
              {mv.versions.map(version => <option key={version.id} value={version.id}>{version.name}</option>)}
            </select>
          </label>}
        </div>
        {preview ?? <div className="auto-placeholder">生成したMVがここに表示されます</div>}
        {preview && <>
          <Transport playhead={props.playhead} limit={props.playbackEnd} playing={playing}
            disabled={!ready} play={props.play} seek={props.seek} />
          <button type="button" className="primary" disabled={!ready} onClick={props.exportVideo}>動画を保存</button>
        </>}
      </section>
    </div>
  </div>;
}
