import { Boxes, Clock4, Coins, Keyboard, Menu, Moon, PanelsTopLeft, Sun } from "lucide-react";
import { memo, useEffect, useState, type RefObject } from "react";

import type { CanvasImportProvider } from "@weftcanvas/contracts";

import type { ThemeMode } from "../App";
import { useCanvasStore } from "../state/canvas-store";
import { useIdentityStore } from "../state/identity-store";
import {
  countClaimableMembershipTasks,
  useMembershipTaskStore,
} from "../state/membership-task-store";
import { useProjectAssetStore } from "../state/project-asset-store";
import { useProjectLibraryStore } from "../state/project-library-store";
import { useWalletStore } from "../state/wallet-store";
import { CanvasImportDialog, CanvasImportMenu } from "./third-party-canvas-import";
import { TopBarSettings } from "./top-bar-settings";

type TopBarProps = {
  theme: ThemeMode;
  onToggleTheme: () => void;
  onOpenShortcuts: () => void;
  onToggleActivity: () => void;
  settingsOpen: boolean;
  settingsTriggerRef: RefObject<HTMLButtonElement | null>;
  onToggleSettings: () => void;
  onCloseSettings: () => void;
};

/**
 * 顶栏：
 *   · 左侧 = 项目菜单 + 项目标题 + 工作资产库入口（原保存状态位）
 *   · 右侧 = 账号胶囊（积分在左、头像在右、未领徽章贴头像）
 *               + 日夜切换 + 画布快捷键（独立按钮，常驻在外）
 *               + 「设置」键（hover 弹 创作设置/项目协作，点击开设置面板）
 *
 * 功能分配（宝宝定稿）：
 *   · 设置 ≠ 界面设置：顶栏「设置」是 API / 模型 / 本地 / 协作 / 插件；
 *     界面设置（视觉 / 交互）是底部 dock 调色板键打开的独立面板；
 *   · 团队协作收进设置（下拉 + 面板功能组），不再单独占顶栏一位；
 *   · 账号不进设置下拉——头像+积分胶囊已经在外面。
 */
export const TopBar = memo(function TopBar({
  theme,
  onToggleTheme,
  onOpenShortcuts,
  onToggleActivity,
  settingsOpen,
  settingsTriggerRef,
  onToggleSettings,
  onCloseSettings,
}: TopBarProps) {
  const projectName = useCanvasStore((state) => state.projectName);
  const setProjectName = useCanvasStore((state) => state.setProjectName);
  // 保存状态不再做常驻显示，只作为 data 属性挂在资产库入口上供 e2e/调试读取。
  const saveState = useCanvasStore((state) => state.saveState);
  const assetPanelOpen = useProjectAssetStore((state) => state.open);
  const assetPendingNew = useProjectAssetStore((state) => state.pendingNew);
  const toggleAssetPanel = useProjectAssetStore((state) => state.toggle);
  const projectSidebarOpen = useProjectLibraryStore((state) => state.open);
  const toggleProjectSidebar = useProjectLibraryStore((state) => state.toggle);
  const identityStatus = useIdentityStore((state) => state.status);
  const identitySession = useIdentityStore((state) => state.session);
  const openAccount = useIdentityStore((state) => state.openDialog);
  const credits = useWalletStore((state) => state.summary?.credits ?? null);
  const membership = useWalletStore((state) => state.summary?.membership ?? null);
  const membershipTasks = useMembershipTaskStore((state) => state.data);
  const membershipTasksStatus = useMembershipTaskStore((state) => state.status);
  const requestMembershipTasks = useMembershipTaskStore((state) => state.requestOpen);
  const activeMembershipTier = membership?.active ? (membership.tier?.toLowerCase() ?? null) : null;
  const claimableTaskCount = countClaimableMembershipTasks(membershipTasks);
  const isAuthenticated = identityStatus === "authenticated";
  // 导入第三方画布：来源选择与对话框都在顶栏这一层，导入过程本身由画布 store 负责。
  const [importProvider, setImportProvider] = useState<CanvasImportProvider | null>(null);

  // 顶栏 mount 时若需要预拉取任务列表（用于角标），但不在每次渲染都打——保持轻量
  useEffect(() => {
    if (isAuthenticated && !membershipTasks && membershipTasksStatus === "idle") {
      void requestMembershipTasks();
    }
  }, [isAuthenticated, membershipTasks, membershipTasksStatus, requestMembershipTasks]);

  const avatarInitial = (identitySession?.user.displayName ?? "?").slice(0, 1).toUpperCase();
  // 会员等级颜色环——刻意避开红色系（红=报错联想，负反馈太强）：
  // pro=琥珀金（高级感） / standard=蓝 / basic=玉绿 / lite=中性素环（入门档不染色）。
  const tierRingColor =
    activeMembershipTier === "pro"
      ? "var(--wc-amber)"
      : activeMembershipTier === "standard"
        ? "var(--wc-blue)"
        : activeMembershipTier === "basic"
          ? "var(--wc-jade)"
          : activeMembershipTier === "lite"
            ? "var(--wc-border-strong)"
            : null;
  // 头像默认底色——与色环同系淡染；lite/免费档用中性底
  const avatarFallbackBg =
    activeMembershipTier === "pro"
      ? "color-mix(in srgb, var(--wc-amber) 30%, var(--wc-surface-strong))"
      : activeMembershipTier === "standard"
        ? "color-mix(in srgb, var(--wc-blue) 28%, var(--wc-surface-strong))"
        : activeMembershipTier === "basic"
          ? "color-mix(in srgb, var(--wc-jade) 28%, var(--wc-surface-strong))"
          : "color-mix(in srgb, var(--wc-surface-strong) 84%, var(--wc-canvas))";

  return (
    <header className="wc-topbar">
      <div className="wc-project-console" aria-label="纬线">
        <button
          type="button"
          className="wc-brand-mark"
          aria-label="项目菜单"
          title="项目菜单"
          aria-expanded={projectSidebarOpen}
          onClick={toggleProjectSidebar}
        >
          <Menu aria-hidden="true" />
        </button>
        <span className="wc-project-console-mark" aria-hidden="true">
          <PanelsTopLeft />
        </span>
        <div className="wc-project-heading">
          <span>纬线</span>
          <input
            className="wc-project-name"
            value={projectName}
            aria-label="项目名称"
            onChange={(event) => setProjectName(event.target.value)}
            onBlur={(event) => setProjectName(event.target.value.trim())}
          />
        </div>
        {/* data-wc-preserve-drawers：这个键自己管理开合（点击 = 切换面板），不能走面板的
            "点外关闭"——否则同一击会先被面板判成点外、再被按钮当成第二次点击。 */}
        <button
          type="button"
          data-wc-preserve-drawers
          className={`wc-workspace-assets-trigger ${assetPanelOpen ? "is-open" : ""}`}
          data-save-state={saveState}
          aria-label="工作资产库"
          title="工作资产库 · 本项目的资产都收在这里"
          aria-expanded={assetPanelOpen}
          aria-haspopup="dialog"
          onClick={toggleAssetPanel}
        >
          <Boxes aria-hidden="true" />
          <span>工作资产库</span>
          {!assetPanelOpen && assetPendingNew > 0 ? (
            <span className="wc-workspace-assets-trigger-badge" aria-hidden="true">
              {assetPendingNew > 9 ? "9+" : assetPendingNew}
            </span>
          ) : null}
        </button>
        {/* 项目级动作：导入第三方画布（LibTV / TapNow / UpDream）——选来源后弹对话框 */}
        <CanvasImportMenu onOpen={setImportProvider} />
      </div>

      <div className="wc-topbar-actions">
        {/* 日夜切换 + 画布快捷键 + 设置键：常驻在外 */}
        <button
          type="button"
          className="wc-icon-button"
          data-wc-preserve-drawers
          aria-label="切换主题"
          title={theme === "light" ? "深色模式" : "浅色模式"}
          onClick={onToggleTheme}
        >
          {theme === "light" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="wc-icon-button"
          aria-label="画布快捷键"
          title="画布快捷键 (?)"
          onClick={onOpenShortcuts}
        >
          <Keyboard aria-hidden="true" />
        </button>

        {/* 设置键：hover 弹 创作设置/项目协作；点击开设置中心（不含界面设置） */}
        <TopBarSettings
          settingsOpen={settingsOpen}
          triggerRef={settingsTriggerRef}
          onToggleSettings={onToggleSettings}
          onCloseSettings={onCloseSettings}
        />

        {/* 任务记录与积分流水：保持在外部入口（设置键右、头像左），不进任何下拉 */}
        <button
          type="button"
          className="wc-icon-button wc-activity-trigger"
          aria-label="任务记录与积分明细"
          title="任务记录与积分明细"
          onClick={onToggleActivity}
        >
          <Clock4 aria-hidden="true" />
        </button>

        {/* 账号胶囊：最里（最右）侧——积分在左、头像贴角；未领徽章贴头像右上角 */}
        {isAuthenticated ? (
          <button
            type="button"
            className={`wc-account-chip ${activeMembershipTier ? `is-member is-${activeMembershipTier}` : ""}`}
            aria-label={
              identitySession
                ? `账号：${identitySession.user.displayName}，积分 ${formatCredits(credits)}${claimableTaskCount ? `，${claimableTaskCount} 项奖励可领取` : ""}`
                : "登录画布账号"
            }
            title={
              claimableTaskCount
                ? `${claimableTaskCount} 项奖励可领取`
                : (identitySession?.user.displayName ?? "登录画布账号")
            }
            onClick={() => {
              if (claimableTaskCount) requestMembershipTasks();
              openAccount();
            }}
          >
            <span className="wc-account-chip-meta">
              <Coins aria-hidden="true" className="wc-account-chip-credits-icon" />
              <span className="wc-account-chip-credits" aria-hidden="true">
                {formatCredits(credits)}
              </span>
            </span>
            <span
              className="wc-account-chip-avatar"
              data-tier={activeMembershipTier ?? "free"}
              style={
                tierRingColor
                  ? {
                      ["--wc-account-ring" as string]: tierRingColor,
                      ["--wc-account-avatar-bg" as string]: avatarFallbackBg,
                    }
                  : undefined
              }
            >
              <span aria-hidden="true">{avatarInitial}</span>
              {claimableTaskCount ? (
                <span className="wc-account-chip-badge" aria-hidden="true">
                  {Math.min(claimableTaskCount, 99)}
                </span>
              ) : null}
            </span>
          </button>
        ) : null}
      </div>
      {importProvider ? (
        <CanvasImportDialog
          key={importProvider}
          provider={importProvider}
          onClose={() => setImportProvider(null)}
        />
      ) : null}
    </header>
  );
});

function formatCredits(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "--";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
}
