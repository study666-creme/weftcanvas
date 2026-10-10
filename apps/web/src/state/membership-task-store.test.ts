import type { MembershipTaskCenter } from "@kachang/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchMembershipTasks: vi.fn(),
  claimMembershipTask: vi.fn(),
  recordCanvasNodeCreated: vi.fn(),
}));

const wallet = vi.hoisted(() => ({
  loadSummary: vi.fn(),
  loadLedger: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  show: vi.fn(),
}));

const identity = vi.hoisted(() => ({
  state: null as unknown as {
    status: "authenticated" | "unauthenticated";
    session: { user: { id: string } } | null;
    expire: () => void;
  },
  expire: vi.fn(),
}));

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api-client")>();
  return {
    ...actual,
    fetchMembershipTasks: api.fetchMembershipTasks,
    claimMembershipTask: api.claimMembershipTask,
    recordCanvasNodeCreated: api.recordCanvasNodeCreated,
  };
});

vi.mock("./identity-store", () => ({
  useIdentityStore: { getState: () => identity.state },
}));

vi.mock("./wallet-store", () => ({
  useWalletStore: {
    getState: () => ({
      loadSummary: wallet.loadSummary,
      loadLedger: wallet.loadLedger,
    }),
  },
}));

vi.mock("./toast-store", () => ({
  useToastStore: { getState: () => ({ show: toast.show }) },
}));

import { CanvasApiError } from "../lib/api-client";
import { useMembershipTaskStore } from "./membership-task-store";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

describe("membership task state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuthenticated(USER_A);
    api.fetchMembershipTasks.mockResolvedValue(taskCenter());
    wallet.loadSummary.mockResolvedValue(undefined);
    wallet.loadLedger.mockResolvedValue(undefined);
    useMembershipTaskStore.getState().reset();
  });

  it("deduplicates concurrent task-center loads and keeps the canonical response", async () => {
    const pending = deferred<MembershipTaskCenter>();
    api.fetchMembershipTasks.mockReturnValue(pending.promise);

    const first = useMembershipTaskStore.getState().load();
    const second = useMembershipTaskStore.getState().load();
    expect(api.fetchMembershipTasks).toHaveBeenCalledTimes(1);

    pending.resolve(taskCenter());
    await Promise.all([first, second]);

    expect(useMembershipTaskStore.getState()).toMatchObject({
      status: "ready",
      error: null,
      data: { items: [{ key: "canvas_create_node" }] },
    });
  });

  it("records a granted node reward once, refreshes shared membership, and suppresses later repeats", async () => {
    const pending = deferred<{ message: string; granted: boolean }>();
    api.recordCanvasNodeCreated.mockReturnValue(pending.promise);

    const first = useMembershipTaskStore.getState().recordNodeCreated();
    const second = useMembershipTaskStore.getState().recordNodeCreated();
    expect(api.recordCanvasNodeCreated).toHaveBeenCalledTimes(1);
    expect(useMembershipTaskStore.getState().nodeRewardStatus).toBe("recording");

    pending.resolve({ message: "创建节点任务已完成", granted: true });
    await Promise.all([first, second]);

    expect(useMembershipTaskStore.getState().nodeRewardStatus).toBe("recorded");
    expect(api.fetchMembershipTasks).toHaveBeenCalledTimes(1);
    expect(wallet.loadSummary).toHaveBeenCalledWith(true);
    expect(wallet.loadLedger).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalledWith("创建节点任务完成，已获得 1 天基础会员", "success");

    await useMembershipTaskStore.getState().recordNodeCreated();
    expect(api.recordCanvasNodeCreated).toHaveBeenCalledTimes(1);
  });

  it("accepts an idempotent duplicate node event without showing another reward toast", async () => {
    api.recordCanvasNodeCreated.mockResolvedValue({ message: "任务已经完成", granted: false });

    await useMembershipTaskStore.getState().recordNodeCreated();

    expect(useMembershipTaskStore.getState().nodeRewardStatus).toBe("recorded");
    expect(wallet.loadSummary).toHaveBeenCalledWith(true);
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("leaves a failed node event retryable and succeeds on the next attempt", async () => {
    api.recordCanvasNodeCreated
      .mockRejectedValueOnce(new CanvasApiError(503, "TASK_PROVIDER_UNAVAILABLE", "任务服务暂不可用"))
      .mockResolvedValueOnce({ message: "创建节点任务已完成", granted: true });

    await useMembershipTaskStore.getState().recordNodeCreated();
    expect(useMembershipTaskStore.getState().nodeRewardStatus).toBe("error");

    await useMembershipTaskStore.getState().recordNodeCreated();
    expect(api.recordCanvasNodeCreated).toHaveBeenCalledTimes(2);
    expect(useMembershipTaskStore.getState().nodeRewardStatus).toBe("recorded");
  });

  it("discards a late node-event response after the account changes", async () => {
    const pending = deferred<{ message: string; granted: boolean }>();
    api.recordCanvasNodeCreated.mockReturnValue(pending.promise);

    const request = useMembershipTaskStore.getState().recordNodeCreated();
    useMembershipTaskStore.getState().reset();
    setAuthenticated(USER_B);
    pending.resolve({ message: "创建节点任务已完成", granted: true });
    await request;

    expect(useMembershipTaskStore.getState()).toMatchObject({
      nodeRewardStatus: "idle",
      data: null,
      error: null,
    });
    expect(wallet.loadSummary).not.toHaveBeenCalled();
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("expires the shared identity after an unauthorized task event", async () => {
    api.recordCanvasNodeCreated.mockRejectedValue(
      new CanvasApiError(401, "UNAUTHENTICATED", "登录已过期，请重新登录"),
    );

    await useMembershipTaskStore.getState().recordNodeCreated();

    expect(identity.expire).toHaveBeenCalledTimes(1);
    expect(identity.state.status).toBe("unauthenticated");
    expect(useMembershipTaskStore.getState().nodeRewardStatus).toBe("error");
  });

  it("serializes task claims, flips the claimed state immediately, and refreshes in the background", async () => {
    await useMembershipTaskStore.getState().load();
    const pending = deferred<{ message: string }>();
    const refresh = deferred<MembershipTaskCenter>();
    api.claimMembershipTask.mockReturnValue(pending.promise);
    api.fetchMembershipTasks.mockReturnValueOnce(refresh.promise);

    const first = useMembershipTaskStore.getState().claim("canvas_create_node");
    const second = useMembershipTaskStore.getState().claim("canvas_create_node");
    expect(api.claimMembershipTask).toHaveBeenCalledTimes(1);
    expect(useMembershipTaskStore.getState().claimingKey).toBe("canvas_create_node");

    pending.resolve({ message: "已领取 1 天基础会员" });
    await expect(first).resolves.toBe("已领取 1 天基础会员");
    await expect(second).resolves.toBeNull();
    expect(useMembershipTaskStore.getState().claimingKey).toBeNull();
    // The task flips to claimed before the slow refresh settles.
    expect(useMembershipTaskStore.getState().data?.items[0]?.claimed).toBe(true);
    expect(useMembershipTaskStore.getState().data?.items[0]?.key).toBe("canvas_create_node");
    expect(api.fetchMembershipTasks).toHaveBeenCalledTimes(2);
    expect(wallet.loadSummary).toHaveBeenCalledWith(true);
    expect(wallet.loadLedger).toHaveBeenCalledWith(true);

    refresh.resolve(taskCenter());
    await useMembershipTaskStore.getState().load(true).catch(() => undefined);
    expect(useMembershipTaskStore.getState().data?.items[0]?.claimed).toBe(false);
  });

  it("does not call task APIs while signed out", async () => {
    identity.state = { status: "unauthenticated", session: null, expire: identity.expire };

    await useMembershipTaskStore.getState().load();
    await useMembershipTaskStore.getState().recordNodeCreated();

    expect(api.fetchMembershipTasks).not.toHaveBeenCalled();
    expect(api.recordCanvasNodeCreated).not.toHaveBeenCalled();
  });
});

function setAuthenticated(userId: string) {
  identity.expire.mockImplementation(() => {
    identity.state = { status: "unauthenticated", session: null, expire: identity.expire };
  });
  identity.state = {
    status: "authenticated",
    session: { user: { id: userId } },
    expire: identity.expire,
  };
}

function taskCenter(): MembershipTaskCenter {
  return {
    items: [{
      key: "canvas_create_node",
      title: "创建一个画布节点",
      description: "在画布中成功创建任意节点",
      rewardDays: 1,
      rewardCredits: 0,
      rewardTier: "basic",
      claimed: false,
      ready: true,
      progress: null,
      kind: "claim",
    }],
    lifetimeCreditsSpent: 0,
    nextSpendMilestone: 1_000,
    hub: {
      phoneVerified: true,
      signStreak: 0,
      checkedInToday: false,
      daysToStreakBonus: 7,
      dailyBonus: { key: "daily_bonus_2026-07-26", claimed: false, ready: true },
      memberDaily: null,
    },
    phoneVerified: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
