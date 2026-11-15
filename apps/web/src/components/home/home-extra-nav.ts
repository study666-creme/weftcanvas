export type HomeExtraNavItem = {
  href: string;
  label: string;
  title: string;
};

/**
 * 公开树（物化覆盖）：自托管的开源构建没有内容库，侧栏不渲染额外外链入口。
 */
export const HOME_EXTRA_NAV: HomeExtraNavItem[] = [];
