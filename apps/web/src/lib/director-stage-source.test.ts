import { describe, expect, it } from "vitest";

import { createDirectorStagePacketFromText } from "./director-stage-source";

describe("director stage source", () => {
  it("turns ordinary node text into an explicit one-shot draft", () => {
    const source =
      createDirectorStagePacketFromText("人物推门进入，停在走廊尽头。\n镜头缓慢前移。");

    expect(source.mode).toBe("draft");
    expect(source.packet.slots).toHaveLength(1);
    expect(source.packet.slots[0]).toMatchObject({
      dramatic_function: "文本预演",
      beat: "人物推门进入，停在走廊尽头。\n镜头缓慢前移。",
      compressed_video_prompt: "人物推门进入，停在走廊尽头。\n镜头缓慢前移。",
    });
  });

  it("loads a valid director packet without flattening it into text", () => {
    const source = createDirectorStagePacketFromText(
      JSON.stringify({
        global_visual_contract: "写实室内",
        slots: [
          { shot_id: "shot-a", dramatic_function: "建立空间" },
          { shot_id: "shot-b", dramatic_function: "推进冲突" },
        ],
      }),
    );

    expect(source.mode).toBe("packet");
    expect(source.packet.slots.map((slot) => slot.shot_id)).toEqual(["shot-a", "shot-b"]);
  });
});
