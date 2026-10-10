import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

import { useToastStore } from "../state/toast-store";

const icons = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
};

export function ToastViewport() {
  const items = useToastStore((state) => state.items);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <div className="kc-toast-viewport" aria-live="polite">
      {items.map((item) => {
        const Icon = icons[item.tone];
        return (
          <div key={item.id} className={`kc-toast kc-toast--${item.tone}`}>
            <Icon aria-hidden="true" />
            <span>{item.message}</span>
            <button type="button" aria-label="关闭提示" title="关闭" onClick={() => dismiss(item.id)}>
              <X aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
