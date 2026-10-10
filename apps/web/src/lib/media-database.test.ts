import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MEDIA_STORE_NAME,
  MEDIA_THUMB_STORE_NAME,
  __resetMediaDatabaseForTests,
  openMediaDatabase,
} from "./media-database";

type FakeRecord = { version: number; stores: Set<string> };

function makeFakeIndexedDB() {
  const databases = new Map<string, FakeRecord>();
  const openCalls: Array<{ name: string; version?: number }> = [];

  const idb = {
    open(name: string, version?: number) {
      openCalls.push({ name, version });
      const record: FakeRecord = databases.get(name) ?? { version: 0, stores: new Set<string>() };
      databases.set(name, record);
      const request: {
        result?: unknown;
        error?: unknown;
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
        onerror?: () => void;
      } = {};
      queueMicrotask(() => {
        if (version !== undefined && version < record.version) {
          request.error = {
            name: "VersionError",
            message: `The requested version (${version}) is less than the existing version (${record.version}).`,
          };
          request.onerror?.();
          return;
        }
        const database = {
          objectStoreNames: { contains: (store: string) => record.stores.has(store) },
          createObjectStore: (store: string) => {
            record.stores.add(store);
            return {};
          },
          close: () => undefined,
          onversionchange: null as (() => void) | null,
          onclose: null as (() => void) | null,
        };
        if (version !== undefined && version > record.version) {
          record.version = version;
          request.result = database;
          request.onupgradeneeded?.();
        }
        request.result = database;
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { idb, databases, openCalls };
}

describe("media database", () => {
  beforeEach(() => {
    __resetMediaDatabaseForTests();
  });
  afterEach(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    __resetMediaDatabaseForTests();
  });

  it("creates the media and thumbnail stores in one database at one version", async () => {
    const { idb, databases, openCalls } = makeFakeIndexedDB();
    (globalThis as { indexedDB?: unknown }).indexedDB = idb;

    const database = await openMediaDatabase();

    expect(database.objectStoreNames.contains(MEDIA_STORE_NAME)).toBe(true);
    expect(database.objectStoreNames.contains(MEDIA_THUMB_STORE_NAME)).toBe(true);
    expect(openCalls).toEqual([{ name: "kachang-canvas-media", version: 2 }]);
    expect([...databases.values()][0]?.version).toBe(2);
  });

  it("reuses a single connection so a second consumer cannot downgrade the version", async () => {
    const { idb, openCalls } = makeFakeIndexedDB();
    (globalThis as { indexedDB?: unknown }).indexedDB = idb;

    const first = await openMediaDatabase();
    const second = await openMediaDatabase();

    expect(second).toBe(first);
    // Regression guard: media-store and the thumbnail pipeline used to open the
    // same database at versions 1 and 2 independently, which threw VersionError
    // for every readMedia after the first thumbnail render. One shared opener
    // means exactly one open call for the whole session.
    expect(openCalls).toHaveLength(1);
  });
});
