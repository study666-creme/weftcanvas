import {
  agentSkillLimits,
  assertImportableAgentSkill,
  parseAgentSkillMarkdown,
} from "@weftcanvas/contracts";
import { Check, FileUp, LoaderCircle, Plus, Trash2, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { CuratedSkill } from "../../lib/curated-skills";
import { useAgentStore } from "../../state/agent-store";

/**
 * 技能管理：与画布 Agent 输入区的「技能」键读同一份清单（apps/api 的
 * SKILLS_PATH，用户自己导入的 SKILL.md）。主页只做管理——导入、删除、勾选
 * 下一轮要用的；真正随对话注入仍在 Agent 抽屉里生效。
 */
export function HomeSkillsSection() {
  const skills = useAgentStore((state) => state.skills);
  const skillsStatus = useAgentStore((state) => state.skillsStatus);
  const skillsError = useAgentStore((state) => state.skillsError);
  const selectedSkillIds = useAgentStore((state) => state.selectedSkillIds);
  const loadSkills = useAgentStore((state) => state.loadSkills);
  const importSkill = useAgentStore((state) => state.importSkill);
  const toggleSkill = useAgentStore((state) => state.toggleSkill);
  const removeSkill = useAgentStore((state) => state.removeSkill);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const rows = skills ?? [];
  const loading = skillsStatus === "loading" && skills === null;
  const enabledCount = selectedSkillIds.length;
  const full = enabledCount >= agentSkillLimits.enabledPerRun;

  // 精选技能单独成块（内容 100KB 上下），只在打开技能页时才拉这个 chunk。
  const [curated, setCurated] = useState<CuratedSkill[] | null>(null);
  const [curatedError, setCuratedError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedNotice, setAddedNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void import("../../lib/curated-skills")
      .then((module) => {
        if (active) setCurated(module.curatedSkills);
      })
      .catch(() => {
        if (active) setCuratedError("精选技能加载失败，刷新页面后再试。");
      });
    return () => {
      active = false;
    };
  }, []);

  const libraryNames = useMemo(() => new Set(rows.map((skill) => skill.name)), [rows]);

  const addCuratedSkill = async (skill: CuratedSkill) => {
    if (addingId) return;
    setAddingId(skill.id);
    setCuratedError(null);
    setAddedNotice(null);
    try {
      await importSkill(skill.content);
      setAddedNotice(`已添加「${skill.name}」，在画布 Agent 里勾选后随下一轮对话生效`);
    } catch (cause) {
      setCuratedError(cause instanceof Error ? cause.message : "技能添加失败");
    } finally {
      setAddingId(null);
    }
  };

  return (
    <section className="wc-home-section wc-home-page" aria-labelledby="wc-home-skills-title">
      <header className="wc-home-page-head">
        <div>
          <h1 id="wc-home-skills-title">技能</h1>
          <p>
            一份 SKILL.md 就是一套可复用的工作说明
            {rows.length ? ` · 共 ${rows.length} 个` : ""}；在画布 Agent 里启用后随这一轮对话注入。
          </p>
        </div>
        <div className="wc-home-page-actions">
          <button
            type="button"
            className="wc-home-button is-primary"
            onClick={() => setImportOpen(true)}
          >
            <FileUp aria-hidden="true" />
            <span>导入技能</span>
          </button>
        </div>
      </header>

      {loading ? (
        <div className="wc-home-hint is-loading" role="status">
          <LoaderCircle className="is-spinning" aria-hidden="true" /> 正在加载技能
        </div>
      ) : skillsStatus === "error" && !rows.length ? (
        <div className="wc-home-empty">
          <Wand2 aria-hidden="true" />
          <strong>技能暂时读不到</strong>
          <p>{skillsError ?? "技能库没有加载完成，稍后再试。"}</p>
          <div className="wc-home-empty-actions">
            <button type="button" className="wc-home-button" onClick={() => void loadSkills()}>
              重试
            </button>
          </div>
        </div>
      ) : rows.length ? (
        <ul className="wc-home-skills" role="list">
          {rows.map((skill) => {
            const enabled = selectedSkillIds.includes(skill.id);
            const removing = removingId === skill.id;
            return (
              <li key={skill.id} className="wc-home-skill" data-enabled={enabled}>
                <label className="wc-home-skill-main">
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={!enabled && full}
                    aria-label={`本轮启用技能 ${skill.name}`}
                    onChange={() => toggleSkill(skill.id)}
                  />
                  <span className="wc-home-skill-check" aria-hidden="true" />
                  <span className="wc-home-skill-copy">
                    <strong>{skill.name}</strong>
                    {skill.description ? <small>{skill.description}</small> : null}
                  </span>
                </label>
                {confirmingId === skill.id ? (
                  <span className="wc-home-skill-confirm">
                    <button
                      type="button"
                      className="is-danger"
                      disabled={removing}
                      onClick={() => {
                        setRemovingId(skill.id);
                        setRemoveError(null);
                        void removeSkill(skill.id)
                          .then(() => setConfirmingId(null))
                          .catch((cause: unknown) => {
                            setRemoveError(cause instanceof Error ? cause.message : "技能删除失败");
                          })
                          .finally(() => setRemovingId(null));
                      }}
                    >
                      {removing ? (
                        <LoaderCircle className="is-spinning" aria-hidden="true" />
                      ) : null}
                      删除
                    </button>
                    <button type="button" disabled={removing} onClick={() => setConfirmingId(null)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="wc-home-skill-remove"
                    aria-label={`删除技能 ${skill.name}`}
                    title="删除"
                    onClick={() => {
                      setConfirmingId(skill.id);
                      setRemoveError(null);
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="wc-home-empty">
          <Wand2 aria-hidden="true" />
          <strong>还没有技能</strong>
          <p>
            导入一份 SKILL.md（例如固定的分镜格式、画面术语表或某个流程的检查清单）， 之后在画布
            Agent 里选中即可带上这一轮对话。
          </p>
          <div className="wc-home-empty-actions">
            <button
              type="button"
              className="wc-home-button is-primary"
              onClick={() => setImportOpen(true)}
            >
              <FileUp aria-hidden="true" />
              <span>导入技能</span>
            </button>
          </div>
        </div>
      )}

      {rows.length ? (
        <p className="wc-home-skills-hint">
          {full
            ? `最多同时启用 ${agentSkillLimits.enabledPerRun} 个，先取消一个`
            : `已启用 ${enabledCount}/${agentSkillLimits.enabledPerRun}`}
        </p>
      ) : null}
      {removeError ? (
        <p className="wc-home-skills-error" role="alert">
          {removeError}
        </p>
      ) : null}

      {curated?.length ? (
        <section className="wc-home-curated" aria-labelledby="wc-home-curated-title">
          <header className="wc-home-curated-head">
            <div>
              <h2 id="wc-home-curated-title">精选技能</h2>
              <p>开源 MIT、单文件无脚本；添加后存进你的技能库，仍需勾选才随对话生效。</p>
            </div>
            <span className="wc-home-curated-count">{curated.length}</span>
          </header>
          <ul className="wc-home-curated-list" role="list">
            {curated.map((skill) => {
              const added = libraryNames.has(skill.name);
              const adding = addingId === skill.id;
              return (
                <li key={skill.id} className="wc-home-curated-item" data-added={added}>
                  <div className="wc-home-curated-copy">
                    <strong>{skill.name}</strong>
                    <small>{skill.description}</small>
                    <a
                      href={`https://github.com/${skill.repo}/commit/${skill.commit}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={`${skill.repo} · ${skill.path} · ${skill.license}`}
                    >
                      {skill.repo} · {skill.license}
                    </a>
                  </div>
                  <button
                    type="button"
                    className="wc-home-curated-add"
                    disabled={added || adding || addingId !== null}
                    aria-label={added ? `已添加技能 ${skill.name}` : `添加技能 ${skill.name}`}
                    onClick={() => void addCuratedSkill(skill)}
                  >
                    {adding ? (
                      <LoaderCircle className="is-spinning" aria-hidden="true" />
                    ) : added ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <Plus aria-hidden="true" />
                    )}
                    {adding ? "添加中" : added ? "已添加" : "添加"}
                  </button>
                </li>
              );
            })}
          </ul>
          {addedNotice ? (
            <p className="wc-home-curated-note" role="status">
              {addedNotice}
            </p>
          ) : null}
          {curatedError ? (
            <p className="wc-home-skills-error" role="alert">
              {curatedError}
            </p>
          ) : null}
        </section>
      ) : null}

      {importOpen ? <HomeSkillImportDialog onClose={() => setImportOpen(false)} /> : null}
    </section>
  );
}

const MAX_IMPORT_CHARS = agentSkillLimits.contentChars + 8_000;

function HomeSkillImportDialog({ onClose }: { onClose: () => void }) {
  const importSkill = useAgentStore((state) => state.importSkill);
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const trimmed = content.trim();
  const tooLarge = content.length > MAX_IMPORT_CHARS;
  const parsed = useMemo(() => {
    if (!trimmed) return { status: "empty" } as const;
    try {
      const skill = assertImportableAgentSkill(parseAgentSkillMarkdown(trimmed));
      return { status: "ok", skill } as const;
    } catch (cause) {
      return {
        status: "error",
        message: cause instanceof Error ? cause.message : "技能内容无法解析",
      } as const;
    }
  }, [trimmed]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", keyboard, true);
    return () => document.removeEventListener("keydown", keyboard, true);
  }, [onClose]);

  const readFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setError(null);
    try {
      setContent(await file.text());
      setFileName(file.name);
    } catch {
      setError("文件读取失败，请改用粘贴");
    }
  };

  const submit = async () => {
    if (pending || parsed.status !== "ok" || tooLarge) return;
    setPending(true);
    setError(null);
    try {
      await importSkill(content);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "技能导入失败");
    } finally {
      setPending(false);
    }
  };

  return createPortal(
    <div
      className="wc-home-skill-scrim"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="wc-home-skill-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="导入技能"
      >
        <header>
          <strong>导入技能</strong>
          <span>SKILL.md</span>
          <button type="button" aria-label="关闭" title="关闭" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="wc-home-skill-dialog-body">
          <textarea
            aria-label="技能内容"
            value={content}
            spellCheck={false}
            placeholder="粘贴 SKILL.md 内容（可含 name / description frontmatter）"
            onChange={(event) => {
              setContent(event.target.value);
              setFileName(null);
              setError(null);
            }}
          />
          <div className="wc-home-skill-file">
            <label>
              <FileUp aria-hidden="true" />
              选择文件
              <input
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                aria-label="选择技能文件"
                onChange={(event) => void readFile(event.currentTarget)}
              />
            </label>
            <span>{fileName ?? "支持 .md / .markdown / .txt"}</span>
          </div>
          <div className="wc-home-skill-preview" data-status={parsed.status}>
            {parsed.status === "empty" ? (
              <span>粘贴或选择文件后，这里显示解析出的名称与描述</span>
            ) : null}
            {parsed.status === "error" ? <span>{parsed.message}</span> : null}
            {parsed.status === "ok" ? (
              <>
                <strong>{parsed.skill.name}</strong>
                <small>{parsed.skill.description || "（没有描述）"}</small>
                <em>{parsed.skill.body.length} 字正文</em>
              </>
            ) : null}
          </div>
          {tooLarge ? (
            <p className="wc-home-skills-error" role="alert">
              内容过长，超过 {agentSkillLimits.contentChars} 字符上限
            </p>
          ) : null}
          {error ? (
            <p className="wc-home-skills-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="is-primary"
            disabled={parsed.status !== "ok" || tooLarge || pending}
            onClick={() => void submit()}
          >
            {pending ? (
              <LoaderCircle className="is-spinning" aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            导入
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
