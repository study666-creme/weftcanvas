import {
  DEV_TEST_ACCOUNT_EMAIL,
  identityEmailSchema,
  identityPasswordSchema,
} from "@weftcanvas/contracts";

export type IdentityFormMode = "login" | "register";

export type IdentityFormCheck =
  { ok: true; email: string; displayName: string } | { ok: false; message: string };

const DISPLAY_NAME_PATTERN = /^[\p{Script=Han}A-Za-z0-9_-]{2,20}$/u;

/**
 * 登录/注册的提交前校验。规则直接复用 API 侧同一份 contracts schema（邮箱格式、
 * 注册密码 10-128 位），所以前端拦下的输入服务端一定也接受。
 *
 * 放在组件外是为了让它可测：服务端只认邮箱，而登录页曾经给的是「账号或邮箱」的
 * 暗示，用户拿着手机号提交只换来一句「请求参数不完整或格式不正确」。
 */
export function checkIdentityForm(input: {
  mode: IdentityFormMode;
  email: string;
  password: string;
  confirmPassword: string;
  displayName: string;
  /** 只有 API 明确置位 devTestAccount（非生产环境）时才放行非邮箱账号。 */
  devTestAccount: boolean;
}): IdentityFormCheck {
  const email = input.email.trim();
  const parsedEmail = identityEmailSchema.safeParse(email);
  const devAccountRequest = input.devTestAccount && email.toLowerCase() === DEV_TEST_ACCOUNT_EMAIL;
  if (!devAccountRequest && !parsedEmail.success) {
    return { ok: false, message: "请填写完整的邮箱地址，例如 name@example.com" };
  }
  if (!input.password) return { ok: false, message: "请输入密码" };
  if (input.mode === "register") {
    if (!identityPasswordSchema.safeParse(input.password).success) {
      return { ok: false, message: "密码需 10-128 位" };
    }
    if (input.password !== input.confirmPassword) {
      return { ok: false, message: "两次输入的密码不一致" };
    }
  }
  const displayName = input.displayName.trim();
  if (input.mode === "register" && displayName && !DISPLAY_NAME_PATTERN.test(displayName)) {
    return { ok: false, message: "昵称需 2-20 字，仅支持中文、字母、数字、下划线或连字符" };
  }
  return { ok: true, email: parsedEmail.success ? parsedEmail.data : email, displayName };
}
