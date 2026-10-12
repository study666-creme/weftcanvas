import { useEffect, useState } from "react";

import "./site-announcements.css";

/**
 * 站点公告（画布侧）：拉取部署注入的公告接口里受众为「画布 / 全部」的条目，
 * 右下角非阻塞展示。公告是公开信息，接口匿名可读；已读状态只存本地
 * （当日不再弹），不依赖纬线登录态。
 */

// 公告端点由部署注入（VITE_ANNOUNCEMENTS_API_URL）；公开/自托管构建不配即关闭公告。
const ANNOUNCEMENTS_API = import.meta.env.VITE_ANNOUNCEMENTS_API_URL?.trim() || "";
const SEEN_PREFIX = "canvas_notice_seen_";
const MAX_VISIBLE = 3;

type AnnouncementItem = { id: string; text: string };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function seenToday(id: string): boolean {
  try {
    return localStorage.getItem(SEEN_PREFIX + id) === todayKey();
  } catch {
    return false;
  }
}

function markSeen(id: string): void {
  try {
    localStorage.setItem(SEEN_PREFIX + id, todayKey());
  } catch {
    // 存储不可用时忽略：本次会话内 state 已移除，仅刷新后可能再弹一次
  }
}

export function SiteAnnouncements() {
  const [items, setItems] = useState<AnnouncementItem[]>([]);

  useEffect(() => {
    if (!ANNOUNCEMENTS_API) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(ANNOUNCEMENTS_API, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { data?: { items?: AnnouncementItem[] } };
        const list = json?.data?.items ?? [];
        if (cancelled) return;
        setItems(
          list
            .filter((item) => item?.id && item?.text && !seenToday(item.id))
            .slice(0, MAX_VISIBLE),
        );
      } catch {
        // 公告拉取失败静默忽略，不影响画布使用
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!items.length) return null;

  const dismiss = (id: string) => {
    markSeen(id);
    setItems((current) => current.filter((item) => item.id !== id));
  };

  return (
    <div className="wc-site-announcements" role="status" aria-label="站点公告">
      {items.map((item) => (
        <div key={item.id} className="wc-site-announcement">
          <div className="wc-site-announcement-head">
            <span className="wc-site-announcement-badge">公告</span>
            <button
              type="button"
              className="wc-site-announcement-close"
              aria-label="关闭公告"
              onClick={() => dismiss(item.id)}
            >
              ×
            </button>
          </div>
          <p className="wc-site-announcement-text">{item.text}</p>
        </div>
      ))}
    </div>
  );
}
