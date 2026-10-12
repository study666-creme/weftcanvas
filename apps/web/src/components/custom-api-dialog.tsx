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
} from "../lib/custom-api";
import {
  canvasApiAccessLabel,
  resolveCanvasApiAccess,
  type CanvasApiAccess,
} from "../lib/canvas-api-access";
import { useCustomApiStore, type CustomApiProfile } from "../state/custom-api-store";
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
              const assigned = profile.manualModelModalities[rawId]?.includes(modality) ?? false;
              return {
                key,
                rawId,
                label: richModelLabel(profile, rawId, modality),
                detail: rawId,
                checked: assigned && !hidden.has(key),
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
