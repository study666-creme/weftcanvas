import type { IdentityCapabilities, IdentitySession } from "@kachang/contracts";
import { create } from "zustand";

import {
  CanvasApiError,
  fetchIdentityState,
  loginIdentity,
  logoutIdentity,
  registerIdentity,
} from "../lib/api-client";

type IdentityStatus = "idle" | "loading" | "authenticated" | "anonymous" | "unavailable";
type IdentityMode = "login" | "register";
type IdentityRegistrationOutcome = "authenticated" | "verification_required" | false;

type IdentityState = {
  status: IdentityStatus;
  session: IdentitySession | null;
  capabilities: IdentityCapabilities;
  dialogOpen: boolean;
  mode: IdentityMode;
  busy: boolean;
  error: string | null;
  verificationEmail: string | null;
  hydrate: (force?: boolean) => Promise<void>;
  openDialog: (mode?: IdentityMode) => void;
  closeDialog: () => void;
  setMode: (mode: IdentityMode) => void;
  login: (email: string, password: string) => Promise<boolean>;
  register: (email: string, password: string, displayName?: string) => Promise<IdentityRegistrationOutcome>;
  logout: () => Promise<void>;
  expire: () => void;
};

let hydration: Promise<void> | null = null;
const fallbackCapabilities: IdentityCapabilities = {
  available: true,
  registration: "native",
  registrationUrl: null,
  passwordResetUrl: null,
};

export const useIdentityStore = create<IdentityState>((set, get) => ({
  status: "idle",
  session: null,
  capabilities: fallbackCapabilities,
  dialogOpen: false,
  mode: "login",
  busy: false,
  error: null,
  verificationEmail: null,

  hydrate: async (force = false) => {
    const state = get();
    if (!force && (state.status === "authenticated" || state.status === "anonymous" || state.status === "unavailable")) return;
    if (!force && hydration) return hydration;
    set({ status: "loading", error: null });
    hydration = (async () => {
      try {
        const response = await fetchIdentityState();
        const capabilities = response.capabilities ?? fallbackCapabilities;
        set({
          status: response.data ? "authenticated" : capabilities.available ? "anonymous" : "unavailable",
          session: response.data,
          capabilities,
          error: capabilities.available ? null : "账号服务尚未配置",
        });
      } catch (cause) {
        const error = publicError(cause);
        set({ status: "unavailable", session: null, error });
      } finally {
        hydration = null;
      }
    })();
    return hydration;
  },

  openDialog: (mode) => set((state) => ({ dialogOpen: true, mode: mode ?? state.mode, error: null, verificationEmail: null })),
  closeDialog: () => {
    if (!get().busy) set({ dialogOpen: false, error: null });
  },
  setMode: (mode) => set({ mode, error: null, verificationEmail: null }),

  login: async (email, password) => {
    set({ busy: true, error: null });
    try {
      const response = await loginIdentity({ email, password });
      set({
        status: "authenticated",
        session: response.data,
        capabilities: response.capabilities ?? get().capabilities,
        busy: false,
        dialogOpen: false,
        error: null,
        verificationEmail: null,
      });
      return true;
    } catch (cause) {
      set({ status: identityUnavailable(cause) ? "unavailable" : "anonymous", session: null, busy: false, error: publicError(cause), verificationEmail: null });
      return false;
    }
  },

  register: async (email, password, displayName) => {
    set({ busy: true, error: null });
    try {
      const response = await registerIdentity({
        email,
        password,
        ...(displayName?.trim() ? { displayName: displayName.trim() } : {}),
      });
      if (response.status === "verification_required") {
        set({
          status: "anonymous",
          session: null,
          capabilities: response.capabilities ?? get().capabilities,
          busy: false,
          dialogOpen: true,
          mode: "login",
          error: null,
          verificationEmail: response.data.email,
        });
        return "verification_required";
      }
      set({
        status: "authenticated",
        session: response.data,
        capabilities: response.capabilities ?? get().capabilities,
        busy: false,
        dialogOpen: false,
        error: null,
        verificationEmail: null,
      });
      return "authenticated";
    } catch (cause) {
      set({ status: identityUnavailable(cause) ? "unavailable" : "anonymous", session: null, busy: false, error: publicError(cause), verificationEmail: null });
      return false;
    }
  },

  logout: async () => {
    set({ busy: true, error: null });
    try {
      await logoutIdentity();
    } catch {
      // The local session is cleared even when the service is temporarily unreachable.
    }
    set({ status: "anonymous", session: null, busy: false, dialogOpen: false, error: null, verificationEmail: null });
  },

  expire: () => set({ status: "anonymous", session: null, dialogOpen: true, mode: "login", busy: false, error: "登录已过期，请重新登录", verificationEmail: null }),
}));

function publicError(cause: unknown) {
  return cause instanceof CanvasApiError ? cause.message : "账号操作没有完成";
}

function identityUnavailable(cause: unknown) {
  return cause instanceof CanvasApiError
    && (cause.status === 0 || cause.status >= 500 || cause.code === "IDENTITY_PROVIDER_UNAVAILABLE");
}
