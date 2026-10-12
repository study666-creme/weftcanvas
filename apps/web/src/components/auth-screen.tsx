import {
  AlertCircle,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  ExternalLink,
  FlaskConical,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mail,
  UserRoundPen,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type SyntheticEvent,
} from "react";

import "./auth-screen.css";
import { DEV_TEST_ACCOUNT_EMAIL, DEV_TEST_ACCOUNT_PASSWORD } from "@weftcanvas/contracts";
import type { InterstellarChapter, InterstellarFilm } from "../lib/interstellar-film";
import { pickRandomAuthFilmSegment } from "../lib/auth-film-background";
import { checkIdentityForm } from "../lib/identity-form";
import { useIdentityStore } from "../state/identity-store";

// Remembered credentials live only in this browser's localStorage, lightly
// obfuscated (base64) so they are not sitting in plain text; the user opts in
// explicitly via the checkbox. Session expiry then costs a single click.
const REMEMBER_KEY = "weftcanvas:remembered-credentials";

/** 背景视频格式降级链：VP9（Chromium/Firefox）→ H.264（Safari/兜底解码）。 */
const VIDEO_FORMATS = ["webm", "mp4"] as const;

function loadRememberedCredentials(): { email: string; password: string } | null {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(decodeURIComponent(escape(atob(raw))));
    if (typeof parsed?.email === "string" && typeof parsed?.password === "string" && parsed.email) {
      return { email: parsed.email, password: parsed.password };
    }
  } catch {
    // Corrupted or unreadable payload: treat as "nothing remembered".
  }
  return null;
}

function saveRememberedCredentials(email: string, password: string) {
  try {
    localStorage.setItem(
      REMEMBER_KEY,
      btoa(unescape(encodeURIComponent(JSON.stringify({ email, password })))),
    );
  } catch {
    // Storage unavailable (private mode): remembering silently does nothing.
  }
}

function clearRememberedCredentials() {
  try {
    localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // Ignore.
  }
}

/**
 * Full-screen auth experience: the auth form floats on a deep-space gradient.
 * 默认播放预渲染的「星际穿越」章节背景视频（随机段 + 随机起播，无缝循环）；
 * `?film=1` 预览原程序化 WebGL 电影引擎（实时 raymarch，dev 用）；
 * 减动效/省流/加载失败回退纯 CSS 静态背景。
 *
 * `mandatory`（首屏登录页）：登录页作为独立页面渲染时使用——直接展示登录/注册
 * 表单，表单下方提供与登录同权重的「游客访问」按钮：免登录进入首屏落地页
 * （本地项目 + BYOK），不要求凭据。账号层弹窗（非闸门）同样直接展示表单；
 * 渲染与进入逻辑见 App.tsx。
 */
export function AuthScreen({
  mandatory = false,
  onStart,
  onGuest,
}: {
  mandatory?: boolean;
  onStart?: () => void;
  onGuest?: () => void;
}) {
  const status = useIdentityStore((state) => state.status);
  const capabilities = useIdentityStore((state) => state.capabilities);
  const mode = useIdentityStore((state) => state.mode);
  const busy = useIdentityStore((state) => state.busy);
  const identityError = useIdentityStore((state) => state.error);
  const verificationEmail = useIdentityStore((state) => state.verificationEmail);
  const close = useIdentityStore((state) => state.closeDialog);
  const setMode = useIdentityStore((state) => state.setMode);
  const login = useIdentityStore((state) => state.login);
  const register = useIdentityStore((state) => state.register);
  const hydrate = useIdentityStore((state) => state.hydrate);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 登录页背景三层降级（首屏流畅优先）：
  // 1. 默认 —— 预渲染背景视频：随机挑一段章节文件、段内随机时间起播，播完
  //    再随机切到另一段（onEnded → pickRandomAuthFilmSegment(currentSrc)）。
  //    硬件解码的 GPU 开销与实时 raymarch 不在一个量级，弱机也不卡；
  // 2. ?film=1 —— 程序化 WebGL「星际」电影（dev 预览用）；
  // 3. 减动效 / 省流 / 视频加载失败 —— 纯 CSS 深空渐变，无需任何媒体。
  const [videoSource, setVideoSource] = useState<{
    src: string;
    poster: string;
    startAt: number;
  } | null>(null);
  // 代表帧海报层：视频 canplay 前先显示当段静态帧，登录页首屏不再是纯深空渐变
  // （弱网下此前是数秒黑屏）。减动效/省流/视频失败时也保留这一层静态背景。
  const [posterSource, setPosterSource] = useState<string | null>(null);
  const [loadedPoster, setLoadedPoster] = useState<string | null>(null);
  const [videoFormatIndex, setVideoFormatIndex] = useState(0);
  const [videoReady, setVideoReady] = useState(false);
  // 换段过渡：旧段淡出、新段淡入，避免同一元素换 src 时的生硬黑场。
  const [switching, setSwitching] = useState(false);
  const [switchToken, setSwitchToken] = useState(0);
  const [filmLabels, setFilmLabels] = useState<readonly string[] | null>(null);
  const [chapter, setChapter] = useState<InterstellarChapter>(0);
  // 只有 ?film=1 才启动程序化 WebGL 影片（dev 预览）；默认走预渲染视频。
  const filmPreview = new URLSearchParams(window.location.search).get("film") === "1";

  const effectiveMode = capabilities.registration === "native" ? mode : "login";

  const remembered = useRef(loadRememberedCredentials());
  const [email, setEmail] = useState(remembered.current?.email ?? "");
  const [password, setPassword] = useState(remembered.current?.password ?? "");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [remember, setRemember] = useState(() => remembered.current !== null);

  // 默认视频背景：随机段 + 随机起播点。仅在能力允许时挂载；
  // 失败按格式链降级（webm 解码失败 → mp4 → 静态渐变），登录页不跟弱网较劲。
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("film") === "1") return;
    // 海报任何背景模式下都给（静态图不违背减动效/省流）：先有画面，再谈播放。
    setPosterSource(pickRandomAuthFilmSegment()?.poster ?? null);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } })
      .connection;
    if (connection?.saveData) return;
    setVideoSource(pickRandomAuthFilmSegment());
    setSwitchToken(1);
  }, []);

  //  Random in-segment start position.
  //
  //  Must be applied at a point where the browser actually accepts it:
  //  `loadedmetadata` fires before any range is fetchable, so a seek issued
  //  there is silently dropped and the film starts at 0 (that was the exact
  //  production symptom — every visit opened on the chapter's first frame,
  //  even though the deployed code requested a random offset). Waiting for a
  //  data event and confirming the frame landed keeps it robust against
  //  environments whose asset host does not serve byte ranges.
  const seekRetriesRef = useRef(0);
  const seekToStart = (event: { currentTarget: HTMLVideoElement }) => {
    const video = event.currentTarget;
    const target = videoSource?.startAt;
    if (target === undefined) return;
    seekRetriesRef.current = 0;
    trySeek(video, target);
  };

  const trySeek = (video: HTMLVideoElement, target: number, attempt = 0) => {
    const seekable = video.seekable;
    const withinSeekable = seekable.length > 0 && target <= seekable.end(seekable.length - 1) + 0.5;
    if (withinSeekable || video.readyState >= 2) {
      video.currentTime = target;
      // 确认是否真的落在目标附近；没落上说明该资源不可 seek，再试一次，
      // 仍失败就接受段头播放（至少画面在动），不做无限重试。
      if (Math.abs(video.currentTime - target) < 0.75 || seekRetriesRef.current >= 3) return;
      seekRetriesRef.current += 1;
      window.setTimeout(() => trySeek(video, target, attempt + 1), 120);
      return;
    }
    if (attempt < 8) window.setTimeout(() => trySeek(video, target, attempt + 1), 100);
  };

  // 影片「可以看了」的统一信号。不能只认 canplay：元素换 key 重挂载、素材命中
  // 缓存时，canplay 都可能早于监听挂上或在切换窗口里被错过——那样 is-film 永远
  // 不生效，视频停在 opacity:0，用户只看到静态海报（就是「动画不动」）。
  // loadeddata / canplay / playing 任一到达即点亮，并显式 play() 兜底被后台
  // 节流或延后的自动播放。
  const markFilmReady = useCallback((video: HTMLVideoElement | null) => {
    if (!video || video.readyState < 2) return;
    setVideoReady(true);
    setSwitching(false);
    void video.play().catch(() => undefined);
  }, []);
  const onFilmReady = (event: SyntheticEvent<HTMLVideoElement>) =>
    markFilmReady(event.currentTarget);

  // 播放恢复与看门狗：muted 自动播放会被个别环境（内嵌 webview、宿主焦点管理、
  // 后台节流）拦下或中途暂停，页面回焦/首次交互时补一次 play()；另加一个低频
  // 心跳，覆盖「事件都到齐了但引擎没真的开动」的静默卡帧，以及元素挂载时已
  // 缓存就绪、三个事件都不会再补发的情况。
  useEffect(() => {
    if (!videoSource) return;
    const currentVideo = () => document.querySelector<HTMLVideoElement>("video.wc-auth-film");
    const resume = () => {
      const video = currentVideo();
      if (video && video.paused && video.readyState >= 2 && !video.ended) {
        void video.play().catch(() => undefined);
      }
      markFilmReady(video);
    };
    resume();
    const heartbeat = window.setInterval(() => {
      if (document.hidden) return;
      markFilmReady(currentVideo());
    }, 2500);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pointerdown", resume, { passive: true });
    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pointerdown", resume);
    };
  }, [videoSource, videoFormatIndex, switchToken, markFilmReady]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("film") !== "1") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let destroyed = false;
    let active: InterstellarFilm | null = null;
    void import("../lib/interstellar-film").then(
      ({ createInterstellarFilm, FILM_CHAPTER_LABELS }) => {
        if (destroyed) return;
        const created = createInterstellarFilm(canvas);
        if (!created) return;
        active = created;
        setFilmLabels(FILM_CHAPTER_LABELS);
        created.onChapter((next) => setChapter(next));
      },
    );
    return () => {
      destroyed = true;
      active?.destroy();
    };
  }, []);

  const submitIdentity = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const check = checkIdentityForm({
      mode: effectiveMode,
      email,
      password,
      confirmPassword,
      displayName,
      devTestAccount: Boolean(capabilities.devTestAccount),
    });
    if (!check.ok) {
      setFormError(check.message);
      return;
    }
    const completed =
      effectiveMode === "login"
        ? await login(check.email, password)
        : await register(check.email, password, check.displayName);
    if (completed) {
      if (effectiveMode === "login") {
        if (remember && check.email && password) saveRememberedCredentials(check.email, password);
        else clearRememberedCredentials();
      }
      setPassword("");
      setConfirmPassword("");
      setDisplayName("");
    }
  };

  // 生效中的代表帧：视频路径跟随当前段（换段时同步换，垫在新视频下面），
  // 减动效/省流/视频加载失败时退回随机段的静态帧，页面始终有画面。
  const activePoster = videoSource?.poster ?? posterSource;

  return (
    <div
      className={`wc-auth-screen ${videoReady || filmLabels ? "is-film" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="登录纬线画布"
    >
      {activePoster ? (
        <img
          key={activePoster}
          className={`wc-auth-film-poster ${loadedPoster === activePoster ? "is-loaded" : ""}`}
          src={activePoster}
          alt=""
          aria-hidden="true"
          decoding="async"
          fetchPriority="high"
          onLoad={() => setLoadedPoster(activePoster)}
        />
      ) : null}
      {(() => {
        if (!videoSource) {
          // 只有 ?film=1 才渲染 canvas（WebGL 预览由下面的 effect 启动）；否则这里
          // 渲染一个没人绘制的 canvas 等于给页面留一层静态黑幕——两种视频格式都
          // 失败之后，用户会以为画面卡住了。
          return filmPreview ? (
            <canvas ref={canvasRef} className="wc-auth-film" aria-hidden="true" />
          ) : null;
        }
        const extension = VIDEO_FORMATS[videoFormatIndex]!;
        const videoSrc = `${videoSource.src}.${extension}`;
        return (
          <video
            key={`${videoSrc}#${switchToken}`}
            ref={videoRef}
            className={`wc-auth-film ${switching ? "is-switching" : ""}`}
            src={videoSrc}
            muted
            playsInline
            autoPlay
            preload="auto"
            disablePictureInPicture
            aria-hidden="true"
            onLoadedMetadata={seekToStart}
            onLoadedData={onFilmReady}
            onCanPlay={onFilmReady}
            onPlaying={onFilmReady}
            onError={() => {
              // 注意：解码/播放期错误触发在 <video> 上（fetch/选源失败才落在
              // <source> 上），所以这里必须挂在 video 元素本身。webm 播放中途
              // 解码失败（个别内嵌/硬解环境）→ 换 mp4 → 仍失败回退静态渐变。
              if (videoFormatIndex + 1 < VIDEO_FORMATS.length) {
                setVideoFormatIndex(videoFormatIndex + 1);
                setVideoReady(false);
              } else {
                setVideoSource(null);
                setVideoReady(false);
              }
            }}
            onEnded={() => {
              // 一段播完 → 随机换另一段（不重复当前段）。换段会让元素换 key
              // 重挂载，这里先把旧段淡出，新段就绪后再淡入，见 is-switching。
              const current = videoSource?.src;
              setSwitching(true);
              setVideoReady(false);
              const next = pickRandomAuthFilmSegment(current);
              setVideoFormatIndex(0);
              setVideoSource(next);
            }}
          />
        );
      })()}
      <div className="wc-auth-veil" aria-hidden="true" />

      <header className="wc-auth-brand">
        <span className="wc-auth-brand-mark">
          <img src="/weftcanvas-logo-ui.webp" alt="" aria-hidden="true" />
        </span>
        <span className="wc-auth-brand-copy">
          <strong>纬线画布</strong>
          <small>Weftcanvas</small>
        </span>
      </header>

      {!mandatory ? (
        <button
          type="button"
          className="wc-auth-dismiss"
          aria-label="稍后再登录"
          title="稍后再说"
          onClick={close}
        >
          <X aria-hidden="true" />
          <span>稍后再说</span>
        </button>
      ) : null}

      {filmLabels ? (
        <div className="wc-auth-scene" aria-hidden="true">
          <span className="wc-auth-scene-label" key={chapter}>
            {filmLabels[chapter]}
          </span>
          <span className="wc-auth-scene-dots">
            {filmLabels.map((label, index) => (
              <i
                key={label}
                className={index === chapter ? "is-active" : undefined}
                title={label}
              />
            ))}
          </span>
        </div>
      ) : null}

      <main className="wc-auth-panel">
        <div className="wc-auth-intro">
          <span>{effectiveMode === "login" ? "欢迎回来" : "建立创作身份"}</span>
          <strong>{effectiveMode === "login" ? "登录你的创作空间" : "创建纬线账号"}</strong>
          <p>
            {effectiveMode === "login"
              ? "穿越星海，回到你的画布与资产。"
              : "你的画布会跟随账号持续保存。"}
          </p>
        </div>

        {capabilities.registration === "native" ? (
          <div className="wc-auth-tabs" role="tablist" aria-label="账号方式">
            <button
              type="button"
              role="tab"
              aria-selected={effectiveMode === "login"}
              onClick={() => {
                setFormError(null);
                setMode("login");
              }}
            >
              登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveMode === "register"}
              onClick={() => {
                setFormError(null);
                setMode("register");
              }}
            >
              注册
            </button>
          </div>
        ) : null}

        {/* 本地开发测试账号：只有 API 在非生产环境装配了测试通道
            （capabilities.devTestAccount）才会出现，线上不存在这个入口。 */}
        {capabilities.devTestAccount ? (
          <div className="wc-auth-dev-account">
            <FlaskConical aria-hidden="true" />
            <span>
              本地测试账号 {DEV_TEST_ACCOUNT_EMAIL} / {DEV_TEST_ACCOUNT_PASSWORD}
            </span>
            <button
              type="button"
              disabled={busy || status === "loading"}
              onClick={() => {
                setFormError(null);
                void login(DEV_TEST_ACCOUNT_EMAIL, DEV_TEST_ACCOUNT_PASSWORD);
              }}
            >
              {busy || status === "loading" ? (
                <LoaderCircle className="is-spinning" aria-hidden="true" />
              ) : (
                <ArrowRight aria-hidden="true" />
              )}
              一键登录
            </button>
          </div>
        ) : null}

        <form className="wc-auth-form" onSubmit={(event) => void submitIdentity(event)}>
          {effectiveMode === "register" ? (
            <label htmlFor="wc-auth-display-name">
              <span>昵称</span>
              <div className="wc-auth-input-shell">
                <UserRoundPen aria-hidden="true" />
                <input
                  id="wc-auth-display-name"
                  value={displayName}
                  maxLength={20}
                  autoComplete="nickname"
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                    setFormError(null);
                  }}
                  placeholder="选填，2-20 字"
                />
              </div>
            </label>
          ) : null}
          <label htmlFor="wc-auth-email">
            <span>邮箱</span>
            <div className="wc-auth-input-shell">
              <Mail aria-hidden="true" />
              {/* type=text + inputMode=email：不启用浏览器邮箱格式校验，
                  允许本地测试账号 admin（非邮箱格式）直接登录；线上只可能是邮箱，
                  格式检查在提交时按 contracts 的 schema 做。 */}
              <input
                id="wc-auth-email"
                type="text"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                maxLength={254}
                value={email}
                autoFocus
                autoComplete="email"
                onChange={(event) => {
                  setEmail(event.target.value);
                  setFormError(null);
                }}
                placeholder={capabilities.devTestAccount ? "账号或邮箱" : "邮箱地址"}
              />
            </div>
          </label>
          <label htmlFor="wc-auth-password">
            <span>密码</span>
            <div className="wc-auth-input-shell">
              <LockKeyhole aria-hidden="true" />
              <input
                id="wc-auth-password"
                aria-label="密码"
                type={showPassword ? "text" : "password"}
                required
                minLength={effectiveMode === "register" ? 10 : 1}
                maxLength={128}
                value={password}
                autoComplete={effectiveMode === "login" ? "current-password" : "new-password"}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setFormError(null);
                }}
                placeholder={effectiveMode === "register" ? "至少 10 位" : "请输入密码"}
              />
              <button
                type="button"
                className="wc-auth-password-toggle"
                aria-label={showPassword ? "隐藏输入内容" : "显示输入内容"}
                title={showPassword ? "隐藏密码" : "显示密码"}
                onClick={() => setShowPassword((visible) => !visible)}
              >
                {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </div>
          </label>
          {effectiveMode === "register" ? (
            <label htmlFor="wc-auth-password-confirm">
              <span>确认密码</span>
              <div className="wc-auth-input-shell">
                <LockKeyhole aria-hidden="true" />
                <input
                  id="wc-auth-password-confirm"
                  aria-label="确认密码"
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={10}
                  maxLength={128}
                  value={confirmPassword}
                  autoComplete="new-password"
                  onChange={(event) => {
                    setConfirmPassword(event.target.value);
                    setFormError(null);
                  }}
                  placeholder="再次输入密码"
                />
              </div>
            </label>
          ) : (
            <label className="wc-auth-remember" htmlFor="wc-auth-remember-check">
              <input
                id="wc-auth-remember-check"
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />
              <span className="wc-auth-remember-box" aria-hidden="true">
                <Check />
              </span>
              <span className="wc-auth-remember-text">
                <KeyRound aria-hidden="true" />
                记住账号密码，下次一键登录
              </span>
            </label>
          )}

          {verificationEmail ? (
            <div className="wc-auth-verification" role="status">
              <Check aria-hidden="true" />
              <span>注册已提交，请到 {verificationEmail} 查收验证邮件；验证后即可在这里登录。</span>
            </div>
          ) : null}
          {formError || identityError ? (
            <div className="wc-auth-error" role="alert">
              <AlertCircle aria-hidden="true" />
              {formError ?? identityError}
            </div>
          ) : null}

          <button
            type="submit"
            className="wc-auth-submit"
            disabled={busy || status === "loading" || capabilities.registration === "disabled"}
          >
            {busy || status === "loading" ? (
              <LoaderCircle className="is-spinning" aria-hidden="true" />
            ) : (
              <ArrowRight aria-hidden="true" />
            )}
            <span>{effectiveMode === "login" ? "进入画布" : "创建账号"}</span>
          </button>

          {capabilities.registration === "external" ? (
            <div className="wc-auth-external">
              <span>注册与密码找回在官网完成</span>
              <div>
                {capabilities.registrationUrl ? (
                  <a
                    className="wc-auth-link"
                    href={capabilities.registrationUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    注册账号
                    <ExternalLink aria-hidden="true" />
                  </a>
                ) : null}
                {capabilities.passwordResetUrl ? (
                  <a
                    className="wc-auth-link"
                    href={capabilities.passwordResetUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    找回密码
                    <ExternalLink aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            </div>
          ) : capabilities.registration === "disabled" ? (
            <p className="wc-auth-note">当前部署暂不开放注册，请使用已有账号登录。</p>
          ) : effectiveMode === "login" && capabilities.passwordResetUrl ? (
            <div className="wc-auth-external">
              <a
                className="wc-auth-link"
                href={capabilities.passwordResetUrl}
                target="_blank"
                rel="noreferrer"
              >
                忘记密码？
                <ExternalLink aria-hidden="true" />
              </a>
            </div>
          ) : null}
          {status === "unavailable" ? (
            <button
              type="button"
              className="wc-auth-retry"
              onClick={() => void hydrate(true)}
              disabled={busy}
            >
              重新连接账号服务
            </button>
          ) : null}
        </form>
        {mandatory ? (
          <button
            type="button"
            className="wc-auth-submit wc-auth-submit--guest"
            onClick={() => (onGuest ? onGuest() : onStart ? onStart() : close())}
          >
            <ArrowRight aria-hidden="true" />
            <span>游客访问，免登录进入</span>
          </button>
        ) : null}
      </main>
    </div>
  );
}
