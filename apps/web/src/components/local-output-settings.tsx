import {
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  LoaderCircle,
  RefreshCw,
  Trash2,
  Video,
} from "lucide-react";
import { useEffect } from "react";

import {
  useLocalOutputStore,
  type LocalOutputKind,
  type LocalOutputTargetState,
} from "../state/local-output-store";

const targetMeta: Record<
  LocalOutputKind,
  {
    label: string;
    detail: string;
    icon: typeof ImageIcon;
  }
> = {
  image: { label: "图片", detail: "未选择目录", icon: ImageIcon },
  video: { label: "视频", detail: "未选择目录", icon: Video },
};

export function LocalOutputSettings() {
  const supported = useLocalOutputStore((state) => state.supported);
  const initialized = useLocalOutputStore((state) => state.initialized);
  const targets = useLocalOutputStore((state) => state.targets);
  const initialize = useLocalOutputStore((state) => state.initialize);
  const chooseDirectory = useLocalOutputStore((state) => state.chooseDirectory);
  const requestDirectoryPermission = useLocalOutputStore(
    (state) => state.requestDirectoryPermission,
  );
  const setEnabled = useLocalOutputStore((state) => state.setEnabled);
  const clearDirectory = useLocalOutputStore((state) => state.clearDirectory);
  const retryPending = useLocalOutputStore((state) => state.retryPending);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  if (!supported) {
    return (
      <div className="wc-local-output-unsupported" role="status">
        <HardDrive aria-hidden="true" />
        <div>
          <strong>当前浏览器不支持目录自动保存</strong>
          <span>请在 HTTPS 环境下使用最新版 Chrome 或 Edge。</span>
        </div>
      </div>
    );
  }

  if (!initialized) {
    return (
      <div className="wc-settings-loading" role="status">
        <LoaderCircle className="is-spinning" aria-hidden="true" />
        <span>正在读取本地目录</span>
      </div>
    );
  }

  return (
    <div className="wc-local-output-list">
      {(["image", "video"] as const).map((kind) => (
        <LocalOutputTarget
          key={kind}
          kind={kind}
          state={targets[kind]}
          onChoose={() => void chooseDirectory(kind)}
          onAuthorize={() => void requestDirectoryPermission(kind)}
          onToggle={(enabled) => void setEnabled(kind, enabled)}
          onRetry={() => void retryPending(kind)}
          onClear={() => void clearDirectory(kind)}
        />
      ))}
    </div>
  );
}

function LocalOutputTarget({
  kind,
  state,
  onChoose,
  onAuthorize,
  onToggle,
  onRetry,
  onClear,
}: {
  kind: LocalOutputKind;
  state: LocalOutputTargetState;
  onChoose: () => void;
  onAuthorize: () => void;
  onToggle: (enabled: boolean) => void;
  onRetry: () => void;
  onClear: () => void;
}) {
  const meta = targetMeta[kind];
  const Icon = meta.icon;
  const needsPermission = state.directoryName && state.permission !== "granted";
  const status = localOutputStatus(state);
  const isSaving = state.activity === "saving";

  return (
    <section
      className="wc-local-output-row"
      aria-label={`${meta.label}本地保存`}
      aria-busy={isSaving}
    >
      <span className="wc-local-output-icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="wc-local-output-copy">
        <strong>{meta.label}</strong>
        <span>{state.directoryName ?? meta.detail}</span>
        {status ? <small className={state.error ? "is-error" : undefined}>{status}</small> : null}
      </div>

      {state.directoryName ? (
        <label
          className="wc-settings-switch"
          title={state.enabled ? "关闭自动保存" : "开启自动保存"}
        >
          <input
            type="checkbox"
            aria-label={`${meta.label}自动保存`}
            checked={state.enabled}
            disabled={isSaving}
            onChange={(event) => onToggle(event.target.checked)}
          />
          <i aria-hidden="true" />
        </label>
      ) : null}

      <div className="wc-local-output-actions">
        {needsPermission ? (
          <button type="button" disabled={isSaving} onClick={onAuthorize}>
            重新授权
          </button>
        ) : null}
        {state.error || state.pendingCount > 0 ? (
          <button
            type="button"
            className="is-icon"
            aria-label={`重试${meta.label}自动保存`}
            title="重试"
            disabled={isSaving}
            onClick={onRetry}
          >
            <RefreshCw
              className={state.activity === "saving" ? "is-spinning" : undefined}
              aria-hidden="true"
            />
          </button>
        ) : null}
        <button
          type="button"
          className={state.directoryName ? "is-icon" : undefined}
          aria-label={`选择${meta.label}保存目录`}
          title={state.directoryName ? "更换目录" : undefined}
          disabled={isSaving}
          onClick={onChoose}
        >
          <FolderOpen aria-hidden="true" />
          {!state.directoryName ? "选择目录" : null}
        </button>
        {state.directoryName ? (
          <button
            type="button"
            className="is-icon is-danger"
            aria-label={`清除${meta.label}保存目录`}
            title="清除目录"
            disabled={isSaving}
            onClick={onClear}
          >
            <Trash2 aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </section>
  );
}

function localOutputStatus(state: LocalOutputTargetState) {
  if (state.error) return state.error;
  if (state.activity === "saving") return "正在保存";
  if (state.pendingCount > 0) return `${state.pendingCount} 个作品等待保存`;
  if (state.lastSavedName) return `已保存 ${state.lastSavedName}`;
  if (state.directoryName && state.permission === "granted")
    return state.enabled ? "自动保存已开启" : "自动保存已关闭";
  return null;
}
