import { describe, expect, it } from "vitest";

import { computeHoverPreviewPlacement } from "../lib/hover-preview-placement";
import {
  HOVER_PREVIEW_APPEAR_DELAY_MS,
  pickHoverPreviewImage,
  readHoverPreviewCache,
  rememberHoverPreviewImage,
} from "./card-hover-preview";

describe("hover preview image pick", () => {
  it("prefers the resolved large image while it has not failed to load", () => {
    expect(pickHoverPreviewImage("https://media/full.png", false, "https://media/thumb.png")).toBe("https://media/full.png");
  });

  it("falls back to the grid thumbnail when the large image is missing or broken", () => {
    expect(pickHoverPreviewImage("", false, "https://media/thumb.png")).toBe("https://media/thumb.png");
    expect(pickHoverPreviewImage("https://media/full.png", true, "https://media/thumb.png")).toBe("https://media/thumb.png");
    expect(pickHoverPreviewImage("", true, "")).toBe("");
  });
});

describe("hover preview resolved-image cache", () => {
  it("replays the resolved url for the same card without resolving again", () => {
    rememberHoverPreviewImage("cache-hit-card", "https://media/full.png");
    expect(readHoverPreviewCache("cache-hit-card")).toBe("https://media/full.png");
    expect(readHoverPreviewCache("cache-miss-card")).toBe("");
  });

  it("keeps the cache bounded by dropping the oldest entries first", () => {
    rememberHoverPreviewImage("cache-limit-first", "https://media/first.png");
    for (let index = 0; index < 64; index++) {
      rememberHoverPreviewImage(`cache-limit-fill-${index}`, `https://media/fill-${index}.png`);
    }
    expect(readHoverPreviewCache("cache-limit-first")).toBe("");
    expect(readHoverPreviewCache("cache-limit-fill-63")).toBe("https://media/fill-63.png");
  });

  it("keeps the appear delay small enough that sweeping the grid does not lag", () => {
    expect(HOVER_PREVIEW_APPEAR_DELAY_MS).toBeLessThanOrEqual(200);
  });
});

describe("hover preview placement", () => {
  const desktop = { width: 1600, height: 900 };

  it("sits to the right of the cursor, centred on it", () => {
    const placement = computeHoverPreviewPlacement({
      anchor: { x: 800, y: 450 },
      viewport: desktop,
      aspect: 1,
      hasCaption: false,
    });
    expect(placement.left).toBe(816);
    expect(placement.top).toBe(220);
    expect(placement.width).toBe(460);
    // 方形卡片、无标题时浮层高度等于宽度，垂直中心正好落在鼠标上。
    expect(placement.top + placement.width / 2).toBe(450);
  });

  it("flips to the left side when there is no room on the right", () => {
    const placement = computeHoverPreviewPlacement({
      anchor: { x: 1500, y: 450 },
      viewport: desktop,
      aspect: 1,
      hasCaption: false,
    });
    expect(placement.left).toBe(1024);
    expect(placement.left + placement.width).toBeLessThanOrEqual(desktop.width - 12);
  });

  it("shrinks a tall image so the whole thing stays on screen", () => {
    const placement = computeHoverPreviewPlacement({
      anchor: { x: 300, y: 400 },
      viewport: { width: 1400, height: 800 },
      // 宽高比 0.4：典型的竖版长图。
      aspect: 0.4,
      hasCaption: false,
    });
    expect(placement.maxHeight).toBe(656);
    expect(placement.width).toBe(276);
    expect(placement.top).toBe(72);
    // 底边必须留在视口内 —— 这正是原来"一半掉到浏览器外面"的地方。
    expect(placement.top + placement.height).toBeLessThanOrEqual(800 - 12);
  });

  it("caps wide images instead of letting them grow with the cursor position", () => {
    const placement = computeHoverPreviewPlacement({
      anchor: { x: 500, y: 500 },
      viewport: { width: 2000, height: 1000 },
      aspect: 3,
      hasCaption: false,
    });
    expect(placement.width).toBe(460);
    expect(placement.left).toBe(516);
    expect(placement.top).toBe(416);
  });

  it("pulls the box back up near the bottom edge", () => {
    const placement = computeHoverPreviewPlacement({
      anchor: { x: 800, y: 890 },
      viewport: desktop,
      aspect: 1,
      hasCaption: false,
    });
    expect(placement.top).toBe(428);
    expect(placement.top + placement.height).toBeLessThanOrEqual(desktop.height - 12);
  });

  it("leaves room for the caption when the card has a title", () => {
    const placement = computeHoverPreviewPlacement({
      anchor: { x: 800, y: 450 },
      viewport: desktop,
      aspect: 1,
      hasCaption: true,
    });
    expect(placement.top).toBe(205);
    expect(placement.maxHeight).toBe(738);
  });

  it("never places the box outside the viewport", () => {
    for (const [width, height] of [[1600, 900], [1280, 720], [900, 1400]] as const) {
      for (const x of [0, 12, width / 2, width - 12, width]) {
        for (const y of [0, 12, height / 2, height - 12, height]) {
          for (const aspect of [0.3, 0.75, 1, 2.4]) {
            const placement = computeHoverPreviewPlacement({ anchor: { x, y }, viewport: { width, height }, aspect, hasCaption: true });
            expect(placement.left).toBeGreaterThanOrEqual(12);
            expect(placement.top).toBeGreaterThanOrEqual(12);
            expect(placement.left + placement.width).toBeLessThanOrEqual(width - 12);
            expect(placement.top + placement.height).toBeLessThanOrEqual(height - 12);
            expect(placement.height).toBeLessThanOrEqual(placement.maxHeight);
          }
        }
      }
    }
  });
});
