const BUILD_META_NAME = "kachang-canvas-build";
const RELEASE_CHECK_PATH = "/canvas";
const RELEASE_CHECK_TIMEOUT_MS = 8_000;
const RELEASE_CHECK_MIN_GAP_MS = 15_000;
const LONG_BLUR_MS = 30_000;

export function hasCanvasBuildChanged(currentBuildId: string, availableBuildId: string | null) {
  return Boolean(availableBuildId && availableBuildId !== currentBuildId);
}

export function readCanvasBuildId(html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return parsed.querySelector<HTMLMetaElement>(`meta[name="${BUILD_META_NAME}"]`)?.content.trim() || null;
}

export async function isNewCanvasReleaseAvailable(
  currentBuildId = __KACHANG_CANVAS_BUILD_ID__,
  fetchHtml: typeof window.fetch = window.fetch.bind(window),
) {
  const requestUrl = new URL(RELEASE_CHECK_PATH, window.location.origin);
  requestUrl.searchParams.set("__kc_release_check", Date.now().toString(36));
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), RELEASE_CHECK_TIMEOUT_MS);

  try {
    const response = await fetchHtml(requestUrl, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "text/html" },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    return hasCanvasBuildChanged(currentBuildId, readCanvasBuildId(await response.text()));
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function installCanvasReleaseFreshnessGuard() {
  let checking = false;
  let stale = false;
  let reloading = false;
  let lastCheckAt = 0;
  let blurredAt = 0;

  const reloadWhenVisible = () => {
    if (!stale || reloading || document.visibilityState !== "visible") return;
    reloading = true;
    window.location.reload();
  };

  const check = (force = false) => {
    if (checking || reloading || document.visibilityState !== "visible") return;
    if (stale) {
      reloadWhenVisible();
      return;
    }
    const now = Date.now();
    if (!force && now - lastCheckAt < RELEASE_CHECK_MIN_GAP_MS) return;
    lastCheckAt = now;
    checking = true;
    void isNewCanvasReleaseAvailable()
      .then((available) => {
        stale = available;
        reloadWhenVisible();
      })
      .finally(() => {
        checking = false;
      });
  };

  const checkWhenVisible = () => {
    if (document.visibilityState === "visible") check(true);
  };
  const markBlurred = () => {
    blurredAt = Date.now();
  };
  const checkAfterLongBlur = () => {
    if (blurredAt && Date.now() - blurredAt >= LONG_BLUR_MS) check(true);
    blurredAt = 0;
  };
  const checkRestoredPage = (event: PageTransitionEvent) => {
    if (event.persisted) check(true);
  };

  const initialCheckId = window.setTimeout(() => check(), RELEASE_CHECK_MIN_GAP_MS);
  window.addEventListener("blur", markBlurred);
  window.addEventListener("focus", checkAfterLongBlur);
  window.addEventListener("pageshow", checkRestoredPage);
  document.addEventListener("visibilitychange", checkWhenVisible);

  return () => {
    window.clearTimeout(initialCheckId);
    window.removeEventListener("blur", markBlurred);
    window.removeEventListener("focus", checkAfterLongBlur);
    window.removeEventListener("pageshow", checkRestoredPage);
    document.removeEventListener("visibilitychange", checkWhenVisible);
  };
}
