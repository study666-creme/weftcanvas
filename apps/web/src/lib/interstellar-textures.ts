// Film textures for the immersive auth screen.
//
// These used to be embedded as base64 data URLs (~690KB) inside the JS bundle:
// the auth chunk paid the full download + parse cost before the login form
// could even mount, and the decode happened on the main thread. They are now
// plain files under public/film/ fetched only when the film actually starts,
// in parallel with mesh building, and cached by the browser/CDN.
//
// import.meta.url keeps the URL correct under any deploy base path (Vite
// rewrites asset references at build time; a runtime-relative URL survives
// subdirectory hosting where a hard-coded "/film/..." would 404).

export const SKY_DATA = new URL("../../public/film/sky.webp", import.meta.url).href;
export const NOISE_DATA = new URL("../../public/film/noise.webp", import.meta.url).href;
