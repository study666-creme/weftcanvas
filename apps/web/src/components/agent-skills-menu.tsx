import {
  agentSkillLimits,
  assertImportableAgentSkill,
  parseAgentSkillMarkdown,
} from "@weftcanvas/contracts";
import { Check, FileUp, LoaderCircle, Trash2, Wand2, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { useAgentStore } from "../state/agent-store";

/**
 * 技能入口：抽屉输入区的「技能」键。
 *
 * 技能是用户自己导入的一份 SKILL.md（一段工作说明），启用后会随这一轮对话一起
 * 交给 Agent。这里只做三件事：看清单、勾选本轮要用的（最多 4 个）、导入/删除。
 * 面板锚在输入区上方，用 portal 挂到 body——抽屉本身 overflow: hidden，直接绝对
 * 定位会被裁掉（与模型选择器同一个原因）。
 */
export function AgentSkillsMenu({ disabled = false }: { disabled?: boolean }) {
  const skills = useAgentStore((state) => state.skills);
  const skillsStatus = useAgentStore((state) => state.skillsStatus);
  const skillsError = useAgentStore((state) => state.skillsError);
  const selectedSkillIds = useAgentStore((state) => state.selectedSkillIds);
  const loadSkills = useAgentStore((state) => state.loadSkills);
  const toggleSkill = useAgentStore((state) => state.toggleSkill);
  const removeSkill = useAgentStore((state) => state.removeSkill);
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const enabledCount = selectedSkillIds.length;
  const full = enabledCount >= agentSkillLimits.enabledPerRun;
  const loading = skillsStatus === "loading" && skills === null;

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const MENU_WIDTH = 300;
    const MENU_HEIGHT = 380;
    const place = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const inset = 12;
      const gap = 8;
      const width = Math.min(MENU_WIDTH, window.innerWidth - inset * 2);
      const spaceAbove = rect.top - gap - inset;
      const spaceBelow = window.innerHeight - rect.bottom - gap - inset;
      const openAbove = spaceAbove >= 200 || spaceAbove >= spaceBelow;
      const maxHeight = Math.max(160, Math.min(MENU_HEIGHT, openAbove ? spaceAbove : spaceBelow));
      const left = Math.max(inset, Math.min(rect.left, window.innerWidth - width - inset));
      setMenuStyle({
        left,
        width,
        maxHeight,
        ...(openAbove
          ? { bottom: window.innerHeight - rect.top + gap }
          : { top: rect.bottom + gap }),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        rootRef.current?.contains(target) ||
        menuRef.current?.contains(target) ||
        dialogRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 导入对话框自己处理 Escape；面板开合不冒泡到抽屉的关闭快捷键。
      if (importOpen) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", keyboard);
    };
  }, [importOpen, open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // 技能清单按需拉取：第一次展开面板时才请求，之后复用 store 里的结果。
  useEffect(() => {
    if (open) void loadSkills();
  }, [loadSkills, open]);

  const rows = skills ?? [];

  return (
    <div className="wc-agent-skills" ref={rootRef} data-enabled={enabledCount}>
      <button
        ref={triggerRef}
        type="button"
        className="wc-agent-skills-trigger"
        aria-label="Agent 技能"
        aria-haspopup="menu"
        aria-expanded={open}
        title="技能：把常用工作流带进这一轮对话"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Wand2 aria-hidden="true" />
        <span>{enabledCount ? `技能 ${enabledCount}` : "技能"}</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="wc-agent-skills-menu"
              role="menu"
              aria-label="Agent 技能"
              style={menuStyle}
              data-wc-preserve-drawers
            >
              <div className="wc-agent-skills-list">
                {loading ? (
                  <div className="wc-agent-skills-empty" role="status">
                    <LoaderCircle className="is-spinning" aria-hidden="true" />
                    正在加载技能
                  </div>
                ) : null}
                {!loading && skillsStatus === "error" && rows.length === 0 ? (
                  <div className="wc-agent-skills-empty is-error" role="status">
                    <span>{skillsError ?? "技能没有加载完成"}</span>
                    <button type="button" onClick={() => void loadSkills()}>
                      重试
                    </button>
                  </div>
                ) : null}
                {!loading && skillsStatus !== "error" && rows.length === 0 ? (
                  <div className="wc-agent-skills-empty">
                    {skillsError
                      ? skillsError
                      : "技能是一份可复用的工作说明（SKILL.md），启用后会随这一轮对话一起交给 Agent。"}
                  </div>
                ) : null}
                {rows.map((skill) => {
                  const enabled = selectedSkillIds.includes(skill.id);
                  const removing = removingId === skill.id;
                  return (
                    <div key={skill.id} className="wc-agent-skills-row" data-enabled={enabled}>
                      <label
                        className="wc-agent-skills-row-main"
                        title={skill.description || skill.name}
                      >
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={!enabled && full}
                          onChange={() => toggleSkill(skill.id)}
                        />
                        <span className="wc-agent-skills-row-copy">
                          <strong>{skill.name}</strong>
                          {skill.description ? <small>{skill.description}</small> : null}
                        </span>
                      </label>
                      {confirmingId === skill.id ? (
                        <span className="wc-agent-skills-confirm">
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
                                  setRemoveError(
                                    cause instanceof Error ? cause.message : "技能删除失败",
                                  );
                                })
                                .finally(() => setRemovingId(null));
                            }}
                          >
                            {removing ? (
                              <LoaderCircle className="is-spinning" aria-hidden="true" />
                            ) : null}
                            删除
                          </button>
                          <button
                            type="button"
                            disabled={removing}
                            onClick={() => setConfirmingId(null)}
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="wc-agent-skills-remove"
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
                    </div>
                  );
                })}
              </div>
              {removeError ? (
                <div className="wc-agent-skills-error" role="alert">
                  {removeError}
                </div>
              ) : null}
              <div className="wc-agent-skills-foot">
                <span className="wc-agent-skills-hint">
                  {full
                    ? `最多同时启用 ${agentSkillLimits.enabledPerRun} 个，先取消一个`
                    : `已启用 ${enabledCount}/${agentSkillLimits.enabledPerRun}`}
                </span>
                <button
                  type="button"
                  className="wc-agent-skills-import"
                  onClick={() => setImportOpen(true)}
                >
                  <FileUp aria-hidden="true" />
                  导入技能
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
      {importOpen ? (
        <AgentSkillImportDialog dialogRef={dialogRef} onClose={() => setImportOpen(false)} />
      ) : null}
    </div>
  );
}

const MAX_IMPORT_CHARS = agentSkillLimits.contentChars + 8_000;

function AgentSkillImportDialog({
  onClose,
  dialogRef,
}: {
  onClose: () => void;
  dialogRef: RefObject<HTMLDivElement | null>;
}) {
  const importSkill = useAgentStore((state) => state.importSkill);
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // 先关导入对话框，并且不要让抽屉自己的 Escape 也跟着关。
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", keyboard, true);
    return () => document.removeEventListener("keydown", keyboard, true);
  }, [onClose]);

  const readFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    // 立刻清空，避免再次选择同一个文件时不触发 change。
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
      className="wc-agent-skills-scrim"
      ref={dialogRef}
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="wc-agent-skills-dialog"
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
        <div className="wc-agent-skills-body">
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
          <div className="wc-agent-skills-file">
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
          <div className="wc-agent-skills-preview" data-status={parsed.status}>
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
            <div className="wc-agent-skills-error" role="alert">
              内容过长，超过 {agentSkillLimits.contentChars} 字符上限
            </div>
          ) : null}
          {error ? (
            <div className="wc-agent-skills-error" role="alert">
              {error}
            </div>
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
