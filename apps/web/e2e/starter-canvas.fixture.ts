import type { Page } from "@playwright/test";

/**
 * Seeds the classic three-node starter canvas (text + config + image with two
 * edges) that the app stopped auto-creating in 2026-08-15 (empty canvas
 * release). Specs written against that starter graph call this fixture before
 * navigating to /canvas; new empty-canvas behavior is covered by
 * empty-canvas.spec.ts.
 */
export async function seedStarterCanvas(page: Page) {
  const now = Date.now();
  const generation = () => ({
    modelId: null,
    parameters: {},
    maxOutputTokens: null,
    referenceMode: "auto",
    referenceNodeIds: [],
    jobId: null,
    jobVersion: null,
    jobCreatedAt: null,
    jobStatus: null,
    error: null,
  });
  const node = (
    id: string,
    kind: "text" | "config" | "image",
    x: number,
    y: number,
    width: number,
    height: number,
    body: string,
    accent: string,
    config: { modality: "image" } | null,
  ) => ({
    id,
    type: "weftcanvas",
    position: { x, y },
    width,
    height,
    selected: false,
    data: {
      kind,
      body,
      accent,
      status: "idle",
      progress: null,
      media: null,
      directorCapture: null,
      config,
      generation: generation(),
      createdAt: now,
      updatedAt: now,
    },
  });
  const project = {
    schemaVersion: 1,
    id: "e2e-starter-canvas",
    name: "纬线 1",
    nodes: [
      node(
        "starter-text",
        "text",
        40,
        40,
        308,
        176,
        "低机位跟拍，湿润石板路反射零散霓虹。人物从画面右侧冲入，急促回头，远处渡轮鸣笛。",
        "jade",
        null,
      ),
      node("starter-config", "config", 40, 260, 308, 176, "", "jade", { modality: "image" }),
      node("starter-image", "image", 440, 42, 340, 214, "16:9 · 冷雨夜 · 暖色实景光", "blue", null),
    ],
    edges: [
      { id: "starter-edge-text", source: "starter-text", target: "starter-image" },
      { id: "starter-edge-config", source: "starter-config", target: "starter-image" },
    ],
    groups: [],
    // Historical createStarterViewport() geometry (removed with the empty
    // canvas release): zoom 0.9, y 138, x centered on the 1108-wide graph.
    // The empty-project viewport (center of screen, zoom 0.7) would push the
    // image node off-screen at 1024px or when node creation recenters the
    // viewport, and onlyRenderVisibleElements then unmounts it.
    viewport: null,
    createdAt: now,
    updatedAt: now,
  };
  await page.addInitScript((seed) => {
    if (sessionStorage.getItem("weftcanvas-e2e-starter-seeded")) return;
    sessionStorage.setItem("weftcanvas-e2e-starter-seeded", "1");
    const width = window.innerWidth;
    const zoom = 0.9;
    const graphLeft = 40;
    const graphWidth = 1108;
    const centeredX = (width - graphWidth * zoom) / 2 - graphLeft * zoom;
    const viewport = { x: Math.max(96, Math.round(centeredX)), y: 138, zoom };
    localStorage.setItem(
      `weftcanvas:project-data:v1:${encodeURIComponent(seed.id)}`,
      JSON.stringify({ ...seed, viewport }),
    );
    localStorage.setItem(
      "weftcanvas:projects:v1",
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: seed.id,
            name: seed.name,
            createdAt: seed.createdAt,
            updatedAt: seed.updatedAt,
            nodeCount: seed.nodes.length,
          },
        ],
      }),
    );
    localStorage.setItem("weftcanvas:active-project:v1", seed.id);
  }, project);
}
