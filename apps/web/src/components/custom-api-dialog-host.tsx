import { lazy, Suspense, useEffect, useState } from "react";

import { useCustomApiStore } from "../state/custom-api-store";

const CustomApiDialog = lazy(async () => ({
  default: (await import("./custom-api-dialog")).CustomApiDialog,
}));

export function CustomApiDialogHost() {
  const open = useCustomApiStore((state) => state.dialogOpen);
  const [loaded, setLoaded] = useState(open);

  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);

  if (!loaded && !open) return null;
  return (
    <Suspense
      fallback={
        <div className="wc-lazy-dialog-backdrop" role="status" aria-label="正在打开">
          <span />
        </div>
      }
    >
      <CustomApiDialog />
    </Suspense>
  );
}
