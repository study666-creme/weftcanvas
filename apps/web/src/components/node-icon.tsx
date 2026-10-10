import type { CanvasNodeKind } from "@kachang/contracts";
import { FileText, Image, Music2, Scissors, SlidersHorizontal, Video } from "lucide-react";

export const nodeIcons = {
  text: FileText,
  image: Image,
  video: Video,
  audio: Music2,
  config: SlidersHorizontal,
  edit: Scissors,
} satisfies Record<CanvasNodeKind, typeof FileText>;
