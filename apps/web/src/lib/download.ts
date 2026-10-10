export async function downloadUrl(url: string, filename: string) {
  const response = await fetch(downloadRequestUrl(url), {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`下载失败 (${response.status})`);
  const blob = await response.blob();
  if (!blob.size) throw new Error("下载结果为空");

  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename || "下载文件";
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Keep the object URL alive through the browser's click dispatch.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
}

function downloadRequestUrl(value: string) {
  try {
    const url = new URL(value, window.location.href);
    if (url.pathname.includes("/content")) url.searchParams.set("download", "1");
    return url.href;
  } catch {
    return value;
  }
}
