import { LoaderCircle, Settings } from "lucide-react";
import { memo, type RefObject } from "react";

import { useCustomApiStore } from "../state/custom-api-store";

type TopBarSettingsProps = {
  settingsOpen: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onToggleSettings: () => void;
  onCloseSettings: () => void;
};

/**
 * 顶部"设置"键：直接点击打开设置中心（API 配置 / 模型 / 本地保存 / 协作 / 插件）。
 * 界面设置（视觉 / 交互）已拆成 dock 上的独立面板，不在这里。
 *
 * 原悬浮弹层（创作设置 / 项目协作两个图标）已下线：这两个入口如今都在设置中心里，
 * 悬浮再弹一层反而多一次操作。API 就绪状态改为按钮上的小圆点提示，信息不丢。
 *
 * 不进设置中心的项（按产品分配）：
 *   · 主题切换 / 画布快捷键 → 顶栏独立按钮；
 *   · 账号（头像+积分）→ 顶栏胶囊；项目协作 → 设置中心「协作」板块。
 */
export const TopBarSettings = memo(function TopBarSettings({
  onToggleSettings,
  onCloseSettings,
  settingsOpen,
  triggerRef,
}: TopBarSettingsProps) {
  const apiProfiles = useCustomApiStore((state) => state.profiles);
  const apiConnecting = apiProfiles.some((profile) => profile.connecting || profile.refreshing);
  const connectedApiCount = apiProfiles.filter(
    (profile) => profile.enabled && profile.availableModelIds.length > 0,
  ).length;

  return (
    <div className={`wc-topbar-settings ${settingsOpen ? "is-active" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`wc-icon-button wc-topbar-settings-trigger ${connectedApiCount ? "is-connected" : ""}`}
        aria-label={settingsOpen ? "收起设置" : "打开设置"}
        title={connectedApiCount ? `设置 · ${connectedApiCount} 个自有 API 已就绪` : "设置"}
        aria-expanded={settingsOpen}
        onClick={() => {
          if (settingsOpen) onCloseSettings();
          else onToggleSettings();
        }}
      >
        {apiConnecting ? (
          <LoaderCircle className="is-spinning" aria-hidden="true" />
        ) : (
          <Settings aria-hidden="true" />
        )}
        {connectedApiCount && !apiConnecting ? (
          <span className="wc-api-indicator" aria-hidden="true" />
        ) : null}
      </button>
    </div>
  );
});
