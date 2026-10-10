/**
 * 登录页背景视频清单。
 *
 * 由 stills 引擎离线逐帧渲染 206s 全片（scripts/capture-auth-film.mjs 采集），
 * 再按章节切段、段尾 2s 与段头交叉淡化烘焙成无缝自循环
 * （scripts/encode-auth-film.mjs 编码，VP9 WebM + H.264 MP4 双份）。
 *
 * 会话开始时随机挑一段、段内随机时间起播；一段播完再随机切到另一段
 * （同一段不连续重复），还原原程序化电影「每章随机开场」的观感，
 * 但播放走硬件解码，GPU 占用与实时 raymarch 不在一个量级。
 *
 * seconds 必须与编码输出的实际时长一致（切段脚本的同源常量）；
 * 更新切片边界后两处要一起改。
 *
 * poster 是各段的代表帧（~30-50KB webp）：登录页先显示它保证首屏不为黑，
 * 视频在其上慢慢加载、就绪后再淡入。
 */
export const AUTH_FILM_SEGMENTS = [
  { src: "/film/auth-film-blackhole", poster: "/film/auth-film-poster-blackhole.webp", seconds: 50 },
  { src: "/film/auth-film-docking", poster: "/film/auth-film-poster-docking.webp", seconds: 40 },
  { src: "/film/auth-film-ocean", poster: "/film/auth-film-poster-ocean.webp", seconds: 57 },
  { src: "/film/auth-film-wormhole", poster: "/film/auth-film-poster-wormhole.webp", seconds: 38 },
] as const;

/** 段头/段尾各留出的安全区：避开烘焙接缝的交叉淡化带。 */
const SEAM_GUARD_SECONDS = 2.5;

/**
 * 随机取一段素材的起播点。`excludeSrc` 时避开指定段（用于「播完换一段」），
 * 只有一段可挑时退化为该段自己——换段是锦上添花，不能挑不出素材。
 */
export function pickRandomAuthFilmSegment(excludeSrc?: string): { src: string; poster: string; startAt: number } | null {
  if (!AUTH_FILM_SEGMENTS.length) return null;
  const pool = AUTH_FILM_SEGMENTS.filter((segment) => segment.src !== excludeSrc);
  const segment = (pool.length ? pool : AUTH_FILM_SEGMENTS)[Math.floor(Math.random() * (pool.length || AUTH_FILM_SEGMENTS.length))]!;
  const freeWindow = Math.max(0, segment.seconds - SEAM_GUARD_SECONDS * 2);
  return { src: segment.src, poster: segment.poster, startAt: SEAM_GUARD_SECONDS + Math.random() * freeWindow };
}
