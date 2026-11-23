import type { ProjectLayer } from './model.ts';
import type { Settings } from './projectFile.ts';
import type { MusicClip } from './music.ts';
import type { AutoMv } from './autoMv.ts';

export type Project = { version?: 1; settings?: Settings; layers: ProjectLayer[]; music: MusicClip | null; musicClips?: MusicClip[]; animationTime?: 'relative'; autoMv?: AutoMv };
export type MusicAsset = { file: Blob; peaks: Float32Array };

function openProject(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('mv-easy', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('project');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readProject() {
  const db = await openProject();
  try {
    return await new Promise<{ project?: Project; asset?: MusicAsset }>((resolve, reject) => {
      const transaction = db.transaction('project');
      const store = transaction.objectStore('project');
      const request = store.get('current');
      let result: { project?: Project; asset?: MusicAsset } = {};
      request.onsuccess = () => {
        const project = request.result as Project | undefined;
        result = { project };
        if (project?.music) {
          const asset = store.get(project.music.asset.id);
          asset.onsuccess = () => { result.asset = asset.result; };
        }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export async function saveProject(project: Project, asset?: MusicAsset) {
  const db = await openProject();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('project', 'readwrite');
      const store = transaction.objectStore('project');
      const request = store.get('current');
      request.onsuccess = () => {
        const previousId = (request.result as Project | undefined)?.music?.asset.id;
        const nextId = project.music?.asset.id;
        if (asset && nextId) store.put(asset, nextId);
        if (previousId && (previousId !== nextId || !asset)) store.delete(previousId);
        store.put(project, 'current');
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
