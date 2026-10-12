import { describe, expect, it } from "vitest";

import type { PublicModel } from "@weftcanvas/contracts";

import {
  buildCategories,
  buildZonedCategories,
  partitionModelsByZone,
} from "./categorized-model-select";

function model(
  id: string,
  label: string,
  modality: PublicModel["modality"] = "video",
): PublicModel {
  return {
    id,
    label,
    modality,
    operation: "generate",
    order: 0,
  } as PublicModel;
}

describe("video model category buckets", () => {
  const catalog = [
    model("S-2.0满血-线路六", "S-2.0满血-线路六"),
    model("S-2.0fast-稳定-线路一", "S-2.0fast-稳定-线路一"),
    model("S-2.0mini-1080p-线路六", "S-2.0mini-1080p-线路六"),
    model("S-2.5特惠15s-线路六", "S-2.5特惠15s-线路六"),
    model("S-fast高质量-线路六", "S-fast高质量-线路六"),
    model("S-满血2.0-稳定-线路一", "S-满血2.0-稳定-线路一"),
    model("S-videos-f-933-fast-3", "卡人脸2.0fast-933-线路三"),
    model("卡人脸2.0-933-线路三", "卡人脸2.0-933-线路三"),
    model("veo-3.1-fast", "Veo 3.1 Fast · 线路五"),
    model("gemini-omni", "Gemini Omni Flash · 线路五"),
  ];

  it("places the bare S-fast line into the 2.0fast bucket without a 2.0 marker", () => {
    const categories = buildCategories("video", catalog);
    const fast = categories.find((category) => category.id === "2.0fast");
    expect(fast).toBeDefined();
    const bareFast = catalog.find((item) => item.id === "S-fast高质量-线路六")!;
    expect(fast?.match(bareFast)).toBe(true);

    const other = categories.find((category) => category.id === "other");
    expect(other?.match(bareFast)).not.toBe(true);
    expect(catalog.filter((item) => fast?.match(item)).map((item) => item.id)).toEqual([
      "S-2.0fast-稳定-线路一",
      "S-fast高质量-线路六",
      "S-videos-f-933-fast-3",
    ]);
  });

  it("keeps 2.0 / 2.5 / 2.0mini / vendor buckets for the other S-family lines", () => {
    const categories = buildCategories("video", catalog);
    const byId = Object.fromEntries(categories.map((category) => [category.id, category.match]));
    expect(byId["2.0"]!(catalog.find((item) => item.id === "S-2.0满血-线路六")!)).toBe(true);
    // 2.5 单开一类：过去 hasS20Marker 把 2.5 也算进 2.0，两代混在同一个 tab 里。
    expect(byId["2.5"]!(catalog.find((item) => item.id === "S-2.5特惠15s-线路六")!)).toBe(true);
    expect(byId["2.0"]!(catalog.find((item) => item.id === "S-2.5特惠15s-线路六")!)).toBe(false);
    expect(byId["2.0"]!(catalog.find((item) => item.id === "S-满血2.0-稳定-线路一")!)).toBe(true);
    expect(byId["2.0"]!(catalog.find((item) => item.id === "卡人脸2.0-933-线路三")!)).toBe(true);
    expect(byId["2.0mini"]!(catalog.find((item) => item.id === "S-2.0mini-1080p-线路六")!)).toBe(
      true,
    );
    expect(byId["veo"]!(catalog.find((item) => item.id === "veo-3.1-fast")!)).toBe(true);
    expect(byId["veo"]!(catalog.find((item) => item.id === "gemini-omni")!)).toBe(true);
  });
});

describe("image model category buckets", () => {
  const catalog = [
    model("gpt-image-2-1k", "全能模型2 · 特价 1K", "image"),
    model("image2-A", "全能模型2-A", "image"),
    model("image2-A-1.5k", "全能模型2-A-1.5k", "image"),
    model("image2-W", "全能模型2-W", "image"),
    model("gpt-image-2.5", "GPT-Image-2.5-flare", "image"),
    model("gpt-image-2.5-1.5k", "GPT-Image-2.5-flare-1.5k", "image"),
    model("gpt-image-2.5-sunburst", "GPT-Image-2.5-sunburst", "image"),
    model("nano-banana-2", "Nano Banana 2 1K/2K/4K", "image"),
    model("nano-banana-pro", "Nano Banana Pro 1K/2K/4K", "image"),
  ];

  it("splits 全能模型2 into 2 and 2.5 tabs instead of one umbrella tab", () => {
    const categories = buildCategories("image", catalog);
    expect(categories.map((category) => category.label)).toEqual([
      "香蕉",
      "全能模型2",
      "全能模型2.5",
    ]);
    const byId = Object.fromEntries(categories.map((category) => [category.id, category.match]));
    const ids = (id: string) => catalog.filter((item) => byId[id]!(item)).map((item) => item.id);
    expect(ids("universal2")).toEqual(["gpt-image-2-1k", "image2-A", "image2-A-1.5k", "image2-W"]);
    expect(ids("universal25")).toEqual([
      "gpt-image-2.5",
      "gpt-image-2.5-1.5k",
      "gpt-image-2.5-sunburst",
    ]);
    expect(ids("banana")).toEqual(["nano-banana-2", "nano-banana-pro"]);
  });

  it("keeps the 1.5k fixed variants in the 2 tab, not the 2.5 tab", () => {
    const categories = buildCategories("image", catalog);
    const byId = Object.fromEntries(categories.map((category) => [category.id, category.match]));
    const onePointFive = catalog.find((item) => item.id === "image2-A-1.5k")!;
    expect(byId["universal2"]!(onePointFive)).toBe(true);
    expect(byId["universal25"]!(onePointFive)).toBe(false);
  });
});

describe("zone-aware category buckets", () => {
  it("keeps promo models inside their regex category and adds no dedicated promo tab", () => {
    const catalog = [
      model("S-2.0满血-线路六", "S-2.0满血-线路六"),
      // 这条特惠模型的 id/label 命中「2.0」正则，应留在 2.0 分类内（渲染时贴底）。
      { ...model("S-2.0满血-特惠-线路六", "S-2.0满血-特惠-线路六"), zone: "promo" as const },
      model("veo-3.1-fast", "Veo 3.1 Fast · 线路五"),
    ];

    const categories = buildZonedCategories("video", catalog);
    expect(categories.map((category) => category.id)).toEqual(["2.0", "veo"]);
    const byId = Object.fromEntries(categories.map((category) => [category.id, category.match]));
    const promo = catalog[1]!;
    expect(byId["2.0"]!(promo)).toBe(true);
    expect(byId["2.0"]!(catalog[0]!)).toBe(true);
    expect(byId["veo"]!(catalog[2]!)).toBe(true);
  });

  it("orders each category stable-first with promo models at the bottom", () => {
    const stable = model("S-2.0满血-线路六", "S-2.0满血-线路六");
    const promo = {
      ...model("S-2.0满血-特惠-线路六", "S-2.0满血-特惠-线路六"),
      zone: "promo" as const,
    };
    const veo = model("veo-3.1-fast", "Veo 3.1 Fast · 线路五");

    // 稳定区保持输入序，特惠区整体贴底。
    expect(partitionModelsByZone([promo, veo, stable]).map((item) => item.id)).toEqual([
      "veo-3.1-fast",
      "S-2.0满血-线路六",
      "S-2.0满血-特惠-线路六",
    ]);
    // 全特惠分类保持原序，不凭空移动。
    expect(partitionModelsByZone([promo])).toEqual([promo]);
  });

  /**
   * 回归：首屏 / catalog 未加载完时 models 为空数组，旧实现返回空分类数组，
   * 调用方 categories[0].id 会在 undefined 上取值，直接把整棵渲染树带崩
   * （TypeError: Cannot read properties of undefined (reading 'id')）。
   */
  it("never returns an empty category list for an empty catalog", () => {
    for (const modality of ["image", "video", "text", "audio"] as PublicModel["modality"][]) {
      const categories = buildZonedCategories(modality, []);
      expect(categories.length).toBeGreaterThan(0);
      expect(categories[0]!.id).toBeTruthy();
      expect(typeof categories[0]!.match).toBe("function");
    }
  });
});

describe("seedance video models", () => {
  const catalog = [
    model("doubao-seedance-2.0", "Seedance 2.0"),
    model("doubao-seedance-2.0-fast", "Seedance 2.0 Fast"),
    model("doubao-seedance-2.0-mini", "Seedance 2.0 Mini"),
    model("doubao-seedance-2.5", "Seedance 2.5"),
    model("firefly-seedance2-720p", "Seedance 2.0 Pro 720P"),
    model("S-2.0满血-线路六", "S-2.0满血-线路六"),
  ];

  it("gives seedance its own bucket instead of 其他", () => {
    const categories = buildCategories("video", catalog);
    const seedance = categories.find((category) => category.id === "seedance");
    expect(seedance).toBeDefined();
    // 运营要求：官转渠道分类名带「官方」后缀，与 S 系「线路」渠道区分。
    expect(seedance?.label).toBe("Seedance官方");
    for (const item of catalog.filter((entry) => /seedance/i.test(entry.id))) {
      expect(seedance?.match(item)).toBe(true);
    }
    const other = categories.find((category) => category.id === "other");
    expect(other?.match(catalog[0]!)).not.toBe(true);
    expect(categories.map((category) => category.id)).toContain("seedance");
  });

  it("keeps S-family lines out of the seedance bucket", () => {
    const categories = buildCategories("video", catalog);
    const seedance = categories.find((category) => category.id === "seedance");
    expect(seedance?.match(catalog.find((item) => item.id === "S-2.0满血-线路六")!)).toBe(false);
  });
});
