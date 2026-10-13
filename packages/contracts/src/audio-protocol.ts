import { z } from "zod";

/**
 * Versioned, provider-neutral audio generation contract.
 *
 * 与 image.v1/video.v1 不同，音频协议不携带端点与媒体角色：上游音频模型
 * 只接受纯文本输入（参考音频是另一条已建模的输入通道，不走这里），端点
 * 形态由目录归一化白名单校验——`/v1/chat/completions`（同步返回音频链接）
 * 或 Gemini 原生 `/v1beta/models/<id>:generateContent`（返回内联 PCM）。
 * 协议本身只声明**输出怎么拿**：链接还是内联数据。
 */
export const AUDIO_PROTOCOL_VERSION = "audio.v1" as const;

/** 结果交付形态：有时效的下载链接，或响应体内联的 base64 音频数据。 */
export const audioOutputFormatSchema = z.enum(["url", "inline-data"]);
export type AudioOutputFormat = z.infer<typeof audioOutputFormatSchema>;

export const audioModelProtocolSchema = z.object({
  version: z.literal(AUDIO_PROTOCOL_VERSION),
  outputFormat: audioOutputFormatSchema,
});
export type AudioModelProtocol = z.infer<typeof audioModelProtocolSchema>;

/** Gemini 原生 generateContent 的端点路径形态（目录白名单与执行侧共用）。 */
export const GEMINI_NATIVE_AUDIO_ENDPOINT = /^\/v1beta\/models\/[A-Za-z0-9._-]+:generateContent$/;

/** 音频执行端点白名单：OpenAI 兼容 chat 补全（同步返回音频链接）。 */
export const CHAT_COMPLETIONS_AUDIO_ENDPOINT = "/v1/chat/completions";

export function isGeminiNativeAudioPath(path: string): boolean {
  return GEMINI_NATIVE_AUDIO_ENDPOINT.test(path);
}

/** 目录归一化与托管/BYOK 执行共用的唯一音频端点判定。 */
export function isAllowedAudioEndpoint(path: string): boolean {
  return path === CHAT_COMPLETIONS_AUDIO_ENDPOINT || isGeminiNativeAudioPath(path);
}

/**
 * 把裸 16-bit PCM 包成 WAV（RIFF/WAVE 头）。Gemini TTS 实测返回
 * `audio/l16; rate=24000; channels=1` 的无头流——浏览器与媒体管线都只认
 * 带容器的音频，所以执行侧拿到 PCM 后必须先过这一步。
 */
export function wrapPcmToWav(
  pcm: Uint8Array,
  options: { sampleRate: number; channels: number; bitsPerSample?: number },
): Uint8Array {
  const bitsPerSample = options.bitsPerSample ?? 16;
  const byteRate = (options.sampleRate * options.channels * bitsPerSample) / 8;
  const blockAlign = (options.channels * bitsPerSample) / 8;
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const writeTag = (offset: number, tag: string) => {
    for (let index = 0; index < tag.length; index += 1)
      header[offset + index] = tag.charCodeAt(index);
  };
  writeTag(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, options.channels, true);
  view.setUint32(24, options.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeTag(36, "data");
  view.setUint32(40, pcm.length, true);
  const wav = new Uint8Array(44 + pcm.length);
  wav.set(header, 0);
  wav.set(pcm, 44);
  return wav;
}
