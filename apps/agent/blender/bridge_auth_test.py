"""本机 TCP 桥接的认证回归测试（不需要 Blender）。

用最小 bpy 替身导入桥接模块，直接对本机 TCP 端口发请求，覆盖：

- 没有令牌的请求被拒绝，且不会进入执行队列（代码不执行）。
- 错误令牌 / 非字符串令牌 / 令牌放在 params 里的请求都被拒绝。
- 正确令牌可以执行合法命令（ping 与 run_python）。
- 非法监听地址（非回环）被拒绝启动。
- 令牌轮换后旧令牌立即失效、新令牌生效。
- 令牌不落在状态文案里；POSIX 下令牌文件权限为 0600。

CI（ubuntu，自带 python3）里直接运行：

    python3 apps/agent/blender/bridge_auth_test.py

文件名与品牌无关：测试通过 glob 找同目录下的 *_bridge.py，私有树是
weftcanvas_bridge.py、公开树是 weftcanvas_bridge.py，两边都能跑。
"""

import glob
import importlib.util
import json
import os
import pathlib
import socket
import sys
import tempfile
import threading
import time
import types
import unittest


def load_bridge_module():
    install_bpy_stub()
    here = pathlib.Path(__file__).resolve().parent
    candidates = [p for p in sorted(here.glob("*_bridge.py")) if p.name != pathlib.Path(__file__).name]
    if not candidates:
        raise RuntimeError("同目录下找不到 *_bridge.py")
    module_path = candidates[0]
    spec = importlib.util.spec_from_file_location("bridge_under_test", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 %s" % module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["bridge_under_test"] = module
    spec.loader.exec_module(module)
    return module


def install_bpy_stub():
    """桥接模块 import bpy：测试只需要 app.timers 与 app.version_string。"""
    timers = types.SimpleNamespace(
        is_registered=lambda callback: False,
        register=lambda *args, **kwargs: None,
        unregister=lambda *args, **kwargs: None,
    )
    bpy = types.SimpleNamespace(app=types.SimpleNamespace(version_string="4.2.0-stub", timers=timers))
    sys.modules["bpy"] = bpy
    return bpy


class BridgeHarness:
    """一个已启动在回环地址上的桥接实例；请求后由测试手动驱动 _pump()。"""

    def __init__(self, token_file: str, env_token: str | None = None):
        self.token_file = token_file
        os.environ["WEFTCANVAS_BRIDGE_TOKEN_FILE"] = token_file
        if env_token:
            os.environ["WEFTCANVAS_BRIDGE_TOKEN"] = env_token
        else:
            os.environ.pop("WEFTCANVAS_BRIDGE_TOKEN", None)
        self.bridge = load_bridge_module()
        self.port = self._free_port()
        ok, message = self.bridge.start_bridge("127.0.0.1", self.port)
        if not ok:
            raise RuntimeError("桥接没有启动：%s" % message)
        self.message = message

    @staticmethod
    def _free_port() -> int:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        return port

    def _connect(self, timeout: float = 5.0):
        deadline = time.time() + timeout
        while True:
            try:
                return socket.create_connection(("127.0.0.1", self.port), timeout=timeout)
            except OSError:
                if time.time() >= deadline:
                    raise
                time.sleep(0.02)

    def request(self, payload, timeout=5.0):
        with self._connect(timeout) as client:
            client.settimeout(timeout)
            client.sendall((json.dumps(payload) + "\n").encode("utf-8"))
            self._drive_pump()
            buffer = b""
            while b"\n" not in buffer:
                chunk = client.recv(65536)
                if not chunk:
                    break
                buffer += chunk
        line = buffer.split(b"\n", 1)[0].decode("utf-8", "replace") if buffer else ""
        if not line:
            return None
        try:
            return json.loads(line)
        except ValueError:
            raise RuntimeError("响应不是合法 JSON：%r" % line)

    def _drive_pump(self, deadline_seconds=5.0):
        deadline = time.time() + deadline_seconds
        while time.time() < deadline:
            self.bridge._pump()
            time.sleep(0.01)

    def read_token(self) -> str:
        with open(self.token_file, encoding="utf-8") as handle:
            return handle.read().strip()

    def stop(self):
        self.bridge.stop_bridge()


class BridgeAuthTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.harness = BridgeHarness(os.path.join(self._tmp.name, "token"))

    def tearDown(self):
        self.harness.stop()

    def test_start_generates_strong_token_file(self):
        token = self.harness.read_token()
        self.assertGreaterEqual(len(token), 32)
        status = self.harness.bridge._STATUS
        self.assertNotIn(token, status)

    def test_request_without_token_is_rejected_before_execution(self):
        marker = os.path.join(self._tmp.name, "no-token-marker")
        response = self.harness.request(
            {"id": "r1", "method": "run_python", "params": {"code": "open(%r, 'w').write('x')" % marker}}
        )
        self.assertIsNotNone(response)
        self.assertFalse(response.get("ok"))
        self.assertIn("认证失败", str(response.get("error")))
        self.assertFalse(os.path.exists(marker), "未认证请求的代码不应该被执行")

    def test_request_with_wrong_token_is_rejected(self):
        marker = os.path.join(self._tmp.name, "wrong-token-marker")
        response = self.harness.request(
            {
                "id": "r2",
                "method": "run_python",
                "params": {"code": "open(%r, 'w').write('x')" % marker},
                "token": "0" * 43,
            }
        )
        self.assertFalse(response.get("ok"))
        self.assertIn("认证失败", str(response.get("error")))
        self.assertFalse(os.path.exists(marker))

    def test_token_inside_params_cannot_bypass_auth(self):
        response = self.harness.request(
            {"id": "r3", "method": "ping", "params": {"token": self.harness.read_token()}}
        )
        self.assertFalse(response.get("ok"))
        self.assertIn("认证失败", str(response.get("error")))

    def test_non_string_token_is_rejected(self):
        token = self.harness.read_token()
        for bad in (123, ["x"], None, True):
            response = self.harness.request({"id": "r4", "method": "ping", "token": bad})
            self.assertFalse(response.get("ok"), "非字符串令牌 %r 应被拒绝" % bad)
            self.assertIn("认证失败", str(response.get("error")))

    def test_correct_token_can_ping(self):
        response = self.harness.request({"id": "r5", "method": "ping", "token": self.harness.read_token()})
        self.assertTrue(response.get("ok"))
        self.assertIn("4.2.0", str(response.get("result", {}).get("value")))

    def test_correct_token_can_run_python(self):
        marker = os.path.join(self._tmp.name, "exec-marker")
        code = "print('bridge-ok')\nopen(%r, 'w').write('x')\nRESULT = 'done'" % marker
        response = self.harness.request(
            {"id": "r6", "method": "run_python", "params": {"code": code}, "token": self.harness.read_token()}
        )
        self.assertTrue(response.get("ok"))
        self.assertIn("bridge-ok", str(response.get("result", {}).get("stdout")))
        self.assertEqual(response.get("result", {}).get("value"), "done")
        self.assertTrue(os.path.exists(marker))

    def test_non_loopback_bind_is_refused(self):
        for host in ("0.0.0.0", "192.168.1.10", "::"):
            ok, message = self.harness.bridge.start_bridge(host, self.harness._free_port())
            self.assertFalse(ok, "非回环地址 %s 应被拒绝" % host)
            self.assertIn("回环", message)

    def test_rotation_invalidates_old_token(self):
        old_token = self.harness.read_token()
        self.harness.bridge.rotate_token()
        new_token = self.harness.read_token()
        self.assertNotEqual(old_token, new_token)
        rejected = self.harness.request({"id": "r7", "method": "ping", "token": old_token})
        self.assertFalse(rejected.get("ok"))
        accepted = self.harness.request({"id": "r8", "method": "ping", "token": new_token})
        self.assertTrue(accepted.get("ok"))

    @unittest.skipUnless(os.name == "posix", "POSIX 权限断言只在类 Unix 系统上有意义")
    def test_token_file_permissions_are_restrictive(self):
        mode = os.stat(self.harness.token_file).st_mode & 0o777
        self.assertEqual(mode, 0o600, "令牌文件应为 0600")

    def test_token_env_override_is_honored(self):
        # WEFTCANVAS_BRIDGE_TOKEN 直配时不需要令牌文件（容器/CI 场景）。
        file_path = os.path.join(self._tmp.name, "unused-token-file")
        env_token = "env-direct-token-0123456789abcdef"
        harness = BridgeHarness(file_path, env_token=env_token)
        self.addCleanup(harness.stop)
        self.assertFalse(os.path.exists(file_path), "env 直配时不应写令牌文件")
        response = harness.request({"id": "r9", "method": "ping", "token": env_token})
        self.assertTrue(response.get("ok"))
        rejected = harness.request({"id": "r10", "method": "ping", "token": "wrong-token-0123456789abcdef"})
        self.assertFalse(rejected.get("ok"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
