import { useState, useRef } from "react";
import {
  ArrowRight,
  CircleUserRound,
  ClipboardList,
  Coins,
  Image as ImageIcon,
  LoaderCircle,
  Moon,
  Music2,
  Settings,
  Sun,
  Video,
} from "lucide-react";

import type { ThemeMode } from "../App";
import { DIRECT_GENERATION_PROJECT_ID } from "../lib/direct-generation-history";
import {
  clearDirectDraftSession,
  clearDirectReferenceSession,
} from "../lib/direct-reference-session";
import { useCustomApiStore } from "../state/custom-api-store";
import { useDirectReferenceStore } from "../state/direct-reference-store";
import { useIdentityStore } from "../state/identity-store";
import { useWalletStore } from "../state/wallet-store";
// 生成台与画布共用同一套工作台样式，随本路由懒加载。
import "../workbench-styles.css";
import { ActivityPanel } from "./activity-panel";
import { AppearanceToolbar } from "./appearance-toolbar";
import { DirectGenerationStudio, type DirectModality } from "./direct-generation-studio";

export function DirectGenerationPage({
  modality,
  onModalityChange,
  theme,
  onToggleTheme,
}: {
  modality: DirectModality;
  onModalityChange: (modality: DirectModality) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const identitySession = useIdentityStore((state) => state.session);
  const openAccount = useIdentityStore((state) => state.openDialog);
  const apiProfiles = useCustomApiStore((state) => state.profiles);
  const walletCredits = useWalletStore((state) => state.summary?.credits ?? null);
  const requestProduct = useWalletStore((state) => state.requestProduct);
  const [activityOpen, setActivityOpen] = useState(false);
  // 工作台顶栏的设置键与画布同款：打开同一个设置中心（界面 / API 配置 / 模型 /
  // 本地保存 / 协作），首次落在 API 配置板块（本入口原来的语义）。
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const readyApiCount = apiProfiles.filter(
    (profile) => profile.enabled && profile.availableModelIds.length > 0,
  ).length;
  const apiConnecting = apiProfiles.some((profile) => profile.connecting || profile.refreshing);

  // 积分常显：余额一眼可见，点一下直达充值面板（此前充值入口太隐蔽）。
  const creditsLabel =
    walletCredits === null
      ? null
      : Number.isInteger(walletCredits)
        ? String(walletCredits)
        : walletCredits.toFixed(1).replace(/\.0$/, "");
  const openRecharge = () => {
    requestProduct("credits");
    openAccount("login");
  };

  // 离开工作台（返回首页 / 打开画布）即清除本标签页持久化的素材与草稿会话；
  // 生成类型导航留在工作台内，不清除。
  const leaveWorkbench = () => {
    clearDirectReferenceSession();
    clearDirectDraftSession();
    useDirectReferenceStore.setState({ references: { image: [], video: [], audio: [] } });
  };

  return (
    <section
      className="wc-direct-page"
      aria-label={
        modality === "image"
          ? "图片生成页面"
          : modality === "video"
            ? "视频生成页面"
            : "音频生成页面"
      }
    >
      <header className="wc-entry-nav wc-direct-page-nav" aria-label="生成页面导航">
        <a className="wc-entry-brand" href="/" aria-label="返回纬线首页" onClick={leaveWorkbench}>
          <span className="wc-entry-brand-mark">
            <img src="/weftcanvas-logo-ui.webp" alt="" aria-hidden="true" />
          </span>
          <span>
            <strong>纬线</strong>
            <small>Weftcanvas</small>
          </span>
        </a>
        <nav aria-label="生成类型导航">
          <a className={modality === "image" ? "is-active" : undefined} href="/generate/image">
            <ImageIcon aria-hidden="true" />
            图片生成
          </a>
          <a className={modality === "video" ? "is-active" : undefined} href="/generate/video">
            <Video aria-hidden="true" />
            视频生成
          </a>
          <a className={modality === "audio" ? "is-active" : undefined} href="/generate/audio">
            <Music2 aria-hidden="true" />
            音频生成
          </a>
        </nav>
        <div className="wc-entry-nav-actions">
          <button
            ref={settingsTriggerRef}
            type="button"
            className="wc-direct-page-action wc-direct-api-action wc-api-trigger"
            aria-label={settingsOpen ? "收起设置" : "打开设置"}
            aria-expanded={settingsOpen}
            title={readyApiCount ? `设置 · ${readyApiCount} 个自有 API 已就绪` : "设置"}
            onClick={() => setSettingsOpen((value) => !value)}
          >
            {apiConnecting ? (
              <LoaderCircle className="is-spinning" aria-hidden="true" />
            ) : (
              <Settings aria-hidden="true" />
            )}
            {readyApiCount && !apiConnecting ? (
              <span className="wc-api-indicator" aria-hidden="true" />
            ) : null}
          </button>
          <button
            type="button"
            className="wc-direct-page-action wc-direct-credits-action"
            aria-label={
              identitySession
                ? `积分余额 ${creditsLabel ?? "--"}，点击前往充值`
                : "登录后可充值积分"
            }
            title={
              identitySession
                ? `积分余额 ${creditsLabel ?? "--"} · 点击前往充值`
                : "登录后可充值积分"
            }
            onClick={openRecharge}
          >
            <Coins aria-hidden="true" />
            <span>{identitySession ? `${creditsLabel ?? "--"} 积分` : "积分"}</span>
          </button>
          <button
            type="button"
            className="wc-direct-page-action wc-direct-activity-action"
            aria-label="任务记录"
            title="任务记录与积分明细"
            aria-pressed={activityOpen}
            onClick={() => setActivityOpen((value) => !value)}
          >
            <ClipboardList aria-hidden="true" />
            <span>任务记录</span>
          </button>
          <button
            type="button"
            className="wc-direct-page-action wc-entry-theme-action"
            aria-label={theme === "light" ? "切换到深色模式" : "切换到浅色模式"}
            title={theme === "light" ? "深色模式" : "浅色模式"}
            onClick={onToggleTheme}
          >
            {theme === "light" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="wc-entry-account-action"
            aria-label={
              identitySession ? `账号：${identitySession.user.displayName}` : "登录画布账号"
            }
            onClick={() => openAccount("login")}
          >
            <CircleUserRound aria-hidden="true" />
            <span>{identitySession?.user.displayName ?? "登录"}</span>
          </button>
          <a
            className="wc-direct-page-action wc-entry-primary-action"
            href="/canvas"
            aria-label="打开画布"
            onClick={leaveWorkbench}
          >
            <span>打开画布</span>
            <ArrowRight aria-hidden="true" />
          </a>
        </div>
      </header>

      <main>
        <DirectGenerationStudio modality={modality} onModalityChange={onModalityChange} />
      </main>
      {activityOpen ? (
        <ActivityPanel
          projectId={DIRECT_GENERATION_PROJECT_ID}
          onClose={() => setActivityOpen(false)}
        />
      ) : null}
      <AppearanceToolbar
        open={settingsOpen}
        triggerRef={settingsTriggerRef}
        onClose={() => setSettingsOpen(false)}
        initialSection="apis"
      />
    </section>
  );
}
