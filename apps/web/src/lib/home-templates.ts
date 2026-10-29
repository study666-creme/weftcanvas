/**
 * 主页「灵感模板」：一组写好的起手提示词，按用途分组。
 *
 * 模板只是文字起点——点一下把提示词带进生成框或工作台，由用户自己选模型生成。
 * 这里刻意不配示例图：没有经过真实生成的「效果图」会误导用户对模型产出的预期。
 */

export type HomeTemplateModality = "image" | "video" | "audio";

export type HomeTemplateCategory =
  "poster" | "product" | "character" | "scene" | "storyboard" | "sound";

export type HomeTemplate = {
  id: string;
  category: HomeTemplateCategory;
  modality: HomeTemplateModality;
  title: string;
  prompt: string;
  /** 建议画幅；只作提示，不强行写入参数。 */
  ratio?: string;
};

export const HOME_TEMPLATE_CATEGORIES: { id: HomeTemplateCategory; label: string }[] = [
  { id: "poster", label: "海报与视觉" },
  { id: "product", label: "产品与电商" },
  { id: "character", label: "角色设计" },
  { id: "scene", label: "场景与概念" },
  { id: "storyboard", label: "短片与分镜" },
  { id: "sound", label: "配乐与声音" },
];

export const HOME_TEMPLATES: HomeTemplate[] = [
  {
    id: "poster-film",
    category: "poster",
    modality: "image",
    title: "电影感主视觉海报",
    ratio: "2:3",
    prompt:
      "电影主视觉海报，一位身穿风衣的人物站在雨夜街口，霓虹灯在湿润地面形成长倒影，低机位仰拍，冷暖对比光，画面上方留出标题空间，胶片颗粒，高级感排版",
  },
  {
    id: "poster-minimal",
    category: "poster",
    modality: "image",
    title: "极简几何品牌海报",
    ratio: "3:4",
    prompt:
      "极简主义品牌海报，大面积留白，两三个抽象几何体悬浮于柔和渐变背景之上，柔和投影，克制的配色，瑞士平面设计风格，干净利落",
  },
  {
    id: "poster-festival",
    category: "poster",
    modality: "image",
    title: "国潮节日插画",
    ratio: "3:4",
    prompt:
      "国潮风节日插画，祥云与灯笼环绕的中式庭院，朱红与鎏金配色，扁平插画结合细腻纹样，对称构图，喜庆而不俗气",
  },
  {
    id: "product-cosmetic",
    category: "product",
    modality: "image",
    title: "美妆产品静物",
    ratio: "1:1",
    prompt:
      "高端护肤精华瓶产品摄影，置于浅色大理石台面，旁边点缀水滴与绿植叶片，柔和侧逆光，浅景深，干净的高光反射，商业棚拍质感",
  },
  {
    id: "product-sneaker",
    category: "product",
    modality: "image",
    title: "运动鞋悬浮展示",
    ratio: "4:5",
    prompt:
      "一只运动鞋悬浮在纯色背景前，周围飞溅着细碎的彩色粉尘，戏剧性的轮廓光，超清细节，电商主图构图，鞋面材质纹理清晰",
  },
  {
    id: "product-food",
    category: "product",
    modality: "image",
    title: "美食俯拍",
    ratio: "4:5",
    prompt:
      "俯拍一桌家常菜，木质餐桌，自然窗光，热气微微升起，餐具与亚麻餐布随意摆放，暖色调，杂志美食栏目风格",
  },
  {
    id: "character-sheet",
    category: "character",
    modality: "image",
    title: "角色三视图设定",
    ratio: "16:9",
    prompt:
      "原创角色设定图，正面、侧面、背面三视图，同一角色保持一致，干净的浅灰背景，标注服装与配饰细节，二次元赛璐璐上色",
  },
  {
    id: "character-portrait",
    category: "character",
    modality: "image",
    title: "写实人像特写",
    ratio: "3:4",
    prompt:
      "写实风格人像特写，自然光从窗边洒在脸上，皮肤质感真实，眼神看向镜头外，85mm 镜头浅景深，柔和背景虚化，纪实摄影气质",
  },
  {
    id: "character-mascot",
    category: "character",
    modality: "image",
    title: "品牌吉祥物",
    ratio: "1:1",
    prompt:
      "可爱的品牌吉祥物设计，圆润的造型与友好的表情，三种不同姿势，3D 软萌质感，柔和的工作室布光，纯色背景",
  },
  {
    id: "scene-cyber",
    category: "scene",
    modality: "image",
    title: "赛博朋克城市",
    ratio: "16:9",
    prompt:
      "赛博朋克未来城市夜景，层叠的高楼与空中轨道，全息广告牌在雨雾中发光，街道上行人撑着透明雨伞，广角俯瞰，电影级概念设计",
  },
  {
    id: "scene-ink",
    category: "scene",
    modality: "image",
    title: "水墨山水意境",
    ratio: "16:9",
    prompt:
      "中国水墨画风格的山水长卷，云雾缭绕的群山与一叶扁舟，留白构图，淡墨晕染，宁静悠远的意境",
  },
  {
    id: "scene-interior",
    category: "scene",
    modality: "image",
    title: "日系室内空间",
    ratio: "4:3",
    prompt:
      "日式侘寂风格客厅，原木家具与亚麻沙发，午后阳光透过纸窗投下柔和光影，室内植物，安静温暖的生活感，建筑摄影",
  },
  {
    id: "storyboard-push",
    category: "storyboard",
    modality: "video",
    title: "产品推镜开场",
    ratio: "16:9",
    prompt:
      "镜头从黑暗中缓慢推近，一束光逐渐照亮桌面上的产品，细小的尘埃在光束中漂浮，最后定格在产品特写，节奏沉稳，商业广告质感",
  },
  {
    id: "storyboard-nature",
    category: "storyboard",
    modality: "video",
    title: "云海延时",
    ratio: "16:9",
    prompt:
      "山顶云海的延时摄影，云层像潮水一样翻涌流动，太阳从地平线升起，光线由冷转暖，固定机位，壮阔宁静",
  },
  {
    id: "storyboard-street",
    category: "storyboard",
    modality: "video",
    title: "雨夜街头跟拍",
    ratio: "9:16",
    prompt:
      "手持跟拍一位撑伞的人走过雨夜街头，霓虹灯倒映在积水里，雨滴在镜头前划过，浅景深，电影感调色，竖屏短视频",
  },
  {
    id: "sound-lofi",
    category: "sound",
    modality: "audio",
    title: "Lo-fi 学习节奏",
    prompt:
      "温暖的 Lo-fi Hip-hop 器乐，慵懒的鼓点，带黑胶底噪的电钢琴和弦，适合学习与专注，约 80 BPM",
  },
  {
    id: "sound-cinematic",
    category: "sound",
    modality: "audio",
    title: "史诗预告片配乐",
    prompt: "史诗感电影预告片配乐，低沉的弦乐铺垫逐步推进，打击乐与铜管在高潮爆发，结尾留出余韵",
  },
  {
    id: "sound-voice",
    category: "sound",
    modality: "audio",
    title: "产品讲解旁白",
    prompt: "自然亲切的中文女声旁白，语速适中，用轻松的语气介绍一款新上市的智能手表的三个核心功能",
  },
];

export function templatesForCategory(category: HomeTemplateCategory | "all") {
  return category === "all"
    ? HOME_TEMPLATES
    : HOME_TEMPLATES.filter((template) => template.category === category);
}
