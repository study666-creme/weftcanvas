import { announcementListResponseSchema, type PublicAnnouncement } from "@weftcanvas/contracts";
import { Bell, Lightbulb, Pin, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  formatAnnouncementTime,
  parseAnnouncementBody,
  type AnnouncementBlock,
} from "../lib/announcement-content";
import { useOnboardingStore } from "../state/onboarding-store";
import "./site-announcements.css";

/**
 * 站点公告（画布侧）：从画布自己的 API（`GET /api/v1/announcements`）拉取
 * 运营在后台维护的公告，以「系统公告」弹窗展示。公告是公开信息，接口匿名可读。
 *
 * 关闭语义（图一同款）：
 * - 「关闭本次」只关这一轮，记在 sessionStorage；同一批公告换标签页/新会话会再出现。
 * - 「今日不再提醒」按条目记到当天，次日或新公告出现时照常展示。
 * 首次访客的新手教程正在走时不弹，教程收起后补上——两个浮层不抢画面。
 */

const ANNOUNCEMENTS_ENDPOINT = "/api/v1/announcements";
/** 弹窗最多展示的条数：公告是提示不是信息流，再多也该写进正文里。 */
const MAX_VISIBLE = 8;
const SEEN_KEY = "weftcanvas:announcements:seen";
const CLOSED_KEY = "weftcanvas:announcements:closed";

function todayKey(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readSeen(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function seenToday(id: string): boolean {
  return readSeen()[id] === todayKey();
}

function markSeen(ids: string[]): void {
  try {
    const seen = readSeen();
    const today = todayKey();
    for (const id of ids) seen[id] = today;
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // 存储不可用时忽略：本次会话内已经收起，刷新后可能再弹一次。
  }
}

function readClosed(): string[] {
  try {
    const raw = sessionStorage.getItem(CLOSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function markClosed(ids: string[]): void {
  try {
    sessionStorage.setItem(CLOSED_KEY, JSON.stringify([...new Set([...readClosed(), ...ids])]));
  } catch {
    // 同上：存不进去只是这一轮记得不够久。
  }
}

export function SiteAnnouncements() {
  const [items, setItems] = useState<PublicAnnouncement[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  // 新手教程正在走时不弹公告：教程 + 弹窗同时出现会把首屏信息一次压满。
  const onboardingRunning = useOnboardingStore((state) => state.status === "running");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(ANNOUNCEMENTS_ENDPOINT, { cache: "no-store" });
        if (!response.ok) return;
        const parsed = announcementListResponseSchema.safeParse(await response.json());
        if (!parsed.success || cancelled) return;
        const list = parsed.data.data.items
          .filter((item) => !seenToday(item.id))
          .slice(0, MAX_VISIBLE);
        if (!list.length) return;
        const closed = readClosed();
        if (list.every((item) => closed.includes(item.id))) return;
        setItems(list);
      } catch {
        // 公告拉取失败静默忽略，不影响画布使用。
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const open = items.length > 0 && !dismissed && !onboardingRunning;

  useEffect(() => {
    if (!open) return;
    // 弹窗出现时把焦点放到关闭键：Esc/回车都有落点，也不打断输入框里的选择。
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      markClosed(items.map((item) => item.id));
      setDismissed(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, items]);

  if (!open) return null;

  const closeThisTime = () => {
    markClosed(items.map((item) => item.id));
    setDismissed(true);
  };
  const remindTomorrow = () => {
    markSeen(items.map((item) => item.id));
    setDismissed(true);
  };

  return createPortal(
    <div className="wc-notice-scrim" role="presentation" onClick={closeThisTime}>
      <section
        className="wc-notice-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wc-notice-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="wc-notice-head">
          <span className="wc-notice-bell" aria-hidden="true">
            <Bell />
          </span>
          <div className="wc-notice-heading">
            <h2 id="wc-notice-title">系统公告</h2>
            <small>{items.length} 条当前公告</small>
          </div>
          <button
            type="button"
            ref={closeRef}
            className="wc-notice-close"
            aria-label="关闭公告"
            onClick={closeThisTime}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="wc-notice-list wc-notice-scroll">
          {items.map((item) => (
            <article key={item.id} className="wc-notice-item" data-level={item.level}>
              <span className="wc-notice-dot" aria-hidden="true" />
              <div className="wc-notice-item-body">
                <h3 className="wc-notice-item-title">
                  <span>{item.title}</span>
                  {item.level === "important" ? (
                    <span className="wc-notice-badge is-important">
                      <Lightbulb aria-hidden="true" />
                      重要通知
                    </span>
                  ) : null}
                  {item.pinned ? (
                    <span className="wc-notice-badge is-pinned">
                      <Pin aria-hidden="true" />
                      置顶
                    </span>
                  ) : null}
                </h3>
                <div className="wc-notice-content">
                  {parseAnnouncementBody(item.body).map((block, index) => (
                    <NoticeBlock key={index} block={block} />
                  ))}
                </div>
                <time className="wc-notice-time" dateTime={item.publishedAt}>
                  {formatAnnouncementTime(item.publishedAt)}
                </time>
              </div>
            </article>
          ))}
        </div>

        <footer className="wc-notice-foot">
          <button type="button" className="wc-notice-snooze" onClick={remindTomorrow}>
            今日不再提醒
          </button>
          <button type="button" className="wc-notice-ok" onClick={closeThisTime}>
            关闭本次
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function NoticeBlock({ block }: { block: AnnouncementBlock }) {
  if (block.kind === "image")
    return <img className="wc-notice-image" src={block.src} alt={block.alt} loading="lazy" />;
  if (block.kind === "linkRow")
    return (
      <p className="wc-notice-link-row">
        <a href={block.href} target="_blank" rel="noreferrer">
          {block.label}
        </a>
      </p>
    );
  return (
    <p>
      {block.lines.map((line, lineIndex) => (
        <span key={lineIndex} className="wc-notice-line">
          {line.map((span, spanIndex) => {
            if (span.kind === "strong") return <strong key={spanIndex}>{span.text}</strong>;
            if (span.kind === "link")
              return (
                <a key={spanIndex} href={span.href} target="_blank" rel="noreferrer">
                  {span.label}
                </a>
              );
            return <span key={spanIndex}>{span.text}</span>;
          })}
          {lineIndex < block.lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </p>
  );
}
