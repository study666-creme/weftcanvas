import type { CustomApiFormat, ModelModality, PublicModel } from "@weftcanvas/contracts";
import {
  Check,
  CircleCheck,
  CircleDashed,
  CircleOff,
  Eye,
  EyeOff,
  ExternalLink,
  FolderDown,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  Music2,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  Trash2,
  TriangleAlert,
  Type,
  Video,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
// BYOK 面板样式（模型源列表等）随对话框加载，登录首屏不下载。
import "../appearance-panel.css";

import {
  DEFAULT_CUSTOM_API_BASE_URL,
  DEFAULT_CUSTOM_API_FORMAT,
  GEMINI_CUSTOM_API_BASE_URL,
  WEFTCANVAS_API_SITE_URL,
  customModelKey,
  normalizeCustomApiFormat,
  probeCustomApiResponse,
  sendCustomApiTestRequest,
  type CustomApiAuthStyle,
  type CustomApiProtocolOverride,
  type CustomApiProtocolProbe,
  type CustomApiRequestContentType,
} from "../lib/custom-api";
import {
  canvasApiAccessLabel,
  resolveCanvasApiAccess,
  type CanvasApiAccess,
} from "../lib/canvas-api-access";
import { isRecognizedModel, modelSupportsModality } from "../lib/custom-model-knowledge";
import {
  useCustomApiStore,
  type CustomApiProfile,
  type CustomApiSyncDiff,
} from "../state/custom-api-store";
import { useGenerationStore } from "../state/generation-store";
import { useIdentityStore } from "../state/identity-store";
import { useWalletStore } from "../state/wallet-store";
import { LocalOutputSettings } from "./local-output-settings";

export type SettingsTab = "apis" | "models" | "local";

const tabs: Array<{ id: SettingsTab; label: string; icon: typeof KeyRound }> = [
  { id: "apis", label: "API 配置", icon: Server },
  { id: "models", label: "模型", icon: Settings2 },
  { id: "local", label: "本地保存", icon: FolderDown },
];

const modalities: Array<{ id: ModelModality; label: string; icon: typeof ImageIcon }> = [
  { id: "image", label: "图片", icon: ImageIcon },
  { id: "video", label: "视频", icon: Video },
  { id: "text", label: "文本", icon: Type },
  { id: "audio", label: "音频", icon: Music2 },
];

export function CustomApiDialog() {
  const open = useCustomApiStore((state) => state.dialogOpen);
  const close = useCustomApiStore((state) => state.closeDialog);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("keydown", closeOnEscape, true);
      previousFocus?.focus();
    };
  }, [close, open]);

  if (!open) return null;

  return createPortal(
    <div
      className="wc-custom-api-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wc-creation-settings-title"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="wc-custom-api-dialog"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <CustomApiPanel onComplete={close} />
      </section>
    </div>,
    document.body,
  );
}

/**
 * 创作设置面板内容（header + 分类 tabs + 内容 + 完成键）。
 * 两种形态：
 *   · 独立弹窗（CustomApiDialog）：不传 section，自带 header / 分类 tabs / 完成键。
 *   · 嵌入设置中心（appearance-toolbar）：传 section（API 配置 / 模型 / 本地保存
 *     作为设置中心的一级板块），只渲染对应板块内容，不再单开「创作」子分类。
 */
export function CustomApiPanel({
  onComplete,
  section,
}: {
  onComplete?: () => void;
  section?: SettingsTab;
}) {
  const profiles = useCustomApiStore((state) => state.profiles);
  const activeProfileId = useCustomApiStore((state) => state.activeProfileId);
  const hiddenModelKeys = useCustomApiStore((state) => state.hiddenModelKeys);
  const addProfile = useCustomApiStore((state) => state.addProfile);
  const updateProfile = useCustomApiStore((state) => state.updateProfile);
  const removeProfile = useCustomApiStore((state) => state.removeProfile);
  const setActiveProfile = useCustomApiStore((state) => state.setActiveProfile);
  const pullProfileModels = useCustomApiStore((state) => state.pullProfileModels);
  const pullAllProfiles = useCustomApiStore((state) => state.pullAllProfiles);
  const assignProfileModelModality = useCustomApiStore((state) => state.assignProfileModelModality);
  const setModelVisible = useCustomApiStore((state) => state.setModelVisible);
  const catalogs = useGenerationStore((state) => state.catalogs);
  const loadCatalog = useGenerationStore((state) => state.loadCatalog);
  const identityStatus = useIdentityStore((state) => state.status);
  const walletSummary = useWalletStore((state) => state.summary);
  const [tab, setTab] = useState<SettingsTab>("apis");
  const activeTab = section ?? tab;
  const embedded = section !== undefined;
  const [modality, setModality] = useState<ModelModality>("image");
  const [search, setSearch] = useState("");
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() => new Set());
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  const tabsRef = useRef<HTMLElement>(null);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;
  const busy = profiles.some((profile) => profile.connecting || profile.refreshing);
  const configuredCount = profiles.filter(
    (profile) =>
      profile.enabled && profile.connection.apiKey.trim() && profile.availableModelIds.length,
  ).length;
  const canvasApiAccess = resolveCanvasApiAccess({
    authenticated: identityStatus === "authenticated",
    membership: walletSummary?.membership ?? null,
  });

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      tabsRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (activeTab !== "models") return;
    void loadCatalog(modality);
  }, [activeTab, loadCatalog, modality]);

  const addConfiguration = () => {
    addProfile({
      name: `API 配置 ${profiles.length + 1}`,
      baseUrl: DEFAULT_CUSTOM_API_BASE_URL,
      apiKey: "",
      apiFormat: DEFAULT_CUSTOM_API_FORMAT,
    });
    setTab("apis");
  };

  const removeConfiguration = (profileId: string) => {
    removeProfile(profileId);
    setPendingRemovalId(null);
  };

  return (
    <>
      {!embedded ? (
        <header className="wc-creation-panel-header">
          <span className="wc-custom-api-mark">
            <Settings2 aria-hidden="true" />
          </span>
          <div className="wc-custom-api-heading">
            <strong id="wc-creation-settings-title">创作设置</strong>
            <small>
              {profiles.length
                ? `${configuredCount}/${profiles.length} 个 API 已就绪`
                : "未添加 API 配置"}
            </small>
          </div>
          {onComplete ? (
            <button
              type="button"
              className="wc-dialog-close"
              aria-label="关闭"
              title="关闭"
              onClick={onComplete}
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </header>
      ) : null}

      {!embedded ? (
        <nav ref={tabsRef} className="wc-settings-tabs" role="tablist" aria-label="设置分类">
          {tabs.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={activeTab === item.id}
                className={activeTab === item.id ? "is-active" : undefined}
                onClick={() => setTab(item.id)}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      ) : null}

      <div className="wc-settings-content" role="tabpanel">
        {activeTab === "apis" ? (
          <ApiSettings
            profiles={profiles}
            activeProfile={activeProfile}
            apiAccess={canvasApiAccess}
            visibleKeys={visibleKeys}
            pendingRemovalId={pendingRemovalId}
            onSelect={(id) => {
              setActiveProfile(id);
              setPendingRemovalId(null);
            }}
            onAdd={addConfiguration}
            onUpdate={updateProfile}
            onRemove={removeConfiguration}
            onRequestRemove={setPendingRemovalId}
            onCancelRemove={() => setPendingRemovalId(null)}
            onPull={(profileId) => void pullProfileModels(profileId, true)}
            onToggleKey={(profileId) =>
              setVisibleKeys((current) => {
                const next = new Set(current);
                if (next.has(profileId)) next.delete(profileId);
                else next.add(profileId);
                return next;
              })
            }
          />
        ) : null}

        {activeTab === "models" ? (
          <ModelSettings
            modality={modality}
            search={search}
            profiles={profiles}
            platformModels={catalogs[modality].data?.models ?? []}
            platformLoading={catalogs[modality].status === "loading"}
            hiddenModelKeys={hiddenModelKeys}
            busy={busy}
            apiAccess={canvasApiAccess}
            onModalityChange={(next) => {
              setModality(next);
              setSearch("");
            }}
            onSearch={setSearch}
            onPullAll={() => void pullAllProfiles(true)}
            onSetVisible={setModelVisible}
            onAssign={assignProfileModelModality}
          />
        ) : null}

        {activeTab === "local" ? <LocalOutputSettings /> : null}
      </div>

      {embedded && section === "apis" ? (
        <footer className="wc-creation-embed-foot">
          <span>API Key 仅保存在当前浏览器</span>
          <small
            className="wc-custom-api-entitlement"
            title={canvasApiAccessLabel(canvasApiAccess)}
          >
            {canvasApiAccessLabel(canvasApiAccess)}
          </small>
        </footer>
      ) : null}

      {onComplete ? (
        <footer>
          <span>{tab === "apis" ? "API Key 仅保存在当前浏览器" : ""}</span>
          {tab === "apis" ? (
            <small
              className="wc-custom-api-entitlement"
              title={canvasApiAccessLabel(canvasApiAccess)}
            >
              {canvasApiAccessLabel(canvasApiAccess)}
            </small>
          ) : null}
          <button type="button" className="wc-custom-api-connect" onClick={onComplete}>
            <Check aria-hidden="true" />
            完成
          </button>
        </footer>
      ) : null}
    </>
  );
}

function ApiSettings({
  profiles,
  activeProfile,
  apiAccess,
  visibleKeys,
  pendingRemovalId,
  onSelect,
  onAdd,
  onUpdate,
  onRemove,
  onRequestRemove,
  onCancelRemove,
  onPull,
  onToggleKey,
}: {
  profiles: CustomApiProfile[];
  activeProfile: CustomApiProfile | null;
  apiAccess: Pick<CanvasApiAccess, "allowed">;
  visibleKeys: Set<string>;
  pendingRemovalId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onUpdate: (
    id: string,
    patch: {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      apiFormat?: CustomApiFormat;
      enabled?: boolean;
      protocol?: CustomApiProtocolOverride;
    },
  ) => void;
  onRemove: (id: string) => void;
  onRequestRemove: (id: string) => void;
  onCancelRemove: () => void;
  onPull: (id: string) => void;
  onToggleKey: (id: string) => void;
}) {
  const activeStatus = activeProfile ? profileStatus(activeProfile) : null;
  const ActiveStatusIcon = activeStatus?.icon ?? CircleDashed;

  return (
    <div className="wc-api-settings-layout">
      <aside className="wc-api-profile-sidebar">
        <div className="wc-api-profile-sidebar-head">
          <span>
            <strong>API 接口</strong>
            <small>{profiles.length} 个配置</small>
          </span>
          <button
            type="button"
            aria-label="添加 API 配置"
            title="添加配置"
            onClick={onAdd}
            disabled={!apiAccess.allowed}
          >
            <Plus aria-hidden="true" />
          </button>
        </div>
        <div className="wc-api-profile-list">
          {profiles.map((profile) => {
            const status = profileStatus(profile);
            return (
              <button
                key={profile.id}
                type="button"
                className={`${profile.id === activeProfile?.id ? "is-active" : ""} ${!profile.enabled ? "is-disabled" : ""}`}
                aria-label={`${profile.name}，${status.label}`}
                onClick={() => onSelect(profile.id)}
              >
                <i className={`is-${status.tone}`} aria-hidden="true" />
                <span>
                  <strong>{profile.name}</strong>
                  <small>{status.label}</small>
                </span>
                {profile.connecting || profile.refreshing ? (
                  <LoaderCircle className="is-spinning" aria-hidden="true" />
                ) : null}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="wc-api-profile-add"
          onClick={onAdd}
          disabled={!apiAccess.allowed}
        >
          <Plus aria-hidden="true" />
          添加配置
        </button>
      </aside>

      {activeProfile ? (
        <form
          className="wc-api-profile-editor"
          onSubmit={(event) => {
            event.preventDefault();
            onPull(activeProfile.id);
          }}
        >
          <div className="wc-api-profile-editor-head">
            <div className="wc-api-profile-identity">
              <span className="wc-api-profile-icon" aria-hidden="true">
                <Server />
              </span>
              <div>
                <strong>{activeProfile.name}</strong>
                <span>{activeProfile.connection.baseUrl || "未设置服务地址"}</span>
              </div>
            </div>
            <div className="wc-api-profile-editor-controls">
              <span
                className={`wc-api-profile-state is-${activeStatus?.tone ?? "idle"}`}
                aria-live="polite"
              >
                <ActiveStatusIcon aria-hidden="true" />
                <span>{activeStatus?.label}</span>
              </span>
              <label className="wc-api-profile-enable">
                <span>{activeProfile.enabled ? "已启用" : "已停用"}</span>
                <span className="wc-settings-switch">
                  <input
                    type="checkbox"
                    aria-label="启用此 API 配置"
                    checked={activeProfile.enabled}
                    onChange={(event) =>
                      onUpdate(activeProfile.id, { enabled: event.target.checked })
                    }
                  />
                  <i aria-hidden="true" />
                </span>
              </label>
              <span className="wc-api-delete-control">
                <button
                  type="button"
                  className="wc-api-icon-button is-danger"
                  aria-label="删除当前 API 配置"
                  title="删除配置"
                  onClick={() => onRequestRemove(activeProfile.id)}
                >
                  <Trash2 aria-hidden="true" />
                </button>
                {pendingRemovalId === activeProfile.id ? (
                  <span
                    className="wc-api-delete-popover"
                    role="alertdialog"
                    aria-label="确认删除 API 配置"
                  >
                    <span>
                      <strong>删除这个配置？</strong>
                      <small>密钥和模型映射会一并移除</small>
                    </span>
                    <span>
                      <button type="button" onClick={onCancelRemove}>
                        取消
                      </button>
                      <button
                        type="button"
                        className="is-danger"
                        onClick={() => onRemove(activeProfile.id)}
                      >
                        删除
                      </button>
                    </span>
                  </span>
                ) : null}
              </span>
            </div>
          </div>

          <div className="wc-api-profile-editor-body">
            <div className="wc-api-section-heading">
              <strong>连接信息</strong>
              <span>浏览器本地配置</span>
            </div>
            {activeProfile.lastSyncDiff ? (
              <p className="wc-api-sync-diff" role="status">
                <RefreshCw aria-hidden="true" />
                {syncDiffText(activeProfile.lastSyncDiff)}
              </p>
            ) : null}
            <div className="wc-custom-api-fields">
              <div className="wc-custom-api-field wc-custom-api-field--name">
                <label htmlFor={`wc-api-name-${activeProfile.id}`}>配置名称</label>
                <input
                  id={`wc-api-name-${activeProfile.id}`}
                  type="text"
                  value={activeProfile.name}
                  maxLength={48}
                  autoComplete="off"
                  onChange={(event) => onUpdate(activeProfile.id, { name: event.target.value })}
                />
              </div>
              <div className="wc-custom-api-field wc-custom-api-field--protocol">
                <span
                  className="wc-custom-api-field-label"
                  id={`wc-api-protocol-label-${activeProfile.id}`}
                >
                  调用协议
                </span>
                <div
                  className="wc-api-protocol-choice"
                  role="radiogroup"
                  aria-labelledby={`wc-api-protocol-label-${activeProfile.id}`}
                >
                  {(["openai", "gemini"] as CustomApiFormat[]).map((format) => {
                    const current = activeProfile.connection.apiFormat ?? DEFAULT_CUSTOM_API_FORMAT;
                    const selected = current === format;
                    return (
                      <button
                        key={format}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={selected ? "is-active" : undefined}
                        onClick={() => {
                          if (selected) return;
                          const currentBaseUrl = activeProfile.connection.baseUrl.trim();
                          const openAiDefault = DEFAULT_CUSTOM_API_BASE_URL.replace(/\/+$/, "");
                          const geminiDefault = GEMINI_CUSTOM_API_BASE_URL.replace(/\/+$/, "");
                          const shouldUpdateBaseUrl =
                            currentBaseUrl === openAiDefault || currentBaseUrl === geminiDefault;
                          onUpdate(activeProfile.id, {
                            apiFormat: format,
                            ...(shouldUpdateBaseUrl
                              ? {
                                  baseUrl:
                                    format === "gemini"
                                      ? GEMINI_CUSTOM_API_BASE_URL
                                      : DEFAULT_CUSTOM_API_BASE_URL,
                                }
                              : {}),
                          });
                        }}
                      >
                        <span className="wc-api-protocol-name">
                          {format === "openai" ? "OpenAI 兼容" : "Gemini 原生"}
                        </span>
                        <i aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="wc-custom-api-field wc-custom-api-field--url">
                <label htmlFor={`wc-api-url-${activeProfile.id}`}>服务地址</label>
                <input
                  id={`wc-api-url-${activeProfile.id}`}
                  type="url"
                  value={activeProfile.connection.baseUrl}
                  placeholder={DEFAULT_CUSTOM_API_BASE_URL}
                  autoComplete="url"
                  spellCheck={false}
                  required
                  onChange={(event) => onUpdate(activeProfile.id, { baseUrl: event.target.value })}
                />
              </div>
              <div className="wc-custom-api-field wc-custom-api-field--key">
                <label htmlFor={`wc-api-key-${activeProfile.id}`}>API Key</label>
                <span className="wc-custom-api-secret">
                  <input
                    id={`wc-api-key-${activeProfile.id}`}
                    type={visibleKeys.has(activeProfile.id) ? "text" : "password"}
                    value={activeProfile.connection.apiKey}
                    placeholder="sk-..."
                    autoComplete="off"
                    spellCheck={false}
                    required
                    onChange={(event) => onUpdate(activeProfile.id, { apiKey: event.target.value })}
                  />
                  <button
                    type="button"
                    aria-label={visibleKeys.has(activeProfile.id) ? "隐藏 API Key" : "显示 API Key"}
                    title={visibleKeys.has(activeProfile.id) ? "隐藏" : "显示"}
                    onClick={() => onToggleKey(activeProfile.id)}
                  >
                    {visibleKeys.has(activeProfile.id) ? (
                      <EyeOff aria-hidden="true" />
                    ) : (
                      <Eye aria-hidden="true" />
                    )}
                  </button>
                </span>
              </div>
            </div>

            <AdvancedProtocolFields profile={activeProfile} onCommit={onUpdate} />

            {activeProfile.error ? (
              <div className="wc-custom-api-error" role="alert">
                {activeProfile.error}
              </div>
            ) : null}
            {activeProfile.catalog?.catalogWarning ? (
              <div className="wc-custom-api-warning" role="status">
                {activeProfile.catalog.catalogWarning}
              </div>
            ) : null}
          </div>

          <div className="wc-api-profile-editor-actions">
            {WEFTCANVAS_API_SITE_URL ? (
              <a href={WEFTCANVAS_API_SITE_URL} target="_blank" rel="noopener noreferrer">
                纬线 API
                <ExternalLink aria-hidden="true" />
              </a>
            ) : null}
            <button
              type="submit"
              className="wc-custom-api-connect"
              disabled={
                !apiAccess.allowed ||
                !activeProfile.enabled ||
                activeProfile.connecting ||
                activeProfile.refreshing ||
                !activeProfile.connection.baseUrl.trim() ||
                !activeProfile.connection.apiKey.trim()
              }
            >
              {!activeProfile.enabled ? (
                <CircleOff aria-hidden="true" />
              ) : activeProfile.connecting || activeProfile.refreshing ? (
                <LoaderCircle className="is-spinning" aria-hidden="true" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              {!activeProfile.enabled
                ? "配置已停用"
                : activeProfile.availableModelIds.length
                  ? "重新拉取"
                  : "拉取模型"}
            </button>
          </div>
        </form>
      ) : (
        <div className="wc-api-empty">
          <Server aria-hidden="true" />
          <strong>还没有 API 配置</strong>
          <button type="button" onClick={onAdd} disabled={!apiAccess.allowed}>
            <Plus aria-hidden="true" />
            添加配置
          </button>
        </div>
      )}
    </div>
  );
}

function ModelSettings({
  modality,
  search,
  profiles,
  platformModels,
  platformLoading,
  hiddenModelKeys,
  busy,
  apiAccess,
  onModalityChange,
  onSearch,
  onPullAll,
  onSetVisible,
  onAssign,
}: {
  modality: ModelModality;
  search: string;
  profiles: CustomApiProfile[];
  platformModels: PublicModel[];
  platformLoading: boolean;
  hiddenModelKeys: string[];
  busy: boolean;
  apiAccess: Pick<CanvasApiAccess, "allowed">;
  onModalityChange: (modality: ModelModality) => void;
  onSearch: (value: string) => void;
  onPullAll: () => void;
  onSetVisible: (key: string, visible: boolean) => void;
  onAssign: (
    profileId: string,
    rawModelId: string,
    modality: ModelModality,
    enabled: boolean,
  ) => void;
}) {
  const hidden = useMemo(() => new Set(hiddenModelKeys), [hiddenModelKeys]);
  const query = search.trim().toLocaleLowerCase();
  const builtins = platformModels.filter((model) =>
    matchesSearch(`${model.label} ${model.id}`, query),
  );
  const availableCustomCount = profiles.reduce(
    (count, profile) => count + profile.availableModelIds.length,
    0,
  );

  return (
    <div className="wc-model-settings">
      <div className="wc-model-settings-toolbar">
        <div className="wc-model-modality-tabs" role="tablist" aria-label="模型类型">
          {modalities.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={modality === item.id}
                className={modality === item.id ? "is-active" : undefined}
                onClick={() => onModalityChange(item.id)}
              >
                <Icon aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </div>
        <div className="wc-model-settings-tools">
          <label className="wc-model-search">
            <Search aria-hidden="true" />
            <input
              aria-label="搜索模型"
              value={search}
              placeholder="搜索模型"
              onChange={(event) => onSearch(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="is-icon"
            aria-label="拉取全部 API 模型"
            title="拉取全部"
            disabled={!apiAccess.allowed || busy || profiles.length === 0}
            onClick={onPullAll}
          >
            <RefreshCw className={busy ? "is-spinning" : undefined} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="wc-model-source-list">
        <ModelSourceSection
          title="内置模型"
          detail={`${platformModels.length} 个`}
          models={builtins.map((model) => ({
            key: model.id,
            label: model.label,
            detail: model.id,
            checked: !hidden.has(model.id),
          }))}
          loading={platformLoading}
          empty="暂无内置模型"
          onToggle={(key, checked) => onSetVisible(key, checked)}
          onToggleAll={(checked) => builtins.forEach((model) => onSetVisible(model.id, checked))}
        />

        {profiles.map((profile) => {
          const rows = profile.availableModelIds
            .filter((rawId) => matchesSearch(rawId, query))
            .map((rawId) => {
              const key = customModelKey(profile.id, modality, rawId);
              const recognized = isRecognizedModel(rawId);
              return {
                key,
                rawId,
                label: richModelLabel(profile, rawId, modality),
                // 未识别的 id 明确标出来，用户才知道为什么它需要手点一下。
                detail: recognized ? rawId : `${rawId} · 未识别`,
                checked:
                  modelSupportsModality(rawId, profile.manualModelModalities[rawId], modality) &&
                  !hidden.has(key),
              };
            });
          return (
            <ModelSourceSection
              key={profile.id}
              title={profile.name}
              detail={
                profile.availableModelIds.length
                  ? `${profile.availableModelIds.length} 个`
                  : "未拉取"
              }
              models={rows}
              loading={profile.connecting || profile.refreshing}
              empty={
                profile.availableModelIds.length ? "没有匹配的模型" : "请先在 API 配置中拉取模型"
              }
              onToggle={(key, checked) => {
                const rawId = rows.find((row) => row.key === key)?.rawId;
                if (!rawId) return;
                onAssign(profile.id, rawId, modality, checked);
                onSetVisible(key, checked);
              }}
              onToggleAll={(checked) =>
                rows.forEach((row) => {
                  onAssign(profile.id, row.rawId, modality, checked);
                  onSetVisible(row.key, checked);
                })
              }
            />
          );
        })}

        {!profiles.length && !availableCustomCount ? (
          <div className="wc-model-settings-empty">
            <Server aria-hidden="true" />
            <span>暂无自有 API 模型</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ModelSourceSection({
  title,
  detail,
  models,
  loading,
  empty,
  onToggle,
  onToggleAll,
}: {
  title: string;
  detail: string;
  models: Array<{ key: string; label: string; detail: string; checked: boolean }>;
  loading: boolean;
  empty: string;
  onToggle: (key: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
}) {
  const allChecked = models.length > 0 && models.every((model) => model.checked);
  return (
    <section className="wc-model-source-section">
      <header>
        <span>
          <strong>{title}</strong>
          <small>{detail}</small>
        </span>
        {loading ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : null}
        {models.length ? (
          <button type="button" onClick={() => onToggleAll(!allChecked)}>
            {allChecked ? "全部取消" : "全部选择"}
          </button>
        ) : null}
      </header>
      {models.length ? (
        <div className="wc-model-check-list">
          {models.map((model) => (
            <label key={model.key} className={model.checked ? "is-checked" : undefined}>
              <input
                type="checkbox"
                checked={model.checked}
                onChange={(event) => onToggle(model.key, event.target.checked)}
              />
              <i aria-hidden="true">
                <Check />
              </i>
              <span>
                <strong>{model.label}</strong>
                <small>{model.detail}</small>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <div className="wc-model-source-empty">{loading ? "正在读取模型" : empty}</div>
      )}
    </section>
  );
}

function profileStatus(profile: CustomApiProfile) {
  if (!profile.enabled) return { label: "已停用", tone: "disabled", icon: CircleOff } as const;
  if (profile.connecting || profile.refreshing)
    return { label: "正在同步模型", tone: "loading", icon: CircleDashed } as const;
  if (profile.error) return { label: "连接异常", tone: "error", icon: TriangleAlert } as const;
  if (profile.availableModelIds.length)
    return {
      label: `${profile.availableModelIds.length} 个模型已同步`,
      tone: "ready",
      icon: CircleCheck,
    } as const;
  return { label: "尚未同步模型", tone: "idle", icon: CircleDashed } as const;
}

type ProtocolDraft = {
  authStyle: CustomApiAuthStyle;
  authName: string;
  text: string;
  image: string;
  video: string;
  resultPaths: string;
  contentType: CustomApiRequestContentType;
  taskIdPaths: string;
  statusPaths: string;
  successValues: string;
  failValues: string;
  progressPath: string;
  pollUrl: string;
  pollMethod: "GET" | "POST";
  errorMessagePaths: string;
  errorCodePaths: string;
};

const DEFAULT_ENDPOINT_PLACEHOLDER = {
  text: "/v1/chat/completions",
  image: "/v1/images/generations",
  video: "/v1/videos",
} as const;

function linesToList(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 状态值允许逗号或换行分隔：用户抄上游文档时两种写法都常见。 */
function commaOrLinesToList(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function protocolDraftOf(profile: CustomApiProfile): ProtocolDraft {
  const protocol = profile.connection.protocol;
  const poll = protocol?.poll;
  return {
    authStyle: protocol?.auth?.style ?? "bearer",
    authName: protocol?.auth?.name ?? "",
    text: protocol?.endpoints?.text ?? "",
    image: protocol?.endpoints?.image ?? "",
    video: protocol?.endpoints?.video ?? "",
    resultPaths: (protocol?.resultUrlPaths ?? []).join("\n"),
    contentType: protocol?.request?.contentType ?? "json",
    taskIdPaths: (poll?.taskIdPaths ?? []).join("\n"),
    statusPaths: (poll?.statusPaths ?? []).join("\n"),
    successValues: (poll?.successValues ?? []).join(", "),
    failValues: (poll?.failValues ?? []).join(", "),
    progressPath: poll?.progressPath ?? "",
    pollUrl: poll?.urlTemplate ?? "",
    pollMethod: poll?.method ?? "GET",
    errorMessagePaths: (protocol?.error?.messagePaths ?? []).join("\n"),
    errorCodePaths: (protocol?.error?.codePaths ?? []).join("\n"),
  };
}

/** 同步 diff 文案：新增里有多少是知识库不认识的（那部分需要用户标类型才可选）。 */
function syncDiffText(diff: CustomApiSyncDiff) {
  const parts: string[] = [];
  if (diff.added.length) {
    const unrecognized = diff.added.filter((id) => !isRecognizedModel(id)).length;
    parts.push(
      unrecognized
        ? `新增 ${diff.added.length} 个模型（其中 ${unrecognized} 个未识别，需在模型列表里标注类型）`
        : `新增 ${diff.added.length} 个模型`,
    );
  }
  if (diff.removed.length) parts.push(`下架 ${diff.removed.length} 个模型`);
  return `上次同步：${parts.join(" · ")}`;
}

/** 草稿 → 协议档案。提交与「解析自检」必须共用这一份，否则自检用的形状和实际请求不一致。 */
function protocolFromDraft(draft: ProtocolDraft): CustomApiProtocolOverride {
  const endpoints: NonNullable<CustomApiProtocolOverride["endpoints"]> = {};
  if (draft.text.trim()) endpoints.text = draft.text.trim();
  if (draft.image.trim()) endpoints.image = draft.image.trim();
  if (draft.video.trim()) endpoints.video = draft.video.trim();
  return {
    auth:
      draft.authStyle === "bearer"
        ? { style: "bearer" }
        : {
            style: draft.authStyle,
            ...(draft.authName.trim() ? { name: draft.authName.trim() } : {}),
          },
    ...(Object.keys(endpoints).length ? { endpoints } : {}),
    ...(draft.contentType === "json" ? {} : { request: { contentType: draft.contentType } }),
    poll: {
      ...(draft.pollUrl.trim() ? { urlTemplate: draft.pollUrl.trim() } : {}),
      ...(draft.pollMethod === "GET" ? {} : { method: draft.pollMethod }),
      ...(linesToList(draft.taskIdPaths).length
        ? { taskIdPaths: linesToList(draft.taskIdPaths) }
        : {}),
      ...(linesToList(draft.statusPaths).length
        ? { statusPaths: linesToList(draft.statusPaths) }
        : {}),
      ...(commaOrLinesToList(draft.successValues).length
        ? { successValues: commaOrLinesToList(draft.successValues) }
        : {}),
      ...(commaOrLinesToList(draft.failValues).length
        ? { failValues: commaOrLinesToList(draft.failValues) }
        : {}),
      ...(draft.progressPath.trim() ? { progressPath: draft.progressPath.trim() } : {}),
    },
    error: {
      ...(linesToList(draft.errorMessagePaths).length
        ? { messagePaths: linesToList(draft.errorMessagePaths) }
        : {}),
      ...(linesToList(draft.errorCodePaths).length
        ? { codePaths: linesToList(draft.errorCodePaths) }
        : {}),
    },
    resultUrlPaths: linesToList(draft.resultPaths),
  };
}

/**
 * 高级协议（P0/P1/P2）：认证方式、按模态端点、请求体编码、异步轮询覆盖。
 * 全部是声明式覆盖，留空即走默认 OpenAI 兼容路径；不执行任何用户脚本。
 * 输入用本地草稿 + 失焦提交，避免半打字的路径被归一化吞掉。
 */
function AdvancedProtocolFields({
  profile,
  onCommit,
}: {
  profile: CustomApiProfile;
  onCommit: (id: string, patch: { protocol?: CustomApiProtocolOverride }) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, ProtocolDraft>>({});
  const [probeInput, setProbeInput] = useState("");
  const [probeResult, setProbeResult] = useState<
    { ok: true; probe: CustomApiProtocolProbe } | { ok: false; message: string } | null
  >(null);
  const [testModelId, setTestModelId] = useState("");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testPath, setTestPath] = useState<string | null>(null);
  const draft = drafts[profile.id] ?? protocolDraftOf(profile);
  const isGemini = normalizeCustomApiFormat(profile.connection.apiFormat) === "gemini";
  const testTarget = testModelId.trim() || profile.availableModelIds[0] || "";
  const update = (patch: Partial<ProtocolDraft>) =>
    setDrafts((current) => ({ ...current, [profile.id]: { ...draft, ...patch } }));
  const commit = () => {
    onCommit(profile.id, { protocol: protocolFromDraft(draft) });
    setDrafts((current) => {
      const next = { ...current };
      delete next[profile.id];
      return next;
    });
  };

  /** 测试请求：先把面板草稿落库（测试必须用你看到的那份协议），再发一条真实文本请求。 */
  const runTestRequest = async () => {
    const protocol = protocolFromDraft(draft);
    setTesting(true);
    setTestError(null);
    setTestPath(null);
    onCommit(profile.id, { protocol });
    try {
      const result = await sendCustomApiTestRequest(
        { ...profile.connection, protocol },
        testTarget,
      );
      const pretty = JSON.stringify(result.response, null, 2).slice(0, 4000);
      setProbeInput(pretty);
      setProbeResult(probeCustomApiResponse(pretty, protocol));
      setTestPath(result.path);
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : "测试请求失败");
    } finally {
      setTesting(false);
    }
  };

  return (
    <details className="wc-api-advanced">
      <summary>
        <span>高级协议（可选）</span>
        <small>认证 · 端点 · 请求体 · 异步轮询 · 解析自检</small>
      </summary>
      <div className="wc-custom-api-fields">
        <div className="wc-custom-api-field">
          <label htmlFor={`wc-api-auth-${profile.id}`}>认证方式</label>
          <select
            id={`wc-api-auth-${profile.id}`}
            value={draft.authStyle}
            onChange={(event) => update({ authStyle: event.target.value as CustomApiAuthStyle })}
            onBlur={commit}
          >
            <option value="bearer">Authorization: Bearer（默认）</option>
            <option value="header">自定义请求头</option>
            <option value="query">查询参数</option>
          </select>
        </div>
        {draft.authStyle !== "bearer" ? (
          <div className="wc-custom-api-field">
            <label htmlFor={`wc-api-auth-name-${profile.id}`}>
              {draft.authStyle === "header" ? "请求头名称" : "参数名称"}
            </label>
            <input
              id={`wc-api-auth-name-${profile.id}`}
              type="text"
              value={draft.authName}
              placeholder={draft.authStyle === "header" ? "x-api-key" : "key"}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ authName: event.target.value })}
              onBlur={commit}
            />
          </div>
        ) : null}
        {(["text", "image", "video"] as const).map((modality) => (
          <div className="wc-custom-api-field" key={modality}>
            <label htmlFor={`wc-api-endpoint-${modality}-${profile.id}`}>
              {modality === "text" ? "文本" : modality === "image" ? "图片" : "视频"}端点路径
            </label>
            <input
              id={`wc-api-endpoint-${modality}-${profile.id}`}
              type="text"
              value={draft[modality]}
              placeholder={DEFAULT_ENDPOINT_PLACEHOLDER[modality]}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ [modality]: event.target.value })}
              onBlur={commit}
            />
          </div>
        ))}
        <div className="wc-custom-api-field">
          <label htmlFor={`wc-api-content-type-${profile.id}`}>请求体编码</label>
          <select
            id={`wc-api-content-type-${profile.id}`}
            value={draft.contentType}
            onChange={(event) =>
              update({ contentType: event.target.value as CustomApiRequestContentType })
            }
            onBlur={commit}
          >
            <option value="json">JSON（默认）</option>
            <option value="form">表单 application/x-www-form-urlencoded</option>
            <option value="multipart">multipart/form-data</option>
          </select>
        </div>
        <div className="wc-custom-api-field">
          <label htmlFor={`wc-api-poll-url-${profile.id}`}>轮询地址模板</label>
          <input
            id={`wc-api-poll-url-${profile.id}`}
            type="text"
            value={draft.pollUrl}
            placeholder={"/v1/tasks/{task_id}"}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update({ pollUrl: event.target.value })}
            onBlur={commit}
          />
        </div>
        <div className="wc-custom-api-field">
          <label htmlFor={`wc-api-poll-method-${profile.id}`}>轮询方法</label>
          <select
            id={`wc-api-poll-method-${profile.id}`}
            value={draft.pollMethod}
            onChange={(event) => update({ pollMethod: event.target.value as "GET" | "POST" })}
            onBlur={commit}
          >
            <option value="GET">GET（默认）</option>
            <option value="POST">POST</option>
          </select>
        </div>
        <div className="wc-custom-api-field wc-custom-api-field--wide">
          <label htmlFor={`wc-api-task-paths-${profile.id}`}>任务号点路径（可选，每行一条）</label>
          <textarea
            id={`wc-api-task-paths-${profile.id}`}
            value={draft.taskIdPaths}
            rows={2}
            placeholder={"data.task.id"}
            spellCheck={false}
            onChange={(event) => update({ taskIdPaths: event.target.value })}
            onBlur={commit}
          />
        </div>
        <div className="wc-custom-api-field wc-custom-api-field--wide">
          <label htmlFor={`wc-api-status-paths-${profile.id}`}>状态点路径（可选，每行一条）</label>
          <textarea
            id={`wc-api-status-paths-${profile.id}`}
            value={draft.statusPaths}
            rows={2}
            placeholder={"data.state"}
            spellCheck={false}
            onChange={(event) => update({ statusPaths: event.target.value })}
            onBlur={commit}
          />
        </div>
        <div className="wc-custom-api-field">
          <label htmlFor={`wc-api-success-values-${profile.id}`}>完成状态值</label>
          <input
            id={`wc-api-success-values-${profile.id}`}
            type="text"
            value={draft.successValues}
            placeholder={"succeeded, 2"}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update({ successValues: event.target.value })}
            onBlur={commit}
          />
        </div>
        <div className="wc-custom-api-field">
          <label htmlFor={`wc-api-fail-values-${profile.id}`}>失败状态值</label>
          <input
            id={`wc-api-fail-values-${profile.id}`}
            type="text"
            value={draft.failValues}
            placeholder={"failed, 3"}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update({ failValues: event.target.value })}
            onBlur={commit}
          />
        </div>
        <div className="wc-custom-api-field">
          <label htmlFor={`wc-api-progress-path-${profile.id}`}>进度点路径</label>
          <input
            id={`wc-api-progress-path-${profile.id}`}
            type="text"
            value={draft.progressPath}
            placeholder={"data.progress"}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update({ progressPath: event.target.value })}
            onBlur={commit}
          />
        </div>
        <div className="wc-custom-api-field wc-custom-api-field--wide">
          <label htmlFor={`wc-api-error-paths-${profile.id}`}>
            错误信息点路径（可选，每行一条）
          </label>
          <textarea
            id={`wc-api-error-paths-${profile.id}`}
            value={draft.errorMessagePaths}
            rows={2}
            placeholder={"msg"}
            spellCheck={false}
            onChange={(event) => update({ errorMessagePaths: event.target.value })}
            onBlur={commit}
          />
        </div>
        <div className="wc-custom-api-field wc-custom-api-field--wide">
          <label htmlFor={`wc-api-error-codes-${profile.id}`}>错误码点路径（可选，每行一条）</label>
          <textarea
            id={`wc-api-error-codes-${profile.id}`}
            value={draft.errorCodePaths}
            rows={2}
            placeholder={"code"}
            spellCheck={false}
            onChange={(event) => update({ errorCodePaths: event.target.value })}
            onBlur={commit}
          />
        </div>
        <div className="wc-custom-api-field wc-custom-api-field--wide">
          <label htmlFor={`wc-api-result-${profile.id}`}>结果取回路径（可选，每行一条）</label>
          <textarea
            id={`wc-api-result-${profile.id}`}
            value={draft.resultPaths}
            rows={3}
            placeholder={"data.outputs.0.url"}
            spellCheck={false}
            onChange={(event) => update({ resultPaths: event.target.value })}
            onBlur={commit}
          />
          <small className="wc-custom-api-hint">留空即用内置候选；只接受点路径，不接受脚本。</small>
        </div>
        <div className="wc-custom-api-field wc-custom-api-field--wide">
          <label htmlFor={`wc-api-test-model-${profile.id}`}>测试请求</label>
          <input
            id={`wc-api-test-model-${profile.id}`}
            type="text"
            value={testModelId}
            placeholder={profile.availableModelIds[0] ?? "用于测试的模型 id"}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTestModelId(event.target.value)}
          />
          <span className="wc-custom-api-probe-actions">
            <button
              type="button"
              disabled={
                testing ||
                isGemini ||
                !profile.connection.baseUrl.trim() ||
                !profile.connection.apiKey.trim() ||
                !testTarget
              }
              onClick={() => void runTestRequest()}
            >
              {testing ? "发送中…" : "发送测试请求"}
            </button>
            <small className="wc-custom-api-hint">
              {isGemini
                ? "Gemini 原生协议不走这里测试"
                : testPath
                  ? `已发 ${testPath}，响应见下方自检`
                  : "浏览器直发，Key 不出本机；只发一条文本请求，不会触发图片/视频计费"}
            </small>
          </span>
          {testError ? (
            <small className="wc-custom-api-probe-error" role="alert">
              {testError}
            </small>
          ) : null}
        </div>
        <div className="wc-custom-api-field wc-custom-api-field--wide">
          <label htmlFor={`wc-api-probe-${profile.id}`}>解析自检（粘贴上游返回的 JSON）</label>
          <textarea
            id={`wc-api-probe-${profile.id}`}
            value={probeInput}
            rows={4}
            placeholder={'{"id":"task_1","status":"succeeded","output":{"url":"https://..."}}'}
            spellCheck={false}
            onChange={(event) => setProbeInput(event.target.value)}
          />
          <span className="wc-custom-api-probe-actions">
            <button
              type="button"
              onClick={() =>
                setProbeResult(probeCustomApiResponse(probeInput, protocolFromDraft(draft)))
              }
            >
              解析这段响应
            </button>
            <small className="wc-custom-api-hint">
              只做本地解析，不发请求、不产生费用。改完点路径后先在这里对一遍。
            </small>
          </span>
          {probeResult ? (
            probeResult.ok ? (
              <dl className="wc-custom-api-probe-result">
                <div>
                  <dt>任务号</dt>
                  <dd>
                    {probeResult.probe.taskId
                      ? `${probeResult.probe.taskId.value}（${probeResult.probe.taskId.path}）`
                      : "没有命中，请补任务号点路径"}
                  </dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd>
                    {probeResult.probe.status
                      ? `${probeResult.probe.status.verdict}（${probeResult.probe.status.raw} · ${probeResult.probe.status.path}）`
                      : "没有命中，请补状态点路径"}
                  </dd>
                </div>
                <div>
                  <dt>进度</dt>
                  <dd>
                    {probeResult.probe.progress
                      ? `${probeResult.probe.progress.value}（${probeResult.probe.progress.path}）`
                      : "没有命中"}
                  </dd>
                </div>
                <div>
                  <dt>结果 URL</dt>
                  <dd>
                    {probeResult.probe.resultUrl
                      ? `${probeResult.probe.resultUrl.value}（${probeResult.probe.resultUrl.path}）`
                      : "没有命中，请补结果取回路径"}
                  </dd>
                </div>
                <div>
                  <dt>错误信息</dt>
                  <dd>
                    {probeResult.probe.errorMessage
                      ? `${probeResult.probe.errorMessage.value}（${probeResult.probe.errorMessage.path}）`
                      : "没有命中"}
                  </dd>
                </div>
                <div>
                  <dt>错误码</dt>
                  <dd>
                    {probeResult.probe.errorCode
                      ? `${probeResult.probe.errorCode.value}（${probeResult.probe.errorCode.path}）`
                      : "没有命中"}
                  </dd>
                </div>
              </dl>
            ) : (
              <small className="wc-custom-api-probe-error" role="alert">
                {probeResult.message}
              </small>
            )
          ) : null}
        </div>
      </div>
    </details>
  );
}

function richModelLabel(profile: CustomApiProfile, rawModelId: string, modality: ModelModality) {
  const model = profile.catalog?.models.find((candidate) => {
    if (candidate.modality !== modality) return false;
    const route = profile.catalog?.routes[candidate.id];
    return candidate.id === rawModelId || route?.sourceModelId === rawModelId;
  });
  return model?.label ?? rawModelId;
}

function matchesSearch(value: string, query: string) {
  return !query || value.toLocaleLowerCase().includes(query);
}
