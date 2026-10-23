/** 拖拽 / 粘贴里提取文件的共用判定（资源库、卡片库、画布都走这一套）。 */

export function hasFilePayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (Array.from(dataTransfer.types ?? []).includes("Files")) return true;
  if ((dataTransfer.files?.length ?? 0) > 0) return true;
  return Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file");
}

export function filesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  const files = Array.from(dataTransfer.files ?? []);
  if (files.length) return files;
  return Array.from(dataTransfer.items ?? []).flatMap((item) =>
    item.kind === "file" ? [item.getAsFile()].filter((file): file is File => Boolean(file)) : [],
  );
}
