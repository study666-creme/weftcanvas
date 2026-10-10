import { expect, test } from "./zero-cost-test";
const projectId = "media-dimensions-project";

test("known and unknown server media dimensions resize legacy image and video nodes and survive refresh", async ({ page }) => {
  const timestamp = Date.now();
  const portraitVideo = Buffer.from(await createPortraitVideo(page));
  const portraitSvg = Buffer.from([
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="480" viewBox="0 0 240 480">',
    '<rect width="240" height="480" fill="#1d4ed8"/>',
    "</svg>",
  ].join(""));

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.route("**/api/v1/media/portrait-server-media/content", (route) => route.fulfill({
    body: portraitSvg,
    contentType: "image/svg+xml",
  }));
  await page.route("**/api/v1/media/video-server-media/content", (route) => route.fulfill({
    body: portraitVideo,
    contentType: "video/webm",
  }));
  await page.addInitScript(({ projectId, timestamp, videoSize }) => {
    localStorage.clear();
    const generation = {
      modelId: null,
      parameters: {},
      maxOutputTokens: null,
      jobId: null,
      jobVersion: null,
      jobCreatedAt: null,
      jobStatus: null,
      error: null,
    };
    localStorage.setItem("kachang-canvas:project:v1", JSON.stringify({
      schemaVersion: 1,
      id: projectId,
      name: "Media dimensions",
      nodes: [{
        id: "portrait-node",
        type: "kachang",
        position: { x: 120, y: 160 },
        width: 340,
        height: 214,
        data: {
          kind: "image",
          body: "",
          accent: "blue",
          status: "success",
          progress: null,
          media: {
            id: "portrait-server-media",
            name: "portrait.svg",
            mimeType: "image/svg+xml",
            size: 100,
            source: "server",
            serverId: "portrait-server-media",
            width: 240,
            height: 480,
            durationMs: null,
          },
          directorCapture: null,
          generation,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      }, {
        id: "video-node",
        type: "kachang",
        position: { x: 520, y: 160 },
        width: 340,
        height: 192,
        data: {
          kind: "video",
          body: "",
          accent: "coral",
          status: "success",
          progress: null,
          media: {
            id: "video-server-media",
            name: "portrait.webm",
            mimeType: "video/webm",
            size: videoSize,
            source: "server",
            serverId: "video-server-media",
            width: null,
            height: null,
            durationMs: null,
          },
          directorCapture: null,
          generation,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      }],
      edges: [],
      groups: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  }, { projectId, timestamp, videoSize: portraitVideo.length });

  await page.goto("/");
  const imageNode = page.locator('.react-flow__node-kachang[data-id="portrait-node"]');
  const videoNode = page.locator('.react-flow__node-kachang[data-id="video-node"]');
  await expect(imageNode.locator("img")).toBeVisible();
  await expect(videoNode.locator(".kc-video-playback")).toBeVisible();

  await expect.poll(() => savedMediaState(page)).toEqual({
    image: { mediaWidth: 240, mediaHeight: 480, nodeWidth: 200, nodeHeight: 400 },
    video: { mediaWidth: 54, mediaHeight: 96, nodeWidth: 225, nodeHeight: 400 },
  });

  const imageBox = await imageNode.boundingBox();
  expect(imageBox).not.toBeNull();
  expect(imageBox!.height).toBeGreaterThan(imageBox!.width * 1.9);

  await page.reload();
  await expect(imageNode.locator("img")).toBeVisible();
  await expect(videoNode.locator(".kc-video-playback")).toBeVisible();
  await expect.poll(() => savedMediaState(page)).toEqual({
    image: { mediaWidth: 240, mediaHeight: 480, nodeWidth: 200, nodeHeight: 400 },
    video: { mediaWidth: 54, mediaHeight: 96, nodeWidth: 225, nodeHeight: 400 },
  });
});

async function savedMediaState(page: import("@playwright/test").Page) {
  return page.evaluate((projectId) => {
    const raw = localStorage.getItem(`kachang-canvas:project-data:v1:${encodeURIComponent(projectId)}`);
    if (!raw) return null;
    const project = JSON.parse(raw) as {
      nodes: Array<{
        id: string;
        width?: number;
        height?: number;
        data: { media: { width: number | null; height: number | null } | null };
      }>;
    };
    const image = project.nodes.find((node) => node.id === "portrait-node");
    const video = project.nodes.find((node) => node.id === "video-node");
    return {
      image: {
        mediaWidth: image?.data.media?.width ?? 0,
        mediaHeight: image?.data.media?.height ?? 0,
        nodeWidth: image?.width ?? 0,
        nodeHeight: image?.height ?? 0,
      },
      video: {
        mediaWidth: video?.data.media?.width ?? 0,
        mediaHeight: video?.data.media?.height ?? 0,
        nodeWidth: video?.width ?? 0,
        nodeHeight: video?.height ?? 0,
      },
    };
  }, projectId);
}

async function createPortraitVideo(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 54;
    canvas.height = 96;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context unavailable");
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.start();
    for (let frame = 0; frame < 8; frame += 1) {
      context.fillStyle = frame % 2 ? "#ef4444" : "#2563eb";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    return [...new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer())];
  });
}
