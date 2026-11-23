import test from 'node:test';
import assert from 'node:assert/strict';
import { editStart, emptyAutoMv, generateMv, lyricLines, recordStart } from '../src/autoMv.ts';
import { evaluate } from '../src/animation.ts';
import { packLayers, unpackLayers } from '../src/model.ts';
import { defaultSettings, makeProjectFile, readProjectFile, validateProject } from '../src/projectFile.ts';
import { registry } from '../src/templates.ts';

test('lyric timestamps use audio precision, stay ordered and can be corrected', () => {
  assert.deepEqual(lyricLines('  最初の行  \r\n\r\n次の行\n'), ['最初の行', '次の行']);
  const starts = recordStart(recordStart([], 0.2738, 5), 1.7619, 5);
  assert.deepEqual(starts, [0.274, 1.762]);
  assert.equal(recordStart(starts, 1.5, 5), starts);
  assert.equal(recordStart(starts, 5, 5), starts);
  assert.equal(editStart(starts, 0, 2, 5), starts);
  assert.equal(editStart(starts, 1, 4, 4), starts);
  assert.deepEqual(editStart(starts, 1, 2.125, 4), [0.274, 2.125]);
});

test('regeneration changes the scene while retaining lyric timing and editable animations', () => {
  const lines = ['最初の行', '次の行'];
  const starts = [0.22, 1.1];
  const first = generateMv(lines, starts, 2, 3, -1);
  const second = generateMv(lines, starts, 2, 3, first.style);
  for (const version of [first, second]) {
    const lyrics = unpackLayers(packLayers(version.layers)).filter(layer => layer.kind === 'text');
    assert.deepEqual(lyrics.map(({ text, start, end }) => [text, start, end]),
      [['最初の行', 0.22, 1.1], ['次の行', 1.1, 2]]);
    assert.equal(lyrics[0].textTrackId, lyrics[1].textTrackId);
    assert.ok(version.layers.every(layer => layer.animations.every(a => registry.has(a.template) && a.start < a.end)));
    assert.equal(evaluate(lyrics[0], 0.6, registry).opacity, 1);
  }
  assert.notEqual(first.layers[0].y, second.layers[0].y);
  assert.notEqual(first.layers.at(-1).color, second.layers.at(-1).color);
  assert.deepEqual(starts, [0.22, 1.1]);
});

test('project files retain timing, active version and previously generated layers', async () => {
  const versions = [-1, 0].map((previous, i) => ({
    ...generateMv(['歌詞'], [0.5], 2, 3, previous), id: String(i), name: String(i),
    background: defaultSettings.background,
  }));
  const autoMv = { ...emptyAutoMv, lyrics: '歌詞', starts: [0.5], end: 2, versions, active: '1' };
  const project = { layers: packLayers(versions[1].layers), music: null, animationTime: 'relative', autoMv };
  assert.deepEqual((await readProjectFile(makeProjectFile(project))).project.autoMv, autoMv);
  assert.throws(() => validateProject({ ...project, autoMv: { ...autoMv, active: 'missing' } }));
  assert.throws(() => validateProject({ ...project, autoMv: { ...autoMv, end: 0.5 } }));
});
