# 第三方画布导入（LibTV / TapNow / UpDream）

画布顶栏的「导入第三方画布」把一个别人平台上的画布整块搬进来：节点、连线、
相对布局、素材。三个来源走同一条流水线，差别只在"怎么读对方的画布"。

- **LibTV**（liblib.tv）：只有登录态接口，服务端配一把画布令牌（`LIBTV_CANVAS_TOKEN`）。
  标识是 32 位画布 UUID，画布链接也能贴。未配置令牌时那一项如实显示为不可用。
- **TapNow**（app.tapnow.media）：公开分享链接，标识是分享 ID（`/tapflow/view/<id>`）。
- **UpDream**（updream.cn）：公开分享口令（`share://…`），没有可浏览的分享链接——
  分享动作在对方应用内完成，用户把口令整段贴进来即可。

## 数据流

```
浏览器                     Canvas API                        来源站点
  │  POST /canvas-import/preview │                              │
  │─────────────────────────────▶│  读对方画布（服务端，令牌只在服务端）│
  │                              │─────────────────────────────▶│
  │  节点/连线/跳过项/提醒        │◀─────────────────────────────│
  │◀─────────────────────────────│  适配成画布形状（纯函数）      │
  │                              │
  │  落节点与连线（addImportedGraph，一条撤销记录）
  │  GET /canvas-import/asset?…  │
  │─────────────────────────────▶│  逐跳守卫 + 域名白名单代拉     │
  │◀─────────────────────────────│
  │  storeMedia() 落本地媒体库，节点挂 media
```

要点：

- **节点里不落第三方媒体直链**，与本仓音乐节点同一约定。浏览器只接触同源代理
  路径；节点存的是本地媒体库 id。素材字节不进服务端存储——导入的是别人的画布
  内容，没有理由占用创作者的云端配额。
- **服务端无状态**：`canvas-import/*` 不写数据库，除 LibTV 令牌外没有配置项，
  所以不需要 PostgreSQL 也能用。
- **不伪装**：对方还没出结果的节点落成占位节点，失败节点如实带上对方的失败原因；
  素材拉不到时节点保留为占位并在总结里说明，不会假装导入成功。

## 三个来源的适配细节

|         | 读取                                                              | 素材来源字段                           | 失败判定                                  |
| ------- | ----------------------------------------------------------------- | -------------------------------------- | ----------------------------------------- |
| LibTV   | `GET api.liblib.tv/api/canvas/project/detail?uuid=` + `token` 头  | `data.url[]`，风格素材退回 `coverUrl`  | `taskInfo.status == 3`                    |
| TapNow  | `GET app.tapnow.media/api/conversation/v1/canvas-share/<shareId>` | `src` → `options[]` → `__metadata.url` | `taskInfo.status` 为 failed/error/failure |
| UpDream | `GET www.updream.cn/api/share/<code>`                             | `video_url` / `cover_url` / `url`      | `task_status` 含 fail/error/invalid       |

- LibTV 的 `nodeList[].data` 是 JSON 字符串，`position`/`measured` 里的数字也是
  字符串；`material-style`（风格素材）没有生成结果但有封面，降级成图片参考节点。
- TapNow 的文本节点带 `text`/`prompt`，`data` 既可能是对象也可能是 JSON 字符串；
  连线的目标句柄在 `data.valueKey`（本仓节点只有一个输入口，句柄不参与映射）。
- UpDream 的载荷是 `{type:"canvas-nodes", nodes, connections}`，过期口令返回
  `{expired:true}`。`group` / `agent` / `agent_v2` 节点跳过并逐条说明原因。
- 三边的**连线只连接两端都导入成功的节点**，悬空连线丢掉并记录原因。

## 安全边界

- **来源主机固定**：三个读取端点的主机名都是服务端常量，用户输入只影响查询参数
  或路径段；全部禁止跟随重定向（LibTV 的令牌是自定义请求头，跟 302 会把凭证带走）。
- **素材域名白名单**：LibTV `*.liblib.art` / `*.liblib.tv`，TapNow `*.tapnow.media`，
  UpDream `*.hdslb.com` / `*.bilivideo.com` / `*.bilibili.com`。白名单外的地址
  整条丢弃（节点保留为占位并记提醒）。代拉时**每一跳都重新校验**白名单与 SSRF
  守卫，对方 CDN 302 到别家主机同样会被拦下。
- **大小与类型**：响应体有上限（LibTV 8MB、其余 16MB），素材按声明类型只放行
  图片/视频/音频，并按类型限流（图片 25MB、视频 512MB、音频 100MB——与本地上传
  同一组数字）。
- 这些路由都要求登录态（与音乐链接解析一致），避免匿名用户把站点当出网代理。

## 已覆盖的验证

- `apps/api/src/canvas-import/*.test.ts`：标识解析与域名白名单、三个适配器
  （含坏坐标/重复标识/不支持类型/失败节点/多结果的降级路径）、来源读取的信封与
  超时/超限、路由鉴权与素材代拉门槛（白名单、重定向逃逸、类型、大小）。
- `apps/web/src/lib/canvas-import.test.ts`、`apps/web/src/state/canvas-store-import.test.ts`：
  整块居中、尺寸收敛、节点来源字段、批量插入与撤销。
- `apps/web/e2e/canvas-import.spec.ts`：入口菜单、来源可用性、预览文案、确认导入后
  画布真的多出节点与连线与素材、读不到时如实报错且不留节点。

## 已知边界

- UpDream 的载荷字段取自其公开前端自带的校验器与工具描述（`node_type` /
  `x` / `y` / `size` / `cover_url` / `video_url` / `task_status` / `from_node_id` /
  `to_node_id`）。这些是观察值，不是对方承诺的接口；对不上的字段会走"跳过 + 说明"
  的降级路径，不会静默出错。
- 导入的素材落在**浏览器本地媒体库**：换设备打开本地项目时，这些素材不会跟着走
  （与拖入本地文件一致）。要跨设备就把项目存成云项目，走既有的媒体同步路径。
- 不支持的能力：对方的分组/助手/三维等专有节点类型只跳过不迁移；重复导入不去重
  （`importedFrom` 记录了来源身份，后续可据此做去重或更新）。
