import type { CloudProjectInvitation, CloudProjectMember } from "@kachang/contracts";
import {
  Check,
  Clock3,
  Cloud,
  Crown,
  LoaderCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  UserMinus,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  acceptCloudProjectInvitation,
  CanvasApiError,
  declineCloudProjectInvitation,
  inviteCloudProjectMember,
  listCloudProjectInvitations,
  listCloudProjectMembers,
  removeCloudProjectMember,
  revokeCloudProjectInvitation,
} from "../lib/api-client";
import { requestConfirmation } from "../lib/confirmation";
import { useCanvasStore } from "../state/canvas-store";
import { useCloudProjectStore } from "../state/cloud-project-store";
import { useCollaborationDialogStore } from "../state/collaboration-dialog-store";
import { useIdentityStore } from "../state/identity-store";
import { useToastStore } from "../state/toast-store";

type LoadStatus = "idle" | "loading" | "ready" | "error";

export const COLLABORATION_ACCESS_LABEL = "协作最多 5 人";
export const COLLABORATION_SEAT_POLICY_LABEL = "含所有者和最多 4 名协作者，当前限免，可跨项目复用";
export const COLLABORATION_SEAT_LIMIT_MESSAGE = "协作人数已达 5 人上限。可移除协作者或取消待处理邀请后重试。";

export function CollaborationDialog() {
  const open = useCollaborationDialogStore((state) => state.open);
  const close = useCollaborationDialogStore((state) => state.closeDialog);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [close, open]);

  if (!open) return null;

  return (
    <div
      className="kc-collaboration-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="项目协作"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section className="kc-collaboration-dialog">
        <CollaborationPanel onComplete={close} onClose={close} />
      </section>
    </div>
  );
}

/**
 * 项目协作面板内容（header + 成员/邀请管理 + 完成键）。
 * 既服务独立弹窗（CollaborationDialog），也嵌入设置中心「协作」板块——
 * 嵌入态不传 onComplete / onClose，隐藏底部完成键与「返回画布」键。
 */
export function CollaborationPanel({ onComplete, onClose }: { onComplete?: () => void; onClose?: () => void }) {
  const projectId = useCanvasStore((state) => state.projectId);
  const projectName = useCanvasStore((state) => state.projectName);
  const cloudLinks = useCloudProjectStore((state) => state.links);
  const refreshCloud = useCloudProjectStore((state) => state.refresh);
  const openRemoteProject = useCloudProjectStore((state) => state.openRemoteProject);
  const identityStatus = useIdentityStore((state) => state.status);
  const identityUserId = useIdentityStore((state) => state.session?.user.id ?? null);
  const openAccount = useIdentityStore((state) => state.openDialog);
  const showToast = useToastStore((state) => state.show);
  const [members, setMembers] = useState<CloudProjectMember[]>([]);
  const [invitations, setInvitations] = useState<CloudProjectInvitation[]>([]);
  const [projectInvitations, setProjectInvitations] = useState<CloudProjectInvitation[]>([]);
  const [seatUsage, setSeatUsage] = useState<{ limit: number; used: number } | null>(null);
  const [memberStatus, setMemberStatus] = useState<LoadStatus>("idle");
  const [invitationStatus, setInvitationStatus] = useState<LoadStatus>("idle");
  const [memberError, setMemberError] = useState<CanvasApiError | null>(null);
  const [invitationError, setInvitationError] = useState<CanvasApiError | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteeId, setInviteeId] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const requestEpoch = useRef(0);

  const cloudLinked = Boolean(cloudLinks[projectId]);
  const owner = members.some((member) => member.principalId === identityUserId && member.role === "owner");
  const pendingInvitations = invitations.filter((invitation) => invitation.status === "pending");
  const pendingProjectInvitations = projectInvitations.filter((invitation) => invitation.status === "pending");

  const refresh = useCallback(async () => {
    if (identityStatus !== "authenticated" || !identityUserId) return;
    const epoch = ++requestEpoch.current;
    const current = () => requestEpoch.current === epoch;
    setMemberStatus(cloudLinked ? "loading" : "idle");
    setInvitationStatus("loading");
    setMemberError(null);
    setInvitationError(null);
    setInviteError(null);

    const [projectResult, invitationResult] = await Promise.allSettled([
      cloudLinked
        ? listCloudProjectMembers(projectId, cloudLinks[projectId]?.projectOwnerId)
        : Promise.resolve(null),
      listCloudProjectInvitations(),
    ]);
    if (!current()) return;

    if (!cloudLinked) {
      setMembers([]);
      setProjectInvitations([]);
      setSeatUsage(null);
    } else if (projectResult.status === "fulfilled" && projectResult.value) {
      setMembers(projectResult.value.members);
      setProjectInvitations(projectResult.value.invitations);
      setSeatUsage(projectResult.value.seatUsage ?? null);
      setMemberStatus("ready");
    } else {
      setMembers([]);
      setProjectInvitations([]);
      setSeatUsage(null);
      setMemberStatus("error");
      setMemberError(asApiError(projectResult.status === "rejected" ? projectResult.reason : null));
    }

    if (invitationResult.status === "fulfilled") {
      setInvitations(invitationResult.value);
      setInvitationStatus("ready");
    } else {
      setInvitations([]);
      setInvitationStatus("error");
      setInvitationError(asApiError(invitationResult.reason));
    }

  }, [cloudLinked, cloudLinks, identityStatus, identityUserId, projectId]);

  useEffect(() => {
    setInviteeId("");
    setInviteError(null);
    setAction(null);
    void refresh();
  }, [refresh]);

  const proRequired = memberError?.code === "COLLABORATION_PRO_REQUIRED"
    || invitationError?.code === "COLLABORATION_PRO_REQUIRED";
  const serviceUnavailable = memberError?.code === "COLLABORATION_UNAVAILABLE"
    || invitationError?.code === "COLLABORATION_UNAVAILABLE";

  const invite = async () => {
    const target = inviteeId.trim();
    if (!target || !projectId) return;
    setAction(`invite:${target}`);
    setInviteError(null);
    try {
      await inviteCloudProjectMember(projectId, target);
      setInviteeId("");
      showToast("协作邀请已发送", "success");
      await refresh();
    } catch (cause) {
      const message = collaborationApiMessage(cause, "邀请发送失败");
      setInviteError(message);
      showToast(message, "error");
    } finally {
      setAction(null);
    }
  };

  const accept = async (invitation: CloudProjectInvitation) => {
    setAction(`accept:${invitation.id}`);
    try {
      await acceptCloudProjectInvitation(invitation.id);
      if (identityUserId) {
        await refreshCloud(identityUserId, true);
        const opened = await openRemoteProject(identityUserId, invitation.projectId, invitation.inviterId);
        showToast(opened ? "已加入并打开共享项目" : "已加入项目协作", "success");
      } else {
        showToast("已加入项目协作", "success");
      }
      await refresh();
    } catch (cause) {
      showToast(collaborationApiMessage(cause, "接受邀请失败"), "error");
    } finally {
      setAction(null);
    }
  };

  const remove = async (member: CloudProjectMember) => {
    if (!projectId || member.role === "owner") return;
    const confirmed = await requestConfirmation({
      title: "移除协作成员",
      description: "该成员将立即失去此项目的访问与协作权限。",
      detail: member.principalId,
      confirmLabel: "移除成员",
      tone: "danger",
    });
    if (!confirmed) return;
    setAction(`remove:${member.principalId}`);
    try {
      await removeCloudProjectMember(projectId, member.principalId);
      showToast("成员已移除", "success");
      await refresh();
    } catch (cause) {
      showToast(collaborationApiMessage(cause, "成员移除失败"), "error");
    } finally {
      setAction(null);
    }
  };

  const cancelInvitation = async (invitation: CloudProjectInvitation) => {
    if (!projectId) return;
    const confirmed = await requestConfirmation({
      title: "取消协作邀请",
      description: "邀请链接将立即失效，对方无法再通过这条邀请加入项目。",
      detail: invitation.inviteeId,
      confirmLabel: "取消邀请",
      tone: "warning",
    });
    if (!confirmed) return;
    setAction(`revoke:${invitation.id}`);
    try {
      await revokeCloudProjectInvitation(projectId, invitation.id);
      showToast("邀请已取消", "success");
      await refresh();
    } catch (cause) {
      showToast(collaborationApiMessage(cause, "取消邀请失败"), "error");
    } finally {
      setAction(null);
    }
  };

  const decline = async (invitation: CloudProjectInvitation) => {
    const confirmed = await requestConfirmation({
      title: "拒绝项目邀请",
      description: "拒绝后，这条邀请会从待处理列表中移除。",
      detail: invitation.projectId,
      confirmLabel: "拒绝邀请",
      tone: "danger",
    });
    if (!confirmed) return;
    setAction(`decline:${invitation.id}`);
    try {
      await declineCloudProjectInvitation(invitation.id);
      showToast("邀请已拒绝", "success");
      await refresh();
    } catch (cause) {
      showToast(collaborationApiMessage(cause, "拒绝邀请失败"), "error");
    } finally {
      setAction(null);
    }
  };

  return (
    <>
      <header className="kc-collaboration-header">
        <span className="kc-collaboration-mark"><UsersRound aria-hidden="true" /></span>
        <div>
          <strong>项目协作</strong>
          <small>{projectName || "当前画布"}</small>
        </div>
        {onComplete ? (
          <button type="button" className="kc-dialog-close" aria-label="关闭" title="关闭" onClick={onComplete}>
            <X aria-hidden="true" />
          </button>
        ) : null}
      </header>

        {identityStatus !== "authenticated" ? (
          <div className="kc-collaboration-state">
            <ShieldCheck aria-hidden="true" />
            <strong>登录后开始协作</strong>
            <p>项目成员和邀请由 Canvas 账号安全保存。</p>
            <button type="button" className="kc-collaboration-primary" onClick={() => { onClose?.(); openAccount("login"); }}>
              <UsersRound aria-hidden="true" />登录账号
            </button>
          </div>
        ) : proRequired ? (
          <div className="kc-collaboration-content">
            <div className="kc-collaboration-state kc-collaboration-state--pro kc-collaboration-state--compact">
              <Crown aria-hidden="true" />
              <strong>当前账号暂无协作权限</strong>
              <p>协作开放范围由服务端权益控制，请确认账号权益后刷新重试。</p>
              <button type="button" className="kc-collaboration-primary" onClick={() => void refresh()}>
                <RefreshCw aria-hidden="true" />刷新状态
              </button>
            </div>
            <InvitationSection
              status={invitationStatus}
              error={invitationError}
              invitations={pendingInvitations}
              action={action}
              onAccept={(invitation) => void accept(invitation)}
              onDecline={(invitation) => void decline(invitation)}
            />
          </div>
        ) : serviceUnavailable ? (
          <div className="kc-collaboration-state">
            <UsersRound aria-hidden="true" />
            <strong>协作服务暂不可用</strong>
            <p>当前环境还没有配置云端协作存储。</p>
            <button type="button" className="kc-collaboration-secondary" onClick={() => void refresh()}>
              <RefreshCw aria-hidden="true" />重试
            </button>
          </div>
        ) : !cloudLinked ? (
          <div className="kc-collaboration-content">
            <div className="kc-collaboration-state kc-collaboration-state--compact">
              <Cloud aria-hidden="true" />
              <strong>先保存到云端</strong>
              <p>{COLLABORATION_ACCESS_LABEL}。当前画布还没有云端项目链接，保存后即可邀请成员。</p>
              {onClose ? <button type="button" className="kc-collaboration-secondary" onClick={onClose}>返回画布</button> : null}
            </div>
            <InvitationSection
              status={invitationStatus}
              error={invitationError}
              invitations={pendingInvitations}
              action={action}
              onAccept={(invitation) => void accept(invitation)}
              onDecline={(invitation) => void decline(invitation)}
            />
          </div>
        ) : (
          <div className="kc-collaboration-content">
            <section className="kc-collaboration-section">
              <div className="kc-collaboration-section-heading">
                <div><strong>{COLLABORATION_ACCESS_LABEL}</strong><small>{COLLABORATION_SEAT_POLICY_LABEL}</small></div>
                <ShieldCheck aria-hidden="true" />
              </div>
            </section>
            <section className="kc-collaboration-section">
              <div className="kc-collaboration-section-heading">
                <div><strong>项目成员</strong><small>{memberStatus === "loading" ? "正在同步" : `${members.length} 人`}</small></div>
                <button type="button" className="kc-collaboration-icon-button" aria-label="刷新成员和邀请" title="刷新" onClick={() => void refresh()} disabled={memberStatus === "loading" || invitationStatus === "loading"}>
                  <RefreshCw className={memberStatus === "loading" || invitationStatus === "loading" ? "is-spinning" : ""} aria-hidden="true" />
                </button>
              </div>
              {memberStatus === "loading" ? <LoadingRow label="正在读取成员" /> : null}
              {memberStatus === "error" ? <p className="kc-collaboration-inline-error">{collaborationApiMessage(memberError, "成员列表读取失败")}</p> : null}
              {memberStatus === "ready" ? (
                <div className="kc-collaboration-members">
                  {members.map((member) => (
                    <div className="kc-collaboration-member" key={member.principalId}>
                      <span className="kc-collaboration-avatar" aria-hidden="true">{member.role === "owner" ? <Crown /> : <UsersRound />}</span>
                      <span className="kc-collaboration-member-copy"><strong>{member.principalId}</strong><small>{member.role === "owner" ? "项目所有者" : "协作者"}</small></span>
                      {member.role === "member" && owner ? (
                        <button type="button" className="kc-collaboration-icon-button is-danger" aria-label={`移除 ${member.principalId}`} title="移除成员" disabled={action === `remove:${member.principalId}`} onClick={() => void remove(member)}>
                          {action === `remove:${member.principalId}` ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <UserMinus aria-hidden="true" />}
                        </button>
                      ) : <span className="kc-collaboration-role-mark"><Check aria-hidden="true" /></span>}
                    </div>
                  ))}
                </div>
              ) : null}
            </section>

            {owner ? (
              <section className="kc-collaboration-section kc-collaboration-invite">
                <div className="kc-collaboration-section-heading">
                  <div><strong>邀请协作者</strong><small>{seatUsage ? `账号席位已占用 ${seatUsage.used}/${seatUsage.limit}` : COLLABORATION_SEAT_POLICY_LABEL}</small></div>
                </div>
                <div className="kc-collaboration-invite-form">
                  <input value={inviteeId} maxLength={128} placeholder="例如 account_123" aria-label="协作者账号 ID" onChange={(event) => setInviteeId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void invite(); }} />
                  <button type="button" className="kc-collaboration-primary" disabled={!inviteeId.trim() || action?.startsWith("invite:") === true} onClick={() => void invite()}>
                    {action?.startsWith("invite:") ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Send aria-hidden="true" />}邀请
                  </button>
                </div>
                {inviteError ? <p className="kc-collaboration-inline-error" role="alert">{inviteError}</p> : null}
              </section>
            ) : null}

            {owner ? (
              <ProjectInvitationSection
                status={memberStatus}
                error={memberError}
                invitations={pendingProjectInvitations}
                action={action}
                onCancel={(invitation) => void cancelInvitation(invitation)}
              />
            ) : null}

            <InvitationSection
              status={invitationStatus}
              error={invitationError}
              invitations={pendingInvitations}
              action={action}
              onAccept={(invitation) => void accept(invitation)}
              onDecline={(invitation) => void decline(invitation)}
            />
          </div>
        )}

        {onComplete ? (
          <footer className="kc-collaboration-footer">
            <span><ShieldCheck aria-hidden="true" />共享写入保留版本冲突保护</span>
            <button type="button" className="kc-collaboration-close" onClick={onComplete}>完成</button>
          </footer>
        ) : null}
    </>
  );
}

function LoadingRow({ label }: { label: string }) {
  return <div className="kc-collaboration-loading"><LoaderCircle className="is-spinning" aria-hidden="true" /><span>{label}</span></div>;
}

function InvitationSection({
  status,
  error,
  invitations,
  action,
  onAccept,
  onDecline,
}: {
  status: LoadStatus;
  error: CanvasApiError | null;
  invitations: CloudProjectInvitation[];
  action: string | null;
  onAccept: (invitation: CloudProjectInvitation) => void;
  onDecline: (invitation: CloudProjectInvitation) => void;
}) {
  return (
    <section className="kc-collaboration-section">
      <div className="kc-collaboration-section-heading"><div><strong>待处理邀请</strong><small>{status === "loading" ? "正在同步" : `${invitations.length} 条`}</small></div><Clock3 aria-hidden="true" /></div>
      {status === "loading" ? <LoadingRow label="正在读取邀请" /> : null}
      {status === "error" ? <p className="kc-collaboration-inline-error">{collaborationApiMessage(error, "邀请列表读取失败")}</p> : null}
      {status === "ready" && invitations.length === 0 ? <p className="kc-collaboration-empty">暂无待处理邀请</p> : null}
      {invitations.map((invitation) => (
        <div className="kc-collaboration-invitation" key={invitation.id}>
          <span><strong>{invitation.projectId}</strong><small>{formatDate(invitation.expiresAt)} 前有效</small></span>
          <div className="kc-collaboration-invitation-actions">
            <button
              type="button"
              className="kc-collaboration-icon-button is-danger"
              aria-label={`拒绝项目 ${invitation.projectId} 的邀请`}
              title="拒绝邀请"
              disabled={action === `decline:${invitation.id}`}
              onClick={() => onDecline(invitation)}
            >
              {action === `decline:${invitation.id}` ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <X aria-hidden="true" />}
            </button>
            <button type="button" className="kc-collaboration-secondary" title="接受邀请" disabled={action === `accept:${invitation.id}`} onClick={() => onAccept(invitation)}>
              {action === `accept:${invitation.id}` ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Check aria-hidden="true" />}接受
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function ProjectInvitationSection({
  status,
  error,
  invitations,
  action,
  onCancel,
}: {
  status: LoadStatus;
  error: CanvasApiError | null;
  invitations: CloudProjectInvitation[];
  action: string | null;
  onCancel: (invitation: CloudProjectInvitation) => void;
}) {
  return (
    <section className="kc-collaboration-section">
      <div className="kc-collaboration-section-heading"><div><strong>已发送邀请</strong><small>{status === "loading" ? "正在同步" : `${invitations.length} 条`}</small></div><Clock3 aria-hidden="true" /></div>
      {status === "loading" ? <LoadingRow label="正在读取已发送邀请" /> : null}
      {status === "error" ? <p className="kc-collaboration-inline-error">{collaborationApiMessage(error, "已发送邀请读取失败")}</p> : null}
      {status === "ready" && invitations.length === 0 ? <p className="kc-collaboration-empty">暂无待接受邀请</p> : null}
      {invitations.map((invitation) => (
        <div className="kc-collaboration-invitation" key={invitation.id}>
          <span><strong>{invitation.inviteeId}</strong><small>{formatDate(invitation.expiresAt)} 前有效</small></span>
          <button
            type="button"
            className="kc-collaboration-icon-button is-danger"
            aria-label={`取消对 ${invitation.inviteeId} 的邀请`}
            title="取消邀请"
            disabled={action === `revoke:${invitation.id}`}
            onClick={() => onCancel(invitation)}
          >
            {action === `revoke:${invitation.id}` ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <X aria-hidden="true" />}
          </button>
        </div>
      ))}
    </section>
  );
}

function asApiError(cause: unknown) {
  return cause instanceof CanvasApiError ? cause : new CanvasApiError(0, "REQUEST_FAILED", "协作请求没有完成");
}

export function collaborationApiMessage(cause: unknown, fallback: string) {
  if (!(cause instanceof CanvasApiError)) return fallback;
  if (cause.code === "COLLABORATION_SEAT_LIMIT_REACHED") return COLLABORATION_SEAT_LIMIT_MESSAGE;
  return cause.message;
}

function formatDate(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "即将到期";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(timestamp);
}
