// 登录页电影的离线采集入口（仅 dev 采集用，不在产品路由中）。
// Playwright 采集脚本（scripts/capture-auth-film.mjs）驱动本页：
// 等待 __filmReady 后逐帧调用 __film.renderAt(秒) 并截图。
import { createInterstellarFilm, FILM_DURATION } from "./interstellar-film";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const film = createInterstellarFilm(canvas, { stills: true });

if (!film?.renderAt || !film.ready) {
  document.title = "capture-failed";
  throw new Error("stills engine unavailable");
}

const api = {
  duration: FILM_DURATION,
  renderAt: (seconds: number) => {
    const result = film.renderAt!(seconds);
    (window as unknown as { __lastRender: unknown }).__lastRender = result;
    return result !== null;
  },
  diagnostics: () => ({
    title: document.title,
    bufferWidth: canvas.width,
    bufferHeight: canvas.height,
    cssWidth: canvas.clientWidth,
    cssHeight: canvas.clientHeight,
    hostWidth: canvas.parentElement?.clientWidth ?? -1,
    hostHeight: canvas.parentElement?.clientHeight ?? -1,
  }),
};
(film.ready as Promise<void>).then(() => {
  (window as unknown as { __filmReady: boolean }).__filmReady = true;
});
(window as unknown as { __film: typeof api }).__film = api;
