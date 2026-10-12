import { describe, expect, it } from "vitest";

import { checkIdentityForm } from "./identity-form";

const base = {
  mode: "login" as const,
  email: "creator@example.com",
  password: "private-password",
  confirmPassword: "",
  displayName: "",
  devTestAccount: false,
};

describe("identity form check", () => {
  it("accepts a login and normalizes the email", () => {
    expect(checkIdentityForm({ ...base, email: "  CREATOR@example.com " })).toEqual({
      ok: true,
      email: "creator@example.com",
      displayName: "",
    });
  });

  it("rejects a phone number typed into the email field instead of asking the server", () => {
    expect(checkIdentityForm({ ...base, email: "1322798576" })).toEqual({
      ok: false,
      message: "请填写完整的邮箱地址，例如 name@example.com",
    });
    expect(checkIdentityForm({ ...base, mode: "register", email: "1322798576" })).toEqual({
      ok: false,
      message: "请填写完整的邮箱地址，例如 name@example.com",
    });
  });

  it("requires a password and the registration password length the API enforces", () => {
    expect(checkIdentityForm({ ...base, password: "" })).toEqual({
      ok: false,
      message: "请输入密码",
    });
    expect(
      checkIdentityForm({ ...base, mode: "register", password: "short", confirmPassword: "short" }),
    ).toEqual({
      ok: false,
      message: "密码需 10-128 位",
    });
    expect(
      checkIdentityForm({
        ...base,
        mode: "register",
        password: "long-enough",
        confirmPassword: "different-password",
      }),
    ).toEqual({
      ok: false,
      message: "两次输入的密码不一致",
    });
  });

  it("keeps optional display names trimmed and validated", () => {
    const registering = { ...base, mode: "register" as const, confirmPassword: base.password };
    expect(checkIdentityForm({ ...registering, displayName: "  创作者  " })).toEqual({
      ok: true,
      email: "creator@example.com",
      displayName: "创作者",
    });
    expect(checkIdentityForm({ ...registering, displayName: "a" })).toEqual({
      ok: false,
      message: "昵称需 2-20 字，仅支持中文、字母、数字、下划线或连字符",
    });
  });

  it("lets the local dev test account through only when the API advertises it", () => {
    expect(
      checkIdentityForm({ ...base, email: "admin", password: "123456", devTestAccount: true }),
    ).toEqual({
      ok: true,
      email: "admin",
      displayName: "",
    });
    expect(
      checkIdentityForm({ ...base, email: "admin", password: "123456", devTestAccount: false }),
    ).toEqual({
      ok: false,
      message: "请填写完整的邮箱地址，例如 name@example.com",
    });
  });
});
