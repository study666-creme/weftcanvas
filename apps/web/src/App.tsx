import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { PointerFeedback } from "./components/pointer-feedback";
import { GlobalConfirmDialog } from "./components/global-confirm-dialog";
import { GlobalTooltip } from "./components/global-tooltip";
import { SiteAnnouncements } from "./components/site-announcements";
import type { DirectModality } from "./components/direct-generation-studio";
import { ToastViewport } from "./components/toast-viewport";
import { useCollaborationDialogStore } from "./state/collaboration-dialog-store";
import { useCloudResourceStore } from "./state/cloud-resource-store";
import { useIdentityStore } from "./state/identity-store";
import { useUiPreferencesStore } from "./state/ui-preferences-store";
import { readPersistedWalletOrder } from "./lib/wallet-order-storage";
import {
  autoThemeNow,
  initialTheme,
  msUntilNextThemeFlip,
  persistTheme,
  persistThemeMode,
  readThemeMode,
  type ThemeMode,
} from "./lib/theme-schedule";

export type { ThemeMode } from "./lib/theme-schedule";
type EntryState = "idle" | "inside";
type AppRoute =
  { view: "home" } | { view: "canvas" } | { view: "generate"; modality: DirectModality };

const AccountDataController = lazy(async () => ({
  default: (await import("./components/account-data-controller")).AccountDataController,
}));
const AccountDialog = lazy(async () => ({
  default: (await import("./components/account-dialog")).AccountDialog,
}));
const AuthScreen = lazy(async () => ({
  default: (await import("./components/auth-screen")).AuthScreen,
}));
const CanvasRoute = lazy(async () => ({
  default: (await import("./components/canvas-route")).CanvasRoute,
}));
const CollaborationDialog = lazy(async () => ({
  default: (await import("./components/collaboration-dialog")).CollaborationDialog,
}));
const CloudResourceDialog = lazy(async () => ({
  default: (await import("./components/cloud-resource-dialog")).CloudResourceDialog,
}));
const CustomApiDialogHost = lazy(async () => ({
  default: (await import("./components/custom-api-dialog-host")).CustomApiDialogHost,
}));
const DirectGenerationPage = lazy(async () => ({
  default: (await import("./components/direct-generation-page")).DirectGenerationPage,
}));
const CanvasEntryLoaderLazy = lazy(async () => ({
  default: (await import("./components/canvas-entry-loader")).CanvasEntryLoader,
}));
// 首页入口整页懒加载：index.html 的启动屏先亮，入口模块与首屏渲染并行下载，
// 避免整包 entry 被入口的模型选择/参数控件依赖图拖大。
const EntryGateLazy = lazy(async () => ({
  default: (await import("./components/entry-gate")).EntryGate,
}));

function SuspenseCanvasLoader() {
  return (
    <Suspense fallback={null}>
      <CanvasEntryLoaderLazy />
    </Suspense>
  );
}

function routeFromPath(pathname = window.location.pathname): AppRoute {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { view: "home" };
  if (path === "/generate/image") return { view: "generate", modality: "image" };
  if (path === "/generate/video") return { view: "generate", modality: "video" };
  return { view: "canvas" };
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(routeFromPath);
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [entryState, setEntryState] = useState<EntryState>(() =>
    routeFromPath().view === "home" ? "idle" : "inside",
  );
  const [canvasBootVisible, setCanvasBootVisible] = useState(
    () => routeFromPath().view === "canvas",
  );
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const hydrateIdentity = useIdentityStore((state) => state.hydrate);
  const identityStatus = useIdentityStore((state) => state.status);
  const identitySession = useIdentityStore((state) => state.session);
  const identityUserId = identitySession?.user.id ?? null;
  const accountDialogOpen = useIdentityStore((state) => state.dialogOpen);
  const collaborationDialogOpen = useCollaborationDialogStore((state) => state.open);
  const cloudResourceDialogOpen = useCloudResourceStore((state) => state.open);
  const [accountDialogLoaded, setAccountDialogLoaded] = useState(
    () => accountDialogOpen || readPersistedWalletOrder() !== null,
  );
  const colorScheme = useUiPreferencesStore((state) => state.colorScheme);
  const canvasVisualStyle = useUiPreferencesStore((state) => state.canvasVisualStyle);
  const chromeVisualStyle = useUiPreferencesStore((state) => state.chromeVisualStyle);
  const generationEffectStyle = useUiPreferencesStore((state) => state.generationEffectStyle);
  const cursorStyle = useUiPreferencesStore((state) => state.cursorStyle);
  const edgePathStyle = useUiPreferencesStore((state) => state.edgePathStyle);
  const edgeFlowStyle = useUiPreferencesStore((state) => state.edgeFlowStyle);
  const routeRef = useRef(route);
  routeRef.current = route;

  useLayoutEffect(() => {
    // 配色方案独立于节点/界面样式：它只换令牌取值，不换几何与间距。
    document.documentElement.dataset.colorScheme = colorScheme;
    document.documentElement.dataset.nodeStyle = canvasVisualStyle;
    // Compatibility marker for older extensions and browser checks. Styling
    // reads only data-node-style / data-chrome-style.
    document.documentElement.dataset.canvasStyle = canvasVisualStyle;
    document.documentElement.dataset.chromeStyle = chromeVisualStyle;
    document.documentElement.dataset.generationEffect = generationEffectStyle;
    document.documentElement.dataset.cursorStyle = cursorStyle;
    document.documentElement.dataset.edgePathStyle = edgePathStyle;
    document.documentElement.dataset.edgeFlowStyle = edgeFlowStyle;
  }, [
    canvasVisualStyle,
    chromeVisualStyle,
    colorScheme,
    cursorStyle,
    edgeFlowStyle,
    edgePathStyle,
    generationEffectStyle,
  ]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    persistTheme(theme);
  }, [theme]);

  // 主题切换统一入口：整页换色走 View Transition 交叉淡化，避免生硬闪眼。
  // flushSync 让 React 提交（.wc-app 的 data-theme 等）发生在过渡回调内，
  // 新快照拿到的才是换色后的 DOM；不支持或用户要求减少动效时直接切换。
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const applyTheme = useCallback((next: ThemeMode) => {
    persistTheme(next);
    const commit = () => {
      document.documentElement.dataset.theme = next;
      flushSync(() => setTheme(next));
    };
    const doc = document as Document & { startViewTransition?: (callback: () => void) => unknown };
    if (
      doc.startViewTransition &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      doc.startViewTransition(commit);
    } else {
      commit();
    }
  }, []);

  useEffect(() => {
    void hydrateIdentity();
  }, [hydrateIdentity]);

  // 自动日夜：auto 模式按日程（08:00 白天 / 19:00 黑夜）跟随；manual 模式
  // 完全粘住——用户显式选择的主题不被任何轮询/唤醒覆盖（修复：此前
  // visibilitychange 会在翻段前就把手选值强制打回日程值并重置为 auto，
  // 首屏选了浅色一进工作台又变黑夜）。定时器仅用于 auto 模式的翻段校正。
  useEffect(() => {
    let timer = 0;
    const sync = () => {
      if (readThemeMode() === "auto") {
        const scheduled = autoThemeNow();
        if (scheduled !== themeRef.current) applyTheme(scheduled);
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(sync, msUntilNextThemeFlip());
    };
    timer = window.setTimeout(sync, msUntilNextThemeFlip());
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [applyTheme]);

  // 手动切换写入偏好并标记为手动模式： sticky，直到用户再次切换。
  // auto（默认，从未手选过）继续按日程自动日夜。
  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    persistThemeMode("manual");
    applyTheme(next);
  };

  useEffect(() => {
    if (accountDialogOpen) setAccountDialogLoaded(true);
  }, [accountDialogOpen]);

  // 首屏流畅度优先：index.html 的引导脚本已无条件把 data-wc-motion="lite" 打在
  // <html> 上（静态英雄层、无星空/光晕/毛玻璃动画）。此前的运行时帧率采样只在
  // 首屏已经卡过 1.2 秒之后才降级，对弱机等于「先卡够再救」，已移除；弱动效
  // 现在是所有设备的默认，不做强机回升。

  useEffect(() => {
    const syncPath = () => {
      const nextRoute = routeFromPath();
      const previousRoute = routeRef.current;
      routeRef.current = nextRoute;
      setRoute(nextRoute);
      setEntryState(nextRoute.view === "home" ? "idle" : "inside");
      setCanvasBootVisible(nextRoute.view === "canvas");
      if (previousRoute.view === "generate") setWorkspaceReady(false);
    };
    window.addEventListener("popstate", syncPath);
    return () => window.removeEventListener("popstate", syncPath);
  }, []);

  const handleCanvasReady = useCallback(() => {
    setWorkspaceReady(true);
  }, []);

  const finishCanvasBoot = useCallback(() => {
    setCanvasBootVisible(false);
  }, []);

  // 画布不再要求先登录：匿名访客走本地项目 + BYOK 直连（lib/canvas-api-access.ts
  // 的 local 分支），云端资产、云项目、钱包等能力各自在用到时再打开账号层。
  const enterCanvas = () => {
    if (routeRef.current.view !== "home" || entryState !== "idle") return;
    window.history.replaceState(null, "", "/canvas");
    setWorkspaceReady(false);
    setRoute({ view: "canvas" });
    setEntryState("inside");
    setCanvasBootVisible(true);
  };

  const enterCanvasRef = useRef(enterCanvas);
  enterCanvasRef.current = enterCanvas;

  // 首屏固定先进登录层：未认证访客落到首页即弹出登录（等 hydration 完成再判定，
  // 不会误伤正在恢复会话的已登录用户）。「稍后再说」仍可浏览首页，但进画布会再拦；
  // 账号服务不可用（unavailable）时不弹——没有可登录的入口，画布同样保持封锁。
  // 登录即首屏模式（默认）下不弹层：登录页由下方 showLoginFirst 直接整页渲染，
  // 仅 ?view=landing 预览旧首屏时保留弹层行为。
  const forceLanding = new URLSearchParams(window.location.search).get("view") === "landing";
  const autoAuthShownRef = useRef(false);
  useEffect(() => {
    if (!forceLanding) return;
    if (autoAuthShownRef.current) return;
    if (route.view !== "home" || entryState !== "idle") return;
    if (identityStatus !== "anonymous") return;
    autoAuthShownRef.current = true;
    useIdentityStore.getState().openDialog("login");
  }, [identityStatus, route, entryState, forceLanding]);

  // 游客通道：本会话内免登录进入首屏落地页（sessionStorage 记忆，刷新不丢）。
  const [guestEntered, setGuestEntered] = useState(
    () => window.sessionStorage.getItem("weftcanvas:entry-guest:v1") === "1",
  );
  const enterAsGuest = () => {
    window.sessionStorage.setItem("weftcanvas:entry-guest:v1", "1");
    setGuestEntered(true);
  };

  // 首屏登录页：未认证（或账号服务不可用）时首页整页渲染登录面板——保留影片
  // 背景与版式，表单为主入口，下方提供与登录同权重的「游客访问」按钮（免登录进首屏）。
  // hydration 进行中显示轻量加载态；已认证则直接进入画布。
  const showLoginFirst =
    route.view === "home" &&
    entryState !== "inside" &&
    !forceLanding &&
    !guestEntered &&
    (identityStatus === "anonymous" || identityStatus === "unavailable");
  const homeAuthLoading =
    route.view === "home" &&
    entryState !== "inside" &&
    !forceLanding &&
    (identityStatus === "idle" || identityStatus === "loading");

  // 登录成功 → 自动进入画布，但仅限"刚从登录页走过来"的这一次；
  // 已登录用户访问 / 停在首页（项目库侧栏的「首页」链接因此能真正回首页，
  // 否则会被这里立刻弹回画布，永远回不了家）。?view=landing 预览同理不跳。
  const loginFirstShownRef = useRef(false);
  useEffect(() => {
    if (showLoginFirst) {
      loginFirstShownRef.current = true;
      return;
    }
    if (identityStatus !== "authenticated") {
      loginFirstShownRef.current = false;
      return;
    }
    if (!loginFirstShownRef.current) return;
    loginFirstShownRef.current = false;
    window.setTimeout(() => enterCanvasRef.current(), 250);
  }, [identityStatus, showLoginFirst]);

  // /generate/* 工作台对游客开放（与画布一致）：目录缺失时由演示目录兜底，
  // 未配置 API / 未登录时提交会被 studio 诚实拦截并指向设置，不再弹回登录。

  // 未认证直达 /canvas 不再弹回首页：画布对匿名访客开放（本地项目 + BYOK）。

  const changeDirectModality = (modality: DirectModality) => {
    const path = `/generate/${modality}`;
    if (window.location.pathname !== path) window.history.replaceState(null, "", path);
    setRoute({ view: "generate", modality });
  };

  if (route.view === "generate") {
    return (
      <div
        className="wc-app wc-app--direct-generation"
        data-theme={theme}
        data-canvas-style={canvasVisualStyle}
        data-node-style={canvasVisualStyle}
        data-chrome-style={chromeVisualStyle}
        data-generation-effect={generationEffectStyle}
        data-edge-path-style={edgePathStyle}
        data-edge-flow-style={edgeFlowStyle}
      >
        <PointerFeedback />
        <Suspense fallback={null}>
          <AccountDataController />
        </Suspense>
        <Suspense fallback={<RouteLoadingState label="正在打开生成工作区" />}>
          <DirectGenerationPage
            modality={route.modality}
            onModalityChange={changeDirectModality}
            theme={theme}
            onToggleTheme={toggleTheme}
          />
        </Suspense>
        {accountDialogOpen && !identitySession ? (
          <Suspense fallback={null}>
            <AuthScreen />
          </Suspense>
        ) : accountDialogLoaded || accountDialogOpen ? (
          <Suspense fallback={<DialogLoadingState />}>
            <AccountDialog />
          </Suspense>
        ) : null}
        <Suspense fallback={null}>
          <CustomApiDialogHost />
        </Suspense>
        <GlobalConfirmDialog />
        <GlobalTooltip />
        <SiteAnnouncements />
        <ToastViewport />
      </div>
    );
  }

  return (
    <div
      className={`wc-app wc-app--entry-${entryState} ${canvasBootVisible ? "wc-app--canvas-loading" : ""}`}
      data-theme={theme}
      data-canvas-style={canvasVisualStyle}
      data-node-style={canvasVisualStyle}
      data-chrome-style={chromeVisualStyle}
      data-generation-effect={generationEffectStyle}
      data-edge-path-style={edgePathStyle}
      data-edge-flow-style={edgeFlowStyle}
    >
      {route.view === "canvas" ? (
        <Suspense fallback={<SuspenseCanvasLoader />}>
          <CanvasRoute
            theme={theme}
            identityStatus={identityStatus}
            identityUserId={identityUserId}
            booting={canvasBootVisible}
            workspaceReady={workspaceReady}
            onToggleTheme={toggleTheme}
            onWorkspaceReady={handleCanvasReady}
            onBootFinished={finishCanvasBoot}
          />
        </Suspense>
      ) : null}
      {route.view === "home" ? <PointerFeedback /> : null}
      {/* 首屏/登录页不再挂自绘光标：它隐藏系统光标并用 DOM 逐帧跟随，主线程
          一忙就「鼠标发黏」。这里回归原生光标（硬件合成零延迟）；画布工作区若
          挂载它，由各自路由自行决定。 */}
      {route.view === "canvas" || accountDialogOpen ? (
        <Suspense fallback={null}>
          <AccountDataController />
        </Suspense>
      ) : null}
      {route.view === "home" && entryState !== "inside" ? (
        showLoginFirst ? (
          <Suspense fallback={<RouteLoadingState label="正在打开登录页" />}>
            <AuthScreen mandatory onStart={enterCanvas} onGuest={enterAsGuest} />
          </Suspense>
        ) : homeAuthLoading ? (
          <RouteLoadingState label="正在校验登录状态" />
        ) : (
          <Suspense fallback={null}>
            <EntryGateLazy onEnter={enterCanvas} theme={theme} onToggleTheme={toggleTheme} />
          </Suspense>
        )
      ) : null}
      {accountDialogOpen && !identitySession && !showLoginFirst ? (
        <Suspense fallback={null}>
          <AuthScreen />
        </Suspense>
      ) : accountDialogLoaded || accountDialogOpen ? (
        <Suspense fallback={<DialogLoadingState />}>
          <AccountDialog />
        </Suspense>
      ) : null}
      {collaborationDialogOpen ? (
        <Suspense fallback={<DialogLoadingState />}>
          <CollaborationDialog />
        </Suspense>
      ) : null}
      {cloudResourceDialogOpen ? (
        <Suspense fallback={<DialogLoadingState />}>
          <CloudResourceDialog />
        </Suspense>
      ) : null}
      <GlobalConfirmDialog />
      <GlobalTooltip />
      <SiteAnnouncements />
      <ToastViewport />
    </div>
  );
}

function DialogLoadingState() {
  return (
    <div className="wc-lazy-dialog-backdrop" role="status" aria-label="正在打开">
      <span />
    </div>
  );
}

function RouteLoadingState({ label, canvasBoot = false }: { label: string; canvasBoot?: boolean }) {
  return (
    <main
      className={`wc-route-loading ${canvasBoot ? "wc-canvas-entry-loader" : ""}`}
      role="status"
      aria-label={label}
    >
      <span />
      <small>{label}</small>
    </main>
  );
}
