import { afterEach, describe, expect, it } from "vitest";

import { useWalletStore } from "./wallet-store";

describe("wallet product selection requests", () => {
  afterEach(() => {
    useWalletStore.getState().reset();
  });

  it("keeps a collaboration-seat request until the account dialog consumes it", () => {
    useWalletStore.getState().requestProduct("collaboration_seat");

    expect(useWalletStore.getState().requestedProductKind).toBe("collaboration_seat");

    useWalletStore.getState().clearRequestedProduct();
    expect(useWalletStore.getState().requestedProductKind).toBeNull();
  });

  it("clears a pending product request with account-scoped wallet state", () => {
    useWalletStore.getState().requestProduct("membership");

    useWalletStore.getState().reset();

    expect(useWalletStore.getState().requestedProductKind).toBeNull();
  });
});
