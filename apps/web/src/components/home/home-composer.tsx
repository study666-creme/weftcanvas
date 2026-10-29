import { forwardRef, useImperativeHandle } from "react";
import { ArrowUp, Image as ImageIcon, ImagePlus, Music2, Video, X } from "lucide-react";

import { DIRECT_COMPOSER_PROMPT_MAX, useDirectComposer } from "../../hooks/use-direct-composer";
import type { DirectModality } from "../direct-generation-studio";
import { CategorizedModelSelect } from "../categorized-model-select";
import { GenerationParameterField } from "../generation-parameter-field";

const MODES: { value: DirectModality; label: string; icon: typeof ImageIcon }[] = [
  { value: "image", label: "图片生成", icon: ImageIcon },
  { value: "video", label: "视频生成", icon: Video },
  { value: "audio", label: "音频生成", icon: Music2 },
];

const PLACEHOLDERS: Record<DirectModality, string> = {
  image: "描述主体、环境、光线和画面气质，按 Enter 生成…",
  video: "描述镜头、动作、节奏和时长感，按 Enter 生成…",
  audio: "描述音乐风格与情绪，或直接写要朗读的文字…",
};

const SUBMIT_LABELS: Record<DirectModality, string> = {
  image: "生成图片",
  video: "生成视频",
  audio: "生成音频",
};

export type HomeComposerHandle = {
  /** 把模板/历史提示词放进输入框（可切换模式），并聚焦到末尾。 */
  fill: (prompt: string, modality?: DirectModality) => void;
  focus: () => void;
};

/**
 * 主页生成框：模式切换、提示词、参考素材（上传/拖拽/粘贴、@ 引用）、模型与参数。
 * 行为与原入口生成框一致（共用 useDirectComposer），只是换成主页的紧凑版式。
 */
export const HomeComposer = forwardRef<HomeComposerHandle>(function HomeComposer(_props, ref) {
  const composer = useDirectComposer();
  const {
    mode,
    changeMode,
    prompt,
    updatePrompt,
    promptRef,
    fileInputRef,
    mentionRange,
    mentionIndex,
    visibleMentionCandidates,
    chooseMention,
    mentionReference,
    references,
    removeReference,
    dragActive,
    uploadError,
    catalog,
    models,
    model,
    setModelId,
    parameters,
    setParameter,
    editableParameters,
    materialControls,
    acceptedMimes,
  } = composer;

  useImperativeHandle(ref, () => ({
    fill: (value, modality) => {
      if (modality) changeMode(modality);
      updatePrompt(value, value.length);
      requestAnimationFrame(() => {
        const textarea = promptRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(value.length, value.length);
        textarea.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    },
    focus: () => promptRef.current?.focus(),
  }));

  const catalogLoading = catalog.status === "loading" && !models.length;
  const catalogUnavailable = catalog.status === "error" && !models.length;
  const canSubmit = Boolean(models.length);

  return (
    <div
      className={`wc-home-composer${dragActive ? " is-drag-active" : ""}`}
      data-mode={mode}
      onDragOver={composer.onDragOver}
      onDragLeave={composer.onDragLeave}
      onDrop={composer.onDrop}
    >
      <div className="wc-home-composer-modes" role="tablist" aria-label="生成类型">
        {MODES.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            className={mode === value ? "is-active" : undefined}
            onClick={() => changeMode(value)}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="wc-entry-prompt-wrap wc-home-composer-prompt-wrap">
        <textarea
          ref={promptRef}
          className="wc-home-composer-prompt"
          rows={3}
          maxLength={DIRECT_COMPOSER_PROMPT_MAX}
          placeholder={PLACEHOLDERS[mode]}
          aria-label="生成提示词"
          value={prompt}
          onChange={(event) =>
            updatePrompt(
              event.target.value,
              event.target.selectionStart ?? event.target.value.length,
            )
          }
          onKeyDown={composer.handlePromptKeyDown}
          onPaste={composer.onPaste}
        />
        {mentionRange && visibleMentionCandidates.length ? (
          <div className="wc-entry-mention-menu" role="listbox" aria-label="引用素材">
            {visibleMentionCandidates.map((candidate, index) => (
              <button
                key={candidate.id}
                type="button"
                role="option"
                aria-selected={index === mentionIndex}
                className={index === mentionIndex ? "is-active" : undefined}
                onMouseDown={(event) => {
                  event.preventDefault();
                  chooseMention(candidate);
                }}
              >
                <span className="wc-entry-mention-label">@{candidate.label}</span>
                <span>{candidate.name}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {references.length ? (
        <div className="wc-entry-references wc-home-composer-references" aria-label="参考素材">
          {references.map((reference) => (
            <figure
              key={reference.id}
              className={`wc-entry-reference is-${reference.status} is-${reference.kind}`}
              title={
                reference.status === "ready"
                  ? `${reference.name}（点击引用到提示词）`
                  : (reference.error ?? reference.name)
              }
            >
              <button
                type="button"
                className="wc-entry-reference-mention"
                aria-label={
                  reference.status === "ready" ? `引用素材 ${reference.name}` : reference.name
                }
                disabled={reference.status !== "ready"}
                onClick={() => mentionReference(reference)}
              >
                {reference.kind === "video" ? (
                  reference.previewUrl ? (
                    <video src={reference.previewUrl} muted playsInline preload="metadata" />
                  ) : (
                    <Video aria-hidden="true" className="wc-entry-reference-kind-icon" />
                  )
                ) : reference.kind === "audio" ? (
                  <span className="wc-entry-reference-kind-icon" aria-hidden="true">
                    <Music2 />
                  </span>
                ) : reference.previewUrl ? (
                  <img src={reference.previewUrl} alt={reference.name} />
                ) : (
                  <span className="wc-entry-reference-loading" aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                aria-label={`移除素材 ${reference.name}`}
                onClick={() => removeReference(reference)}
              >
                <X aria-hidden="true" />
              </button>
              {reference.status === "uploading" ? (
                <i className="wc-entry-reference-progress" aria-hidden="true" />
              ) : null}
              {reference.status === "error" ? (
                <em className="wc-entry-reference-error" aria-hidden="true">
                  !
                </em>
              ) : null}
            </figure>
          ))}
        </div>
      ) : null}
      {uploadError ? (
        <p className="wc-home-composer-error" role="alert">
          {uploadError}
        </p>
      ) : null}

      <div className="wc-home-composer-foot">
        <div className="wc-home-composer-controls">
          <input
            ref={fileInputRef}
            type="file"
            accept={acceptedMimes || "image/*,video/*,audio/*"}
            multiple
            hidden
            onChange={composer.onFileInput}
            aria-hidden="true"
            tabIndex={-1}
          />
          <button
            type="button"
            className="wc-home-icon-button"
            title={
              model && materialControls.length
                ? `添加参考素材（支持${materialControls
                    .map((control) => control.label.replace("素材", ""))
                    .join("、")}，可拖拽或粘贴）`
                : "当前模型不支持参考素材"
            }
            aria-label="添加参考素材"
            disabled={!model || !materialControls.length}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus aria-hidden="true" />
          </button>
          <span className="wc-home-composer-divider" aria-hidden="true" />
          {catalogLoading ? (
            <span className="wc-home-composer-status">正在加载模型…</span>
          ) : catalogUnavailable ? (
            <span className="wc-home-composer-status is-error">
              模型目录暂不可用，可在工作台配置自有 API
            </span>
          ) : (
            <div className="wc-entry-model wc-home-composer-model">
              <CategorizedModelSelect
                value={model?.id ?? ""}
                models={models}
                onChange={setModelId}
                ariaLabel="模型"
              />
            </div>
          )}
          {editableParameters.length ? (
            <div className="wc-entry-params wc-home-composer-params" aria-label="生成参数">
              {editableParameters.map((parameter) => (
                <GenerationParameterField
                  key={`${model?.id ?? "model"}:${parameter.name}`}
                  parameter={parameter}
                  value={parameters[parameter.name]}
                  disabled={false}
                  boundedDuration={mode === "video"}
                  onChange={(value) => setParameter(parameter.name, value)}
                  onValidityChange={() => undefined}
                  menuClassName="wc-entry-select-menu"
                />
              ))}
            </div>
          ) : null}
        </div>
        <span className="wc-home-composer-count" aria-hidden="true">
          {prompt.length ? `${prompt.length} / ${DIRECT_COMPOSER_PROMPT_MAX}` : ""}
        </span>
        <button
          type="button"
          className="wc-home-composer-submit"
          onClick={composer.submit}
          disabled={!canSubmit}
          aria-label={SUBMIT_LABELS[mode]}
          title={`${SUBMIT_LABELS[mode]}（Enter）`}
        >
          <span>{SUBMIT_LABELS[mode]}</span>
          <ArrowUp aria-hidden="true" />
        </button>
      </div>
    </div>
  );
});
