import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NodeLoadingState } from "./node-loading-state";

describe("node loading state", () => {
  it("uses a text-free cinematic treatment for media generation", () => {
    const markup = renderToStaticMarkup(
      <NodeLoadingState variant="video" activity="generation" status="queued" progress={12} />,
    );

    expect(markup).toContain('data-loading-activity="generation"');
    expect(markup).toContain('data-generation-stage="queued"');
    expect(markup).toContain('aria-label="');
    expect(markup).toContain("--kc-generation-progress:12%");
    expect(markup).toContain("--kc-generation-progress-scale:0.12");
    expect(markup).toContain("--kc-video-generation-field-opacity:0.68");
    expect(markup).toContain("--kc-video-generation-sweep-opacity:0.86");
    expect(markup).toContain("--kc-video-generation-glint-opacity:0.72");
    expect(markup).toContain("kc-node-loading--cinematic");
    expect(markup).toContain("kc-video-generation-scene");
    expect(markup).toContain("kc-video-generation-field");
    expect(markup).toContain("kc-video-generation-sweep");
    expect(markup).toContain("kc-video-generation-glint");
    expect(markup).toContain("kc-video-generation-scan");
    expect(markup).toContain("kc-video-generation-rail");
    expect(markup).not.toContain("kc-cinematic-generation-stage");
    expect(markup).not.toContain("kc-cinematic-generation-label");
    expect(markup).not.toContain("kc-cinematic-generation-progress");
    expect(markup).not.toContain("kc-node-loading-content");
    expect(markup).not.toContain("kc-node-loading-label");
    expect(markup).not.toContain("kc-node-loading-value");
    expect(markup).not.toContain("kc-node-loading-track");
  });

  it("uses a moving rail while submission progress is unknown", () => {
    const markup = renderToStaticMarkup(
      <NodeLoadingState variant="image" activity="generation" status="submission_unknown" progress={0} />,
    );

    expect(markup).toContain('data-generation-stage="submission_unknown"');
    expect(markup).toContain("kc-video-generation-rail is-indeterminate");
    expect(markup).toContain("kc-video-generation-scene");
    expect(markup).not.toContain("kc-cinematic-generation-stage");
    expect(markup).not.toContain("kc-cinematic-generation-progress");
  });

  it("keeps submitting, queued, running, and submission_unknown visually distinct", () => {
    const submitting = renderToStaticMarkup(
      <NodeLoadingState variant="video" activity="generation" status="submitting" progress={0} />,
    );
    const queued = renderToStaticMarkup(
      <NodeLoadingState variant="video" activity="generation" status="queued" progress={0} />,
    );
    const running = renderToStaticMarkup(
      <NodeLoadingState variant="video" activity="generation" status="running" progress={50} />,
    );
    const unknown = renderToStaticMarkup(
      <NodeLoadingState variant="video" activity="generation" status="submission_unknown" progress={0} />,
    );

    expect(submitting).toContain('data-generation-stage="submitting"');
    expect(queued).toContain('data-generation-stage="queued"');
    expect(running).toContain('data-generation-stage="running"');
    expect(unknown).toContain('data-generation-stage="submission_unknown"');
    expect(submitting).toContain("准备素材并提交");
    expect(queued).toContain("排队中");
    expect(running).toContain("正在生成");
    expect(unknown).toContain("正在确认任务提交");
    expect(running).not.toContain("准备素材并提交");
    expect(unknown).not.toContain("正在生成");
  });

  it("keeps ordinary media loading separate from generation visuals", () => {
    const markup = renderToStaticMarkup(
      <NodeLoadingState variant="video" activity="loading" label="Loading video" />,
    );

    expect(markup).toContain('data-loading-activity="loading"');
    expect(markup).not.toContain("data-generation-stage");
    expect(markup).toContain('aria-label="Loading video"');
    expect(markup).toContain("kc-node-loading-spinner");
    expect(markup).toContain("kc-node-loading-track is-indeterminate");
    expect(markup).not.toContain("kc-node-loading--cinematic");
    expect(markup).not.toContain("kc-video-generation-scene");
    expect(markup).not.toContain("kc-video-generation-rail");
  });

  it("clamps media progress while retaining a visible material treatment", () => {
    const over = renderToStaticMarkup(<NodeLoadingState variant="video" progress={140} />);
    const under = renderToStaticMarkup(<NodeLoadingState variant="video" progress={-12} />);
    const invalid = renderToStaticMarkup(<NodeLoadingState variant="video" progress={Number.NaN} />);

    expect(over).toContain("--kc-generation-progress:100%");
    expect(over).toContain("--kc-generation-progress-scale:1");
    expect(under).toContain("--kc-generation-progress:0%");
    expect(under).toContain("--kc-generation-progress-scale:0");
    expect(under).toContain("kc-video-generation-rail is-indeterminate");
    expect(invalid).toContain("--kc-generation-progress:36%");
    expect(invalid).toContain("--kc-generation-progress-scale:0.36");
    expect(invalid).toContain("kc-video-generation-field-opacity:0.68");
    expect(invalid).toContain("kc-video-generation-sweep-opacity:0.86");
    expect(invalid).toContain("kc-video-generation-glint-opacity:0.72");
    expect(invalid).toContain("kc-video-generation-scene");
    expect(invalid).toContain("kc-video-generation-rail is-indeterminate");
    expect(invalid).not.toContain("kc-cinematic-generation-stage");
    expect(invalid).not.toContain("NaN");
  });

  it("shows an explicit stalled semantic for a frozen running job", () => {
    const markup = renderToStaticMarkup(
      <NodeLoadingState variant="image" activity="generation" status="running" progress={48} stalled />,
    );

    expect(markup).toContain('data-stalled="true"');
    expect(markup).toContain("kc-node-loading--stalled");
    expect(markup).toContain("生成长时间未推进");
    expect(markup).toContain("48%");
    expect(markup).not.toContain("kc-video-generation-scene");
    expect(markup).not.toContain("kc-node-loading--cinematic");
  });

  it("keeps the ordinary generating label when the same job is not stalled", () => {
    const markup = renderToStaticMarkup(
      <NodeLoadingState variant="image" activity="generation" status="running" progress={48} />,
    );

    expect(markup).not.toContain('data-stalled="true"');
    expect(markup).not.toContain("kc-node-loading--stalled");
    expect(markup).not.toContain("生成长时间未推进");
    expect(markup).toContain("正在生成图片");
  });

  it("shows an explicit temporarily-unavailable semantic when observation is exhausted", () => {
    const markup = renderToStaticMarkup(
      <NodeLoadingState variant="image" activity="generation" status="running" progress={48} observationExhausted />,
    );

    expect(markup).toContain('data-observation-exhausted="true"');
    expect(markup).toContain("kc-node-loading--observation-exhausted");
    expect(markup).toContain("暂时无法更新");
    expect(markup).toContain("请稍后重试");
    // No infinite spinner: the indeterminate rail, spinner, and cinematic/beam
    // sweep are all suppressed; only the explicit truthful copy remains.
    expect(markup).not.toContain("kc-node-loading-spinner");
    expect(markup).not.toContain("kc-node-loading-track");
    expect(markup).not.toContain("kc-node-loading-beam");
    expect(markup).not.toContain("kc-video-generation-scene");
    expect(markup).not.toContain("kc-node-loading--cinematic");
    expect(markup).toContain('aria-label="暂时无法更新，请稍后重试"');
  });

  it("keeps submission_unknown rendering a pending-confirmation semantic", () => {
    const markup = renderToStaticMarkup(
      <NodeLoadingState variant="default" activity="generation" status="submission_unknown" progress={0} />,
    );

    expect(markup).toContain('data-generation-stage="submission_unknown"');
    expect(markup).toContain("正在确认任务提交");
    expect(markup).toContain("待确认");
  });

  it("keeps quiet as a centered truthful status for normal media generation", () => {
    const markup = renderToStaticMarkup(
      <NodeLoadingState variant="image" activity="generation" status="running" progress={48} generationEffectStyle="quiet" />,
    );

    expect(markup).toContain('data-generation-effect="quiet"');
    expect(markup).toContain("kc-node-loading--quiet");
    expect(markup).toContain("kc-quiet-generation-scene");
    expect(markup).toContain("kc-quiet-generation-sweep");
    expect(markup).toContain("kc-quiet-ring");
    expect(markup).toContain("kc-node-loading-content");
    expect(markup).toContain("正在生成图片");
    expect(markup).toContain("48%");
    expect(markup).not.toContain("kc-node-loading--cinematic");
    expect(markup).not.toContain("kc-video-generation-scene");
    expect(markup).not.toContain("kc-node-loading-spinner");
    expect(markup).not.toContain('data-stalled="true"');
    expect(markup).not.toContain("生成长时间未推进");
    expect(markup).not.toContain("暂时无法更新");
    expect(markup).toContain('aria-label="正在生成图片 48%"');
  });

  it("quiet keeps all truthful generation stages distinct", () => {
    const submitting = renderToStaticMarkup(
      <NodeLoadingState variant="video" activity="generation" status="submitting" progress={0} generationEffectStyle="quiet" />,
    );
    const confirming = renderToStaticMarkup(
      <NodeLoadingState variant="video" activity="generation" status="submission_unknown" progress={0} generationEffectStyle="quiet" />,
    );
    const queued = renderToStaticMarkup(
      <NodeLoadingState variant="image" activity="generation" status="queued" progress={12} generationEffectStyle="quiet" />,
    );
    const running = renderToStaticMarkup(
      <NodeLoadingState variant="video" activity="generation" status="running" progress={42} generationEffectStyle="quiet" />,
    );
    const validating = renderToStaticMarkup(
      <NodeLoadingState variant="video" activity="generation" status="validating" progress={81} generationEffectStyle="quiet" />,
    );

    expect(submitting).toContain('data-generation-stage="submitting"');
    expect(submitting).toContain("正在准备素材并提交视频");
    expect(confirming).toContain('data-generation-stage="submission_unknown"');
    expect(confirming).toContain("正在确认任务提交");
    expect(confirming).toContain("待确认");
    expect(queued).toContain('data-generation-stage="queued"');
    expect(queued).toContain("图片任务排队中");
    expect(running).toContain('data-generation-stage="running"');
    expect(running).toContain("正在生成视频");
    expect(running).not.toContain("超时");
    expect(validating).toContain('data-generation-stage="validating"');
    expect(validating).toContain("正在整理成片");
    for (const markup of [submitting, confirming, queued, running, validating]) {
      expect(markup).toContain("kc-quiet-ring");
      expect(markup).not.toContain("kc-node-loading--cinematic");
      expect(markup).not.toContain("kc-video-generation-scene");
    }
  });

  it("keeps beam, nebula, and water text-free cinematic for media generation", () => {
    for (const effect of ["beam", "nebula", "water"] as const) {
      const markup = renderToStaticMarkup(
        <NodeLoadingState variant="image" activity="generation" status="running" progress={33} generationEffectStyle={effect} />,
      );
      expect(markup).toContain(`data-generation-effect="${effect}"`);
      expect(markup).toContain("kc-node-loading--cinematic");
      expect(markup).toContain("kc-video-generation-scene");
      expect(markup).not.toContain("kc-node-loading-content");
      expect(markup).not.toContain("kc-node-loading-label");
      expect(markup).not.toContain("kc-node-loading-value");
      expect(markup).not.toContain("kc-quiet-ring");
      expect(markup).not.toContain("kc-quiet-generation-scene");
    }
  });

  it("stalled overrides quiet and retains its truthful copy", () => {
    const markup = renderToStaticMarkup(
      <NodeLoadingState variant="image" activity="generation" status="running" progress={48} stalled generationEffectStyle="quiet" />,
    );

    expect(markup).toContain('data-stalled="true"');
    expect(markup).toContain("kc-node-loading--stalled");
    expect(markup).toContain("生成长时间未推进");
    expect(markup).toContain("48%");
    expect(markup).not.toContain("kc-node-loading--quiet");
    expect(markup).not.toContain("kc-quiet-generation-scene");
    expect(markup).not.toContain("kc-quiet-ring");
  });

  it("observation exhaustion overrides quiet and retains its truthful copy", () => {
    const markup = renderToStaticMarkup(
      <NodeLoadingState variant="image" activity="generation" status="running" progress={48} observationExhausted generationEffectStyle="quiet" />,
    );

    expect(markup).toContain('data-observation-exhausted="true"');
    expect(markup).toContain("kc-node-loading--observation-exhausted");
    expect(markup).toContain("暂时无法更新");
    expect(markup).toContain("请稍后重试");
    expect(markup).not.toContain("kc-node-loading--quiet");
    expect(markup).not.toContain("kc-quiet-generation-scene");
    expect(markup).not.toContain("kc-quiet-ring");
    expect(markup).not.toContain("kc-node-loading-spinner");
    expect(markup).not.toContain("kc-node-loading-track");
    expect(markup).toContain('aria-label="暂时无法更新，请稍后重试"');
  });

  it("quiet uses an indeterminate thin rail when progress is unknown", () => {
    const markup = renderToStaticMarkup(
      <NodeLoadingState variant="video" activity="generation" status="running" progress={0} generationEffectStyle="quiet" />,
    );

    expect(markup).toContain("kc-node-loading-track is-indeterminate");
    expect(markup).toContain("正在生成视频");
    expect(markup).toContain("0%");
  });
});
