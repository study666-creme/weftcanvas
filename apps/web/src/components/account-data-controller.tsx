import { useEffect, useRef } from "react";

import { useIdentityStore } from "../state/identity-store";
import { useMembershipTaskStore } from "../state/membership-task-store";
import { useWalletStore } from "../state/wallet-store";

const WALLET_REFRESH_INTERVAL_MS = 5 * 60_000;

export function AccountDataController() {
  const identityStatus = useIdentityStore((state) => state.status);
  const identityUserId = useIdentityStore((state) => state.session?.user.id ?? null);
  const loadWalletSummary = useWalletStore((state) => state.loadSummary);
  const resetWallet = useWalletStore((state) => state.reset);
  const loadMembershipTasks = useMembershipTaskStore((state) => state.load);
  const resetMembershipTasks = useMembershipTaskStore((state) => state.reset);
  const previousIdentityUserId = useRef<string | null>(identityUserId);

  useEffect(() => {
    if (
      identityStatus === "authenticated" &&
      identityUserId &&
      previousIdentityUserId.current &&
      previousIdentityUserId.current !== identityUserId
    ) {
      resetWallet();
      resetMembershipTasks();
    }
    previousIdentityUserId.current = identityUserId;
    if (identityStatus === "anonymous" || identityStatus === "unavailable") {
      resetWallet();
      resetMembershipTasks();
      return;
    }
    if (identityStatus !== "authenticated" || !identityUserId) return;

    const refreshAccount = () => {
      if (document.visibilityState !== "hidden") {
        void Promise.all([loadWalletSummary(true), loadMembershipTasks(true)]);
      }
    };
    const refreshVisibleAccount = () => {
      if (document.visibilityState === "visible") refreshAccount();
    };

    refreshAccount();
    const intervalId = window.setInterval(refreshAccount, WALLET_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshAccount);
    document.addEventListener("visibilitychange", refreshVisibleAccount);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshAccount);
      document.removeEventListener("visibilitychange", refreshVisibleAccount);
    };
  }, [
    identityStatus,
    identityUserId,
    loadMembershipTasks,
    loadWalletSummary,
    resetMembershipTasks,
    resetWallet,
  ]);

  return null;
}
