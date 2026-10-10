/**
 * Production-shaped, zero-network hosted provider response fixtures used to
 * prove the exact terminal normalization boundary. These are public API shapes
 * (APIMart unified task responses, MJ-style SUCCESS/FAILURE task responses,
 * and the nested Prompt Hub envelope the current contract accepts). They carry
 * no user prompt, no private media, no credential, and no real task id.
 */

export const apimartUnifiedRunningTask = {
  id: "apimart-task-unified-running",
  status: "processing",
  progress: 42,
};

export const apimartUnifiedSuccessTask = {
  id: "apimart-task-unified-success",
  status: "completed",
  progress: 100,
  result: {
    images: [
      { url: "https://cdn.example/results/unified-1.png" },
      { url: "https://cdn.example/results/unified-2.png" },
    ],
  },
};

export const apimartMjStyleSuccessTask = {
  taskId: "apimart-task-mj-success",
  status: "SUCCESS",
  progress: 100,
  grid_image_url: "https://cdn.example/results/mj-grid.png",
  image_urls: [
    "https://cdn.example/results/mj-1.png",
    "https://cdn.example/results/mj-2.png",
    "https://cdn.example/results/mj-3.png",
    "https://cdn.example/results/mj-4.png",
  ],
};

export const apimartUnifiedFailedTask = {
  id: "apimart-task-unified-failed",
  status: "failed",
  progress: 100,
  fail_reason: "内容策略拒绝该请求",
};

export const apimartMalformedCompletedTask = {
  id: "apimart-task-malformed-completed",
  status: "completed",
  progress: 100,
  result: {},
};

export const promptHubNestedEnvelopeTask = {
  ok: true,
  data: {
    jobId: "ph-job-envelope-1",
    status: "completed",
    progress: 100,
    image_urls: ["https://cdn.example/results/ph-1.png"],
  },
};
