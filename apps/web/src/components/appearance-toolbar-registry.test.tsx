import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerAppearanceOption,
  useAppearanceOptions,
  type AppearanceSlot,
} from "../lib/appearance-registry";
import "../lib/builtin-appearance";

/**
 * 设置中心的分组按钮全部来自 useAppearanceOptions（appearance-toolbar 的渲染
 * 走同一个钩子）。这里用最小探针组件验证"注册即出现、卸载即消失"，避免在
 * SSR 环境里拖起整个 portal 面板。
 */
function OptionProbe({ slot }: { slot: AppearanceSlot }) {
  const options = useAppearanceOptions(slot);
  return (
    <div>
      {options.map((option) => (
        <span key={option.id}>{option.label}</span>
      ))}
    </div>
  );
}

describe("appearance registry feeds the settings groups", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { innerWidth: 1600, innerHeight: 900 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps every builtin edge path option listed in order", () => {
    const markup = renderToStaticMarkup(<OptionProbe slot="edgePathStyle" />);
    expect(markup).toContain("张力");
    expect(markup).toContain("柔弧");
    expect(markup).toContain("翡翠");
    expect(markup).toContain("游丝");
  });

  it("shows a registered pack and drops it after unregister", () => {
    const unregister = registerAppearanceOption("edgePathStyle", {
      id: "amber-edge",
      label: "琥珀",
    });
    const withPack = renderToStaticMarkup(<OptionProbe slot="edgePathStyle" />);
    expect(withPack).toContain("琥珀");
    unregister();

    const withoutPack = renderToStaticMarkup(<OptionProbe slot="edgePathStyle" />);
    expect(withoutPack).not.toContain("琥珀");
  });
});
