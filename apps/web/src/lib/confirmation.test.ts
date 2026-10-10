import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getConfirmationSnapshot,
  requestConfirmation,
  resetConfirmationForTests,
  resolveConfirmation,
  subscribeToConfirmation,
} from "./confirmation";

afterEach(() => resetConfirmationForTests());

describe("confirmation service", () => {
  it("resolves the active request through the matching dialog id", async () => {
    const pending = requestConfirmation({ title: "删除", description: "确认删除" });
    const active = getConfirmationSnapshot();
    expect(active?.options.title).toBe("删除");

    resolveConfirmation(active!.id, true);
    await expect(pending).resolves.toBe(true);
    expect(getConfirmationSnapshot()).toBeNull();
  });

  it("cancels an older request when a newer confirmation replaces it", async () => {
    const first = requestConfirmation({ title: "旧请求", description: "旧请求" });
    const second = requestConfirmation({ title: "新请求", description: "新请求" });
    await expect(first).resolves.toBe(false);

    const active = getConfirmationSnapshot();
    expect(active?.options.title).toBe("新请求");
    resolveConfirmation(active!.id, false);
    await expect(second).resolves.toBe(false);
  });

  it("notifies subscribers when a request opens and closes", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToConfirmation(listener);
    const pending = requestConfirmation({ title: "确认", description: "确认操作" });
    const active = getConfirmationSnapshot();
    resolveConfirmation(active!.id, false);
    await pending;

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
