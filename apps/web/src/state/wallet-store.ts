import type {
  WalletCheckoutRequest,
  WalletCustomCreditTopUp,
  WalletLedgerItem,
  WalletOrder,
  WalletProduct,
  WalletRedeemRequest,
  WalletSummary,
} from "@weftcanvas/contracts";
import { create } from "zustand";

import {
  CanvasApiError,
  createWalletCheckout,
  fetchWallet,
  fetchWalletLedger,
  fetchWalletOrder,
  fetchWalletProducts,
  redeemWalletCode,
} from "../lib/api-client";
import { useIdentityStore } from "./identity-store";

type LoadStatus = "idle" | "loading" | "ready" | "error";

type WalletState = {
  summary: WalletSummary | null;
  products: WalletProduct[];
  requestedProductKind: WalletProduct["kind"] | null;
  customCreditTopUp: WalletCustomCreditTopUp | null;
  ledger: WalletLedgerItem[];
  summaryStatus: LoadStatus;
  productsStatus: LoadStatus;
  ledgerStatus: LoadStatus;
  error: string | null;
  loadSummary: (force?: boolean) => Promise<void>;
  loadProducts: (force?: boolean) => Promise<void>;
  loadLedger: (force?: boolean) => Promise<void>;
  checkout: (input: WalletCheckoutRequest) => Promise<{ orderNo: string; checkoutUrl: string }>;
  readOrder: (orderNo: string) => Promise<WalletOrder>;
  redeem: (input: WalletRedeemRequest) => Promise<string>;
  requestProduct: (kind: WalletProduct["kind"]) => void;
  clearRequestedProduct: () => void;
  clearError: () => void;
  reset: () => void;
};

let summaryRequest: Promise<void> | null = null;
let productsRequest: Promise<void> | null = null;
let ledgerRequest: Promise<void> | null = null;
let walletEpoch = 0;

export const useWalletStore = create<WalletState>((set, get) => ({
  summary: null,
  products: [],
  requestedProductKind: null,
  customCreditTopUp: null,
  ledger: [],
  summaryStatus: "idle",
  productsStatus: "idle",
  ledgerStatus: "idle",
  error: null,

  loadSummary: async (force = false) => {
    if (useIdentityStore.getState().status !== "authenticated") return;
    if (!force && get().summaryStatus === "ready") return;
    if (summaryRequest) return summaryRequest;
    const requestOwner = useIdentityStore.getState().session?.user.id;
    const requestEpoch = walletEpoch;
    set({ summaryStatus: "loading", error: null });
    const request = (async () => {
      try {
        const summary = await fetchWallet();
        if (currentWalletRequest(requestEpoch, requestOwner))
          set({ summary, summaryStatus: "ready", error: null });
      } catch (cause) {
        if (!currentWalletRequest(requestEpoch, requestOwner)) return;
        handleUnauthorized(cause);
        set({ summaryStatus: "error", error: walletError(cause) });
      } finally {
        if (requestEpoch === walletEpoch) summaryRequest = null;
      }
    })();
    summaryRequest = request;
    return request;
  },

  loadProducts: async (force = false) => {
    if (useIdentityStore.getState().status !== "authenticated") return;
    if (!force && get().productsStatus === "ready") return;
    if (productsRequest) return productsRequest;
    const requestOwner = useIdentityStore.getState().session?.user.id;
    const requestEpoch = walletEpoch;
    set({ productsStatus: "loading", error: null });
    const request = (async () => {
      try {
        const catalog = await fetchWalletProducts();
        if (currentWalletRequest(requestEpoch, requestOwner)) {
          set({
            products: catalog.products,
            customCreditTopUp: catalog.customCreditTopUp,
            productsStatus: "ready",
            error: null,
          });
        }
      } catch (cause) {
        if (!currentWalletRequest(requestEpoch, requestOwner)) return;
        handleUnauthorized(cause);
        set({ productsStatus: "error", error: walletError(cause) });
      } finally {
        if (requestEpoch === walletEpoch) productsRequest = null;
      }
    })();
    productsRequest = request;
    return request;
  },

  loadLedger: async (force = false) => {
    if (useIdentityStore.getState().status !== "authenticated") return;
    if (!force && get().ledgerStatus === "ready") return;
    if (ledgerRequest) return ledgerRequest;
    const requestOwner = useIdentityStore.getState().session?.user.id;
    const requestEpoch = walletEpoch;
    set({ ledgerStatus: "loading", error: null });
    const request = (async () => {
      try {
        const ledger = await fetchWalletLedger(20);
        if (currentWalletRequest(requestEpoch, requestOwner))
          set({ ledger, ledgerStatus: "ready", error: null });
      } catch (cause) {
        if (!currentWalletRequest(requestEpoch, requestOwner)) return;
        handleUnauthorized(cause);
        set({ ledgerStatus: "error", error: walletError(cause) });
      } finally {
        if (requestEpoch === walletEpoch) ledgerRequest = null;
      }
    })();
    ledgerRequest = request;
    return request;
  },

  checkout: async (input) => {
    const requestOwner = useIdentityStore.getState().session?.user.id;
    const requestEpoch = walletEpoch;
    set({ error: null });
    try {
      const result = await createWalletCheckout(input);
      return result;
    } catch (cause) {
      if (!currentWalletRequest(requestEpoch, requestOwner))
        throw new Error("账号状态已变化，请重新操作");
      handleUnauthorized(cause);
      const error = walletError(cause);
      set({ error });
      throw new Error(error);
    }
  },

  readOrder: async (orderNo) => {
    const requestOwner = useIdentityStore.getState().session?.user.id;
    const requestEpoch = walletEpoch;
    try {
      return await fetchWalletOrder(orderNo);
    } catch (cause) {
      if (!currentWalletRequest(requestEpoch, requestOwner))
        throw new Error("账号状态已变化，请重新操作");
      handleUnauthorized(cause);
      const error = walletError(cause);
      set({ error });
      throw new Error(error);
    }
  },

  redeem: async (input) => {
    const requestOwner = useIdentityStore.getState().session?.user.id;
    const requestEpoch = walletEpoch;
    set({ error: null });
    try {
      const result = await redeemWalletCode(input);
      if (currentWalletRequest(requestEpoch, requestOwner)) {
        set({
          ...(result.summary
            ? { summary: result.summary, summaryStatus: "ready" as const }
            : { summaryStatus: "idle" as const }),
          ledgerStatus: "idle",
          error: null,
        });
        if (!result.summary) void get().loadSummary(true);
        void get().loadLedger(true);
      }
      return result.message;
    } catch (cause) {
      if (!currentWalletRequest(requestEpoch, requestOwner))
        throw new Error("账号状态已变化，请重新操作");
      handleUnauthorized(cause);
      const error = walletError(cause);
      set({ error });
      throw new Error(error);
    }
  },

  requestProduct: (kind) => set({ requestedProductKind: kind, error: null }),
  clearRequestedProduct: () => set({ requestedProductKind: null }),
  clearError: () => set({ error: null }),
  reset: () => {
    walletEpoch += 1;
    summaryRequest = null;
    productsRequest = null;
    ledgerRequest = null;
    set({
      summary: null,
      products: [],
      requestedProductKind: null,
      customCreditTopUp: null,
      ledger: [],
      summaryStatus: "idle",
      productsStatus: "idle",
      ledgerStatus: "idle",
      error: null,
    });
  },
}));

function handleUnauthorized(cause: unknown) {
  // Wallet requests use the same Canvas session cookie as identity requests.
  // The API clears that cookie whenever the provider reports 401, so keeping
  // the browser in an authenticated state would leave stale credits visible
  // and make the account dialog impossible to recover without a reload.
  if (cause instanceof CanvasApiError && cause.status === 401) {
    useIdentityStore.getState().expire();
  }
}

function walletError(cause: unknown) {
  return cause instanceof CanvasApiError ? cause.message : "积分操作没有完成";
}

function currentWalletRequest(epoch: number, ownerId: string | undefined) {
  return (
    epoch === walletEpoch &&
    ownerId !== undefined &&
    useIdentityStore.getState().session?.user.id === ownerId
  );
}
