import type { MembershipTaskCenter } from "@weftcanvas/contracts";
import { create } from "zustand";

import {
  CanvasApiError,
  claimMembershipTask,
  fetchMembershipTasks,
  recordCanvasNodeCreated,
} from "../lib/api-client";
import { useIdentityStore } from "./identity-store";
import { useToastStore } from "./toast-store";
import { useWalletStore } from "./wallet-store";

type LoadStatus = "idle" | "loading" | "ready" | "error";

type MembershipTaskState = {
  data: MembershipTaskCenter | null;
  status: LoadStatus;
  error: string | null;
  claimingKey: string | null;
  nodeRewardStatus: "idle" | "recording" | "recorded" | "error";
  requestedOpen: boolean;
  load: (force?: boolean) => Promise<void>;
  claim: (taskKey: string) => Promise<string | null>;
  recordNodeCreated: () => Promise<void>;
  requestOpen: () => void;
  clearRequestedOpen: () => void;
  reset: () => void;
};

let loadRequest: Promise<void> | null = null;
let nodeRewardRequest: Promise<void> | null = null;
let taskEpoch = 0;

export function countClaimableMembershipTasks(data: MembershipTaskCenter | null) {
  if (!data) return 0;
  const itemKeys = new Set(data.items.map((item) => item.key));
  let count = data.items.filter(
    (item) => item.kind === "claim" && item.ready && !item.claimed,
  ).length;
  if (
    !itemKeys.has(data.hub.dailyBonus.key) &&
    data.hub.dailyBonus.ready &&
    !data.hub.dailyBonus.claimed
  )
    count += 1;
  if (
    data.hub.memberDaily &&
    !itemKeys.has(data.hub.memberDaily.key) &&
    data.hub.memberDaily.ready &&
    !data.hub.memberDaily.claimed
  )
    count += 1;
  return count;
}

export const useMembershipTaskStore = create<MembershipTaskState>((set, get) => ({
  data: null,
  status: "idle",
  error: null,
  claimingKey: null,
  nodeRewardStatus: "idle",
  requestedOpen: false,

  load: async (force = false) => {
    if (useIdentityStore.getState().status !== "authenticated") return;
    if (!force && get().status === "ready") return;
    if (loadRequest) return loadRequest;
    const ownerId = useIdentityStore.getState().session?.user.id;
    const epoch = taskEpoch;
    set({ status: "loading", error: null });
    const request = (async () => {
      try {
        const data = await fetchMembershipTasks();
        if (currentRequest(epoch, ownerId)) set({ data, status: "ready", error: null });
      } catch (cause) {
        if (!currentRequest(epoch, ownerId)) return;
        handleUnauthorized(cause);
        set({ status: "error", error: taskError(cause) });
      } finally {
        if (epoch === taskEpoch) loadRequest = null;
      }
    })();
    loadRequest = request;
    return request;
  },

  claim: async (taskKey) => {
    if (get().claimingKey) return null;
    const ownerId = useIdentityStore.getState().session?.user.id;
    const epoch = taskEpoch;
    set({ claimingKey: taskKey, error: null });
    try {
      const result = await claimMembershipTask(taskKey);
      if (!currentRequest(epoch, ownerId)) return null;
      // 服务端已经落账：先把任务翻转为已领取并立刻返回成功消息，让按钮状态和
      // 成功提示第一时间出现；任务列表 / 积分余额 / 积分流水的刷新放到后台执行，
      // 避免正反馈被一连串刷新的等待时间推迟甚至被面板动画淹没。
      set((state) => ({ data: markClaimed(state.data, taskKey) }));
      void Promise.allSettled([
        get().load(true),
        useWalletStore.getState().loadSummary(true),
        useWalletStore.getState().loadLedger(true),
      ]);
      return result.message;
    } catch (cause) {
      if (!currentRequest(epoch, ownerId)) return null;
      handleUnauthorized(cause);
      // A response can be lost after an upstream claim commits. Reloading the
      // canonical task list distinguishes that case without another grant.
      await get()
        .load(true)
        .catch(() => undefined);
      set({ error: taskError(cause) });
      return null;
    } finally {
      if (currentRequest(epoch, ownerId)) set({ claimingKey: null });
    }
  },

  recordNodeCreated: async () => {
    if (useIdentityStore.getState().status !== "authenticated") return;
    if (get().nodeRewardStatus === "recorded") return;
    if (nodeRewardRequest) return nodeRewardRequest;
    const ownerId = useIdentityStore.getState().session?.user.id;
    const epoch = taskEpoch;
    set({ nodeRewardStatus: "recording" });
    const request = (async () => {
      try {
        const result = await recordCanvasNodeCreated();
        if (!currentRequest(epoch, ownerId)) return;
        set({ nodeRewardStatus: "recorded", error: null });
        await Promise.all([get().load(true), useWalletStore.getState().loadSummary(true)]);
        if (result.granted) {
          useToastStore.getState().show("创建节点任务完成，已获得 1 天基础会员", "success");
        }
      } catch (cause) {
        if (!currentRequest(epoch, ownerId)) return;
        handleUnauthorized(cause);
        set({ nodeRewardStatus: "error" });
      } finally {
        if (epoch === taskEpoch) nodeRewardRequest = null;
      }
    })();
    nodeRewardRequest = request;
    return request;
  },

  requestOpen: () => set({ requestedOpen: true }),
  clearRequestedOpen: () => set({ requestedOpen: false }),
  reset: () => {
    taskEpoch += 1;
    loadRequest = null;
    nodeRewardRequest = null;
    set({
      data: null,
      status: "idle",
      error: null,
      claimingKey: null,
      nodeRewardStatus: "idle",
      requestedOpen: false,
    });
  },
}));

function currentRequest(epoch: number, ownerId: string | undefined) {
  return (
    epoch === taskEpoch &&
    ownerId !== undefined &&
    useIdentityStore.getState().session?.user.id === ownerId
  );
}

function handleUnauthorized(cause: unknown) {
  if (cause instanceof CanvasApiError && cause.status === 401) {
    useIdentityStore.getState().expire();
  }
}

function taskError(cause: unknown) {
  return cause instanceof CanvasApiError ? cause.message : "任务中心暂时无法连接";
}

function markClaimed(
  data: MembershipTaskCenter | null,
  taskKey: string,
): MembershipTaskCenter | null {
  if (!data) return null;
  const patchEntry = <T extends { key: string; claimed: boolean }>(entry: T | null): T | null =>
    entry && entry.key === taskKey ? { ...entry, claimed: true } : entry;
  return {
    ...data,
    hub: {
      ...data.hub,
      dailyBonus: patchEntry(data.hub.dailyBonus)!,
      memberDaily: patchEntry(data.hub.memberDaily),
    },
    items: data.items.map((item) => (item.key === taskKey ? { ...item, claimed: true } : item)),
  };
}
