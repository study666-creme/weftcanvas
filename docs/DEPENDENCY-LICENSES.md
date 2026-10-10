# Runtime Dependency License Record

Date reviewed: 2026-07-15

This is an engineering inventory, not legal advice. Exact transitive notices
must still be generated from the release lockfile and shipped where required.

| Runtime dependency | Version policy | License | Product use |
| --- | --- | --- | --- |
| React / React DOM | lockfile | MIT | Browser UI |
| XYFlow React / System | lockfile | MIT | Infinite canvas engine |
| Three.js | `0.185.1` | MIT | Director stage |
| Zustand | lockfile | MIT | Browser state |
| Lucide React | lockfile | ISC | Interface icons |
| @mediapipe/tasks-vision | `0.10.35` | Apache-2.0 | 人脸网格（人脸检测）的浏览器端运行时 |
| MediaPipe 任务模型（BlazeFace） | tflite，自托管 | Apache-2.0 | 人脸检测模型，见 `apps/web/public/mediapipe/NOTICE.txt` |
| Hono / Hono Node Server | `4.12.30` / `2.0.8` | MIT | Product API |
| PostgreSQL client `pg` | `8.22.0` | MIT | Database adapter |
| Zod | lockfile | MIT | Runtime contracts |
| Sharp | `0.35.3` | Apache-2.0 | Server image decode and metadata |
| MediaInfo.js | `0.3.7` | BSD-2-Clause | Server audio/video container parsing |
| AWS SDK for JavaScript S3 / presigner | lockfile | Apache-2.0 | S3-compatible private media storage |

Sharp distributes platform-specific libvips and codec components. MediaInfo.js
includes the MediaInfoLib WebAssembly build. A release process must retain all
required copyright and license notices from these packages and their bundled
components. Neither dependency is imported by the browser application.

No FFmpeg or FFprobe binary is bundled by Canvas Next. The media inspector uses
the BSD-licensed MediaInfo.js package, avoiding an undeclared binary distribution
obligation in the default build.

浏览器本机推理（人脸网格）补充说明：

- MediaPipe 运行时与 BlazeFace 模型都自托管在 `apps/web/public/mediapipe/`，
  随 Web 产物一起发布、同源加载（不引用外部 CDN）。文件清单、来源与 sha256
  见 `apps/web/public/mediapipe/NOTICE.txt`；`/mediapipe/*` 以 immutable
  缓存下发，换模型或升级运行时必须换文件名。
- 浏览器端不再做视频逐帧编码封装，`mp4-muxer` 已随人物白模功能一起移除。
