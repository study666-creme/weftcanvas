// 画布本地媒体库的唯一 IndexedDB 入口。
//
// 媒体字节（media）与缩略图字节（media-thumbs）存放在同一个数据库里。历史上
// 两个模块各自 open 同一个库却用了不同版本号（media-store 停在 1、缩略图模块
// 升到 2），IndexedDB 不允许用更低的版本打开已存在的库，于是先建库的一方把
// 版本定死后，另一方每次 readMedia 都抛 VersionError——表现为「云端同步失败」
// 且请求根本发不出去。统一到这里后版本号只有一个，新增 store 也只需改这一处。

const DATABASE_NAME = "kachang-canvas-media";
const DATABASE_VERSION = 2;

export const MEDIA_STORE_NAME = "media";
export const MEDIA_THUMB_STORE_NAME = "media-thumbs";

let databasePromise: Promise<IDBDatabase> | null = null;

export function openMediaDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        database.createObjectStore(MEDIA_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(MEDIA_THUMB_STORE_NAME)) {
        database.createObjectStore(MEDIA_THUMB_STORE_NAME, { keyPath: "mediaId" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      database.onclose = () => {
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("媒体存储无法打开"));
    };
  });
  return databasePromise;
}

/** 仅供测试重置模块级连接缓存。 */
export function __resetMediaDatabaseForTests() {
  databasePromise = null;
}
