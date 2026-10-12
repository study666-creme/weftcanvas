import {
  createDirectorStageStarterPacket,
  normalizeDirectorStagePacket,
  type DirectorStagePacket,
} from "@weftcanvas/contracts";

export type DirectorStageSourceMode = "packet" | "draft";

export function createDirectorStagePacketFromText(value: string): {
  packet: DirectorStagePacket;
  mode: DirectorStageSourceMode;
} {
  const body = value.trim();
  if (body) {
    try {
      return { packet: normalizeDirectorStagePacket(JSON.parse(body)), mode: "packet" };
    } catch {
      // Ordinary writing and incomplete JSON both remain usable as a one-shot draft.
    }
  }

  const packet = createDirectorStageStarterPacket();
  const slot = packet.slots[0]!;
  const prompt = body.slice(0, 8_000);
  return {
    mode: "draft",
    packet: {
      ...packet,
      slots: [
        {
          ...slot,
          dramatic_function: body ? "文本预演" : slot.dramatic_function,
          beat: prompt || slot.beat,
          compressed_video_prompt: prompt,
        },
      ],
    },
  };
}
