import { describe, expect, it } from "vitest";

import { DIRECTOR_STAGE_MAX_PACKET_SLOTS, createDirectorStageStarterPacket, normalizeDirectorStagePacket } from "./director-stage";

describe("director stage packet", () => {
  it("normalizes aliases, bounds camera values, and makes shot ids unique", () => {
    const packet = normalizeDirectorStagePacket({
      globalVisualContract: "  noir  ",
      slots: [
        { shotId: "shot", durationMax: 99, camera: { y: -5, fov: 200 } },
        { shotId: "shot", camera: { x: "3" } },
      ],
    });
    expect(packet.global_visual_contract).toBe("noir");
    expect(packet.slots.map((slot) => slot.shot_id)).toEqual(["shot", "shot-2"]);
    expect(packet.slots[0]?.duration_max).toBe(15);
    expect(packet.slots[0]?.camera).toMatchObject({ y: 0.15, fov: 110 });
  });

  it("provides a valid neutral starter and rejects oversized packets", () => {
    expect(createDirectorStageStarterPacket().slots).toHaveLength(1);
    expect(() => normalizeDirectorStagePacket({ slots: Array.from({ length: DIRECTOR_STAGE_MAX_PACKET_SLOTS + 1 }, () => ({})) })).toThrow("最多支持");
  });
});
