"""纬线 Blender 桥接（Blender 插件形态）。

两种工作模式，面板里切换：

- **远程模式（默认，给托管站点用户）**：插件主动连到画布服务端，用画布面板里生成的
  「配对令牌」鉴权，轮询领取任务（执行 Python）并回传结果。用户机器不需要暴露任何端口，
  服务端也不需要（也不该）装 Blender。令牌存在 Blender 用户偏好里，不会随 .blend 文件外传。
- **本机模式（开发/自托管）**：在本机回环地址起一个 TCP 端口，由同机的 Agent 运行时直连。
  端口对执行接口做了两道限制：**只允许绑定回环地址**（127.0.0.1 / ::1 / localhost），
  且每个请求都必须带上访问令牌；没有令牌或令牌不对的请求在进入执行队列之前就被拒绝。

协议：
  · 远程：POST {server}/api/external/v1/connectors/poll   （Bearer 配对令牌）
          POST {server}/api/external/v1/connectors/results
  · 本机：一行一个 JSON，见 WeftcanvasBridgeServer。请求形状
          {"id": "...", "method": "run_python", "params": {...}, "token": "<访问令牌>"}

**安全边界**：run_python 会在 Blender 主线程执行任意 Python，等同于把 Blender 所在的那台机器
交给能通过鉴权的一方控制——两种模式的令牌都等同于本机代码执行权限，不要分享；
怀疑泄露就重新生成（本机模式在面板里点「重新生成令牌」，远程模式在画布面板里重新配对）。

本机模式的访问令牌不落在 .blend、不进日志、不进 Git：它由桥接生成在用户主目录的令牌文件里
（默认 `~/.weftcanvas-bridge/token`，POSIX 下权限 0600，可用 WEFTCANVAS_BRIDGE_TOKEN_FILE 改路径，
或用 WEFTCANVAS_BRIDGE_TOKEN 直接指定）；同机的 Agent 运行时读同一个文件，因此不需要任何手工配对。
"""

import contextlib
import hmac
import io
import json
import os
import queue
import secrets
import socket
import threading
import traceback

import bpy

bl_info = {
    "name": "纬线桥接",
    "author": "Weftcanvas",
    "version": (1, 1, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > 纬线",
    "description": "让纬线 Agent 在本机 Blender 中执行 Python",
    "category": "Development",
}

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9876

# 本机模式的访问令牌（远端 Agent 运行时读同一个来源，无需手工配对）。
TOKEN_ENV = "WEFTCANVAS_BRIDGE_TOKEN"
TOKEN_FILE_ENV = "WEFTCANVAS_BRIDGE_TOKEN_FILE"
DEFAULT_TOKEN_FILE = os.path.join(os.path.expanduser("~"), ".weftcanvas-bridge", "token")
# 令牌的随机字节数；token_urlsafe(32) 得到 43 个 URL 安全字符。
TOKEN_BYTES = 32
MIN_TOKEN_CHARS = 32
# 本机模式只允许回环地址：这个端口能执行任意 Python，绑到非回环地址就是对外放了一个
# 远程代码执行入口。要跨机使用请走远程模式（连接画布）。
LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")
LOOPBACK_PREFIXES = ("127.",)

_TASK_QUEUE: "queue.Queue" = queue.Queue()
_STDOUT_BUFFER = io.StringIO()
_MAX_REQUEST_BYTES = 4 * 1024 * 1024

_REGISTERED = False
_SERVER = None
_STATUS = "未启动"
_TOKEN = None  # 本机模式的当前访问令牌，见 _ensure_token()


def token_file_path():
    """令牌文件路径：可用 WEFTCANVAS_BRIDGE_TOKEN_FILE 覆盖，默认在用户主目录下。"""
    override = os.environ.get(TOKEN_FILE_ENV, "").strip()
    return override or DEFAULT_TOKEN_FILE


def _write_token_file(path, token):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(directory, 0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(token)
    except Exception:
        with contextlib.suppress(OSError):
            os.close(descriptor)
        raise
    with contextlib.suppress(OSError):
        os.chmod(path, 0o600)


def load_or_create_token(path=None):
    """读令牌文件；缺失或明显不合格时生成新的强随机令牌并落盘。"""
    target = path or token_file_path()
    try:
        with open(target, encoding="utf-8") as handle:
            existing = handle.read().strip()
    except OSError:
        existing = ""
    if len(existing) >= MIN_TOKEN_CHARS:
        return existing
    token = secrets.token_urlsafe(TOKEN_BYTES)
    _write_token_file(target, token)
    return token


def rotate_token(path=None):
    """重新生成令牌：旧令牌立即失效，同机 Agent 会从同一个文件读到新的。"""
    global _TOKEN
    token = secrets.token_urlsafe(TOKEN_BYTES)
    _write_token_file(path or token_file_path(), token)
    _TOKEN = token
    return token


def _ensure_token():
    """准备本机模式令牌。写不出文件时宁可起不来，也不能开一个无认证的执行端口。"""
    global _TOKEN
    if _TOKEN:
        return _TOKEN
    from_env = os.environ.get(TOKEN_ENV, "").strip()
    if from_env:
        _TOKEN = from_env
        return _TOKEN
    _TOKEN = load_or_create_token()
    return _TOKEN


def _token_matches(supplied):
    current = _TOKEN
    if not current or not isinstance(supplied, str) or not supplied:
        return False
    # 常量时间比较：类型/编码差异也必须先归一成 bytes，否则 compare_digest 会抛异常。
    try:
        return hmac.compare_digest(supplied.encode("utf-8"), current.encode("utf-8"))
    except (TypeError, UnicodeError):
        return False


def _host_is_loopback(host):
    value = (host or "").strip().lower()
    if value in LOOPBACK_HOSTS:
        return True
    return value.startswith(LOOPBACK_PREFIXES)


def _execute(code):
    """在 Blender 主线程执行一段 Python，返回 (stdout, value)。"""
    _STDOUT_BUFFER.seek(0)
    _STDOUT_BUFFER.truncate(0)
    scope = {
        "__name__": "__weftcanvas__",
        "bpy": bpy,
        "RESULT": None,
    }
    with contextlib.redirect_stdout(_STDOUT_BUFFER):
        exec(compile(code, "<weftcanvas_bridge>", "exec"), scope)
    return _STDOUT_BUFFER.getvalue(), scope.get("RESULT")


def _scene_summary():
    scene = bpy.context.scene
    objects = [
        {
            "name": item.name,
            "type": item.type,
            "location": [round(value, 4) for value in item.location],
        }
        for item in scene.objects
    ]
    return {
        "scene": scene.name,
        "objectCount": len(objects),
        "objects": objects[:200],
        "materials": [material.name for material in bpy.data.materials][:200],
        "frameRange": [scene.frame_start, scene.frame_end],
    }


def _handle_request(message):
    method = message.get("method")
    params = message.get("params") or {}
    if method == "ping":
        return {"ok": True, "result": {"stdout": "", "value": {"blender": bpy.app.version_string}}}
    if method == "scene_summary":
        return {"ok": True, "result": {"stdout": "", "value": _scene_summary()}}
    if method == "run_python":
        code = params.get("code")
        if not isinstance(code, str) or not code.strip():
            return {"ok": False, "error": "缺少要执行的 Python 代码"}
        stdout, value = _execute(code)
        return {"ok": True, "result": {"stdout": stdout, "value": _json_safe(value)}}
    return {"ok": False, "error": "不支持的方法 %s" % method}


def _json_safe(value):
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return repr(value)


def _pump():
    """由 bpy 计时器在主线程驱动：执行排队中的请求。两种模式共用这一个执行点。"""
    while True:
        # 本机 TCP 模式：连接还在，执行完直接把响应写回 socket。
        try:
            connection, payload, request_id = _TASK_QUEUE.get_nowait()
        except queue.Empty:
            break
        try:
            body = _handle_request(payload)
            body["id"] = request_id
        except Exception as error:  # noqa: BLE001 - 桥接必须把错误原样回给调用方
            body = {"id": request_id, "ok": False, "error": "%s: %s" % (type(error).__name__, error),
                    "traceback": traceback.format_exc()[-2000:]}
        try:
            connection.sendall((json.dumps(body, ensure_ascii=False) + "\n").encode("utf-8"))
        finally:
            with contextlib.suppress(OSError):
                connection.close()

    # 远程模式：执行结果交给网络线程回传。
    while True:
        try:
            task = _REMOTE_IN.get_nowait()
        except queue.Empty:
            break
        task_id = task.get("id")
        try:
            body = _handle_request(task)
            result = body.get("result") or {}
            stdout = result.get("stdout") or ""
            value = result.get("value")
            if value is not None:
                stdout = "%s\nRESULT = %s" % (stdout, json.dumps(value, ensure_ascii=False))
            _REMOTE_OUT.put({
                "connectorId": "blender",
                "taskId": task_id,
                "ok": bool(body.get("ok")),
                "stdout": stdout[:20_000],
                "error": None if body.get("ok") else str(body.get("error") or "执行失败")[:2_000],
            })
        except Exception as error:  # noqa: BLE001
            _REMOTE_OUT.put({
                "connectorId": "blender",
                "taskId": task_id,
                "ok": False,
                "stdout": "",
                "error": "%s: %s" % (type(error).__name__, error),
            })
    return 0.05


class WeftcanvasBridgeServer(threading.Thread):
    def __init__(self, host=DEFAULT_HOST, port=DEFAULT_PORT):
        super().__init__(daemon=True)
        self.host = host
        self.port = port
        self._stop = threading.Event()
        self._socket = None
        self._timer_registered = False

    def run(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((self.host, self.port))
        server.listen(4)
        server.settimeout(0.5)
        self._socket = server
        while not self._stop.is_set():
            try:
                connection, _ = server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._read_client, args=(connection,), daemon=True).start()
        with contextlib.suppress(OSError):
            server.close()

    def _read_client(self, connection):
        connection.settimeout(5.0)
        buffer = b""
        try:
            while b"\n" not in buffer:
                chunk = connection.recv(65536)
                if not chunk:
                    connection.close()
                    return
                buffer += chunk
                if len(buffer) > _MAX_REQUEST_BYTES:
                    raise ValueError("请求过大")
        except (OSError, ValueError) as error:
            with contextlib.suppress(OSError):
                connection.sendall((json.dumps({"ok": False, "error": str(error)}) + "\n").encode("utf-8"))
                connection.close()
            return
        line = buffer.split(b"\n", 1)[0].decode("utf-8", "replace")
        try:
            payload = json.loads(line)
        except ValueError:
            with contextlib.suppress(OSError):
                connection.sendall((json.dumps({"ok": False, "error": "请求不是合法 JSON"}) + "\n").encode("utf-8"))
                connection.close()
            return
        # 鉴权在入队之前：未通过令牌校验的请求永远不会到达 _handle_request/_execute。
        if not isinstance(payload, dict) or not _token_matches(payload.get("token")):
            with contextlib.suppress(OSError):
                connection.sendall(
                    (
                        json.dumps(
                            {
                                "ok": False,
                                "error": "认证失败：访问令牌缺失或不正确。请重启 Blender 桥接或重新一键配置。",
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    ).encode("utf-8")
                )
                connection.close()
            return
        _TASK_QUEUE.put((connection, payload, payload.get("id")))

    def start_pump(self):
        if self._timer_registered:
            return
        self._timer_registered = True
        if not bpy.app.timers.is_registered(_pump):
            bpy.app.timers.register(_pump, first_interval=0.05, persistent=True)

    def stop_pump(self):
        self._timer_registered = False
        if bpy.app.timers.is_registered(_pump):
            bpy.app.timers.unregister(_pump)

    def stop(self):
        self._stop.set()
        self.stop_pump()
        with contextlib.suppress(OSError):
            if self._socket:
                self._socket.close()


def _host():
    scene = getattr(bpy.context, "scene", None)
    return getattr(scene, "weftcanvas_bridge_host", DEFAULT_HOST) or DEFAULT_HOST


def _port():
    scene = getattr(bpy.context, "scene", None)
    return int(getattr(scene, "weftcanvas_bridge_port", DEFAULT_PORT) or DEFAULT_PORT)


def start_bridge(host=None, port=None):
    """启动本机监听。返回 (是否已启动, 说明)。已在运行时视为成功。"""
    global _SERVER, _STATUS
    target_host = (host or _host()).strip()
    # 地址校验先于「已在运行」判断：绑错地址永远要被明确拒绝，而不是被静默忽略。
    if not _host_is_loopback(target_host):
        _STATUS = "拒绝启动：本机模式只允许回环地址（127.0.0.1 / ::1），当前地址是 %s；跨机使用请改用远程模式" % target_host
        return False, _STATUS
    if _SERVER is not None and _SERVER.is_alive():
        return True, "桥接已在运行 %s:%s" % (_SERVER.host, _SERVER.port)
    target_port = int(port or _port())
    try:
        _ensure_token()
    except Exception as error:  # noqa: BLE001 - 起不来必须说清原因，不能开无认证端口
        _STATUS = "启动失败：无法准备访问令牌（%s）" % error
        return False, _STATUS
    server = WeftcanvasBridgeServer(host=target_host, port=target_port)
    try:
        server.start()
    except OSError as error:
        _STATUS = "启动失败：%s" % error
        return False, _STATUS
    _SERVER = server
    server.start_pump()
    _STATUS = "运行中 %s:%s" % (target_host, target_port)
    return True, _STATUS


def stop_bridge():
    global _SERVER, _STATUS
    if _SERVER is not None:
        _SERVER.stop()
        _SERVER = None
    _STATUS = "已停止"
    return _STATUS


# ---------------------------------------------------------------- 远程模式
# 插件主动出站连到画布服务端：用户机器不监听任何端口，服务端也不需要装 Blender。

DEFAULT_SERVER_URL = ""  # 由用户在插件设置里填自己的画布服务端
DEFAULT_INTERVAL_S = 3.0
# 直接 --python 运行时没有插件偏好，退回这里的模块级设置。
_FALLBACK_SETTINGS = {
    "server_url": DEFAULT_SERVER_URL,
    "token": "",
    "interval": DEFAULT_INTERVAL_S,
    "mode": "remote",
}

_REMOTE_IN: "queue.Queue" = queue.Queue()
_REMOTE_OUT: "queue.Queue" = queue.Queue()
_REMOTE_STOP = threading.Event()
_REMOTE_THREAD = None
_REMOTE_STATUS = "未启动"


def _preferences():
    """返回插件偏好；直接 --python 运行（没有插件注册）时退回模块级设置。"""
    package = __package__ or ""
    try:
        addon = bpy.context.preferences.addons[package]
        return addon.preferences
    except Exception:
        return None


def _remote_setting(name):
    prefs = _preferences()
    if prefs is not None:
        value = getattr(prefs, name, None)
        if value not in (None, ""):
            return value
        if name == "token":
            return ""
    return _FALLBACK_SETTINGS[name]


def _set_remote_status(message):
    global _REMOTE_STATUS
    _REMOTE_STATUS = message


def _http_post(url, token, payload):
    import urllib.request

    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": "Bearer %s" % token,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def _remote_poll(server_url, token, connector_id):
    """领取任务；返回 (任务列表, 建议的下一轮间隔秒数)。"""
    data = _http_post(
        server_url.rstrip("/") + "/api/external/v1/connectors/poll",
        token,
        {"connectorId": connector_id},
    )
    payload = data.get("data") if isinstance(data, dict) else None
    if not isinstance(payload, dict):
        raise ValueError("服务端返回了无法识别的数据")
    tasks = payload.get("tasks") or []
    poll_after_ms = payload.get("pollAfterMs") or 3000
    return tasks, max(1.0, float(poll_after_ms) / 1000.0)


def _remote_report(server_url, token, result):
    _http_post(
        server_url.rstrip("/") + "/api/external/v1/connectors/results",
        token,
        result,
    )


def _remote_loop(server_url, token, connector_id, interval):
    while not _REMOTE_STOP.is_set():
        try:
            tasks, poll_after = _remote_poll(server_url, token, connector_id)
            for task in tasks:
                _REMOTE_IN.put(task)
            _set_remote_status("已连接 %s" % server_url)
        except Exception as error:  # noqa: BLE001 - 网络/鉴权问题都要显示到面板，不能静默
            _set_remote_status("连接异常：%s" % error)
            poll_after = max(interval, 5.0)

        flushed = False
        while True:
            try:
                result = _REMOTE_OUT.get_nowait()
            except queue.Empty:
                break
            try:
                _remote_report(server_url, token, result)
                flushed = True
            except Exception as error:  # noqa: BLE001
                _set_remote_status("回传失败：%s" % error)
        _REMOTE_STOP.wait(1.0 if flushed else poll_after)


def start_remote(server_url=None, token=None):
    """启动远程轮询线程。返回 (是否已启动, 说明)。"""
    global _REMOTE_THREAD
    if _REMOTE_THREAD is not None and _REMOTE_THREAD.is_alive():
        return True, "远程连接已在运行"
    target_url = (server_url or _remote_setting("server_url") or DEFAULT_SERVER_URL).strip()
    target_token = (token if token is not None else _remote_setting("token") or "").strip()
    if not target_token:
        _set_remote_status("还没有配对令牌：请在画布面板里生成后粘贴到这里")
        return False, _REMOTE_STATUS
    if not target_url.startswith(("http://", "https://")):
        _set_remote_status("服务地址必须以 http(s):// 开头")
        return False, _REMOTE_STATUS

    _REMOTE_STOP.clear()
    _REMOTE_THREAD = threading.Thread(
        target=_remote_loop,
        args=(target_url, target_token, "blender", float(_remote_setting("interval") or DEFAULT_INTERVAL_S)),
        daemon=True,
    )
    _REMOTE_THREAD.start()
    if not bpy.app.timers.is_registered(_pump):
        bpy.app.timers.register(_pump, first_interval=0.05, persistent=True)
    _set_remote_status("正在连接 %s" % target_url)
    return True, _REMOTE_STATUS


def stop_remote():
    global _REMOTE_THREAD
    _REMOTE_STOP.set()
    _REMOTE_THREAD = None
    _set_remote_status("已停止")
    return _REMOTE_STATUS


def _remote_active():
    return _REMOTE_THREAD is not None and _REMOTE_THREAD.is_alive()


def remote_status():
    return _REMOTE_STATUS


def _auto_start_enabled():
    scene = getattr(bpy.context, "scene", None)
    return bool(getattr(scene, "weftcanvas_bridge_auto_start", True))


class WEFTCANVAS_OT_start_bridge(bpy.types.Operator):
    bl_idname = "weftcanvas.start_bridge"
    bl_label = "启动本机监听"

    def execute(self, context):
        ok, message = start_bridge()
        self.report({"INFO"} if ok else {"ERROR"}, message)
        return {"FINISHED"} if ok else {"CANCELLED"}


class WEFTCANVAS_OT_stop_bridge(bpy.types.Operator):
    bl_idname = "weftcanvas.stop_bridge"
    bl_label = "停止本机监听"

    def execute(self, context):
        self.report({"INFO"}, stop_bridge())
        return {"FINISHED"}


class WEFTCANVAS_OT_rotate_token(bpy.types.Operator):
    bl_idname = "weftcanvas.rotate_token"
    bl_label = "重新生成访问令牌"
    bl_description = "旧令牌立即失效；同机的 Agent 运行时从同一个令牌文件自动读到新的"

    def execute(self, context):
        try:
            rotate_token()
        except OSError as error:
            self.report({"ERROR"}, "无法写入令牌文件：%s" % error)
            return {"CANCELLED"}
        self.report({"INFO"}, "已重新生成访问令牌")
        return {"FINISHED"}


class WEFTCANVAS_OT_start_remote(bpy.types.Operator):
    bl_idname = "weftcanvas.start_remote"
    bl_label = "连接画布"

    def execute(self, context):
        ok, message = start_remote()
        self.report({"INFO"} if ok else {"ERROR"}, message)
        return {"FINISHED"} if ok else {"CANCELLED"}


class WEFTCANVAS_OT_stop_remote(bpy.types.Operator):
    bl_idname = "weftcanvas.stop_remote"
    bl_label = "断开画布"

    def execute(self, context):
        self.report({"INFO"}, stop_remote())
        return {"FINISHED"}


class WEFTCANVAS_AP_preferences(bpy.types.AddonPreferences):
    """令牌放在插件偏好里（userpref），不会随 .blend 文件外传。"""

    bl_idname = __package__ or __name__

    server_url: bpy.props.StringProperty(name="服务地址", default=DEFAULT_SERVER_URL)
    token: bpy.props.StringProperty(name="配对令牌", default="", subtype="PASSWORD")
    interval: bpy.props.FloatProperty(name="轮询间隔（秒）", default=DEFAULT_INTERVAL_S, min=1.0, max=60.0)

    def draw(self, context):
        layout = self.layout
        layout.label(text="在画布 Agent 面板的「外部连接」里生成配对令牌，粘贴到这里。", icon="INFO")
        layout.prop(self, "server_url")
        layout.prop(self, "token")
        layout.prop(self, "interval")


def _mode():
    scene = getattr(bpy.context, "scene", None)
    return getattr(scene, "weftcanvas_bridge_mode", "remote")


class WEFTCANVAS_PT_bridge_panel(bpy.types.Panel):
    bl_label = "纬线桥接"
    bl_idname = "WEFTCANVAS_PT_bridge_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "纬线"

    def draw(self, context):
        layout = self.layout
        layout.prop(context.scene, "weftcanvas_bridge_mode", text="模式")

        if _mode() == "remote":
            active = _remote_active()
            layout.label(text="状态：%s" % remote_status(), icon="LINKED" if active else "UNLINKED")
            prefs = _preferences()
            if prefs is not None:
                layout.prop(prefs, "server_url")
                layout.prop(prefs, "token")
                layout.prop(prefs, "interval")
            else:
                layout.label(text="（--python 运行：请在插件偏好里配置令牌）", icon="ERROR")
            row = layout.row(align=True)
            row.operator("weftcanvas.start_remote", icon="PLAY")
            row.operator("weftcanvas.stop_remote", icon="PAUSE")
        else:
            running = bool(_SERVER and _SERVER.is_alive())
            layout.label(text="状态：%s" % (_STATUS if not running else "运行中"), icon="PLAY" if running else "PAUSE")
            row = layout.row(align=True)
            row.operator("weftcanvas.start_bridge", icon="PLAY")
            row.operator("weftcanvas.stop_bridge", icon="PAUSE")
            column = layout.column(align=True)
            column.prop(context.scene, "weftcanvas_bridge_host", text="地址")
            column.prop(context.scene, "weftcanvas_bridge_port", text="端口")
            if _TOKEN:
                layout.label(text="访问令牌已就绪（%s）" % token_file_path(), icon="LOCKED")
            else:
                layout.label(text="启动时会在 %s 生成访问令牌" % token_file_path(), icon="INFO")
            layout.operator("weftcanvas.rotate_token", icon="FILE_REFRESH")

        layout.prop(context.scene, "weftcanvas_bridge_auto_start", text="随 Blender 自动启动")


_CLASSES = (
    WEFTCANVAS_OT_start_bridge,
    WEFTCANVAS_OT_stop_bridge,
    WEFTCANVAS_OT_rotate_token,
    WEFTCANVAS_OT_start_remote,
    WEFTCANVAS_OT_stop_remote,
    WEFTCANVAS_PT_bridge_panel,
)


def register():
    """插件启用时调用；打开 Blender 后按所选模式自动连上。"""
    global _REGISTERED
    if _REGISTERED:
        return
    _REGISTERED = True
    # 只有作为插件安装时才有 AddonPreferences；直接 --python 运行时跳过。
    if __package__:
        with contextlib.suppress(Exception):
            bpy.utils.register_class(WEFTCANVAS_AP_preferences)
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    if not hasattr(bpy.types.Scene, "weftcanvas_bridge_host"):
        bpy.types.Scene.weftcanvas_bridge_host = bpy.props.StringProperty(name="地址", default=DEFAULT_HOST)
        bpy.types.Scene.weftcanvas_bridge_port = bpy.props.IntProperty(name="端口", default=DEFAULT_PORT, min=1, max=65535)
    if not hasattr(bpy.types.Scene, "weftcanvas_bridge_mode"):
        bpy.types.Scene.weftcanvas_bridge_mode = bpy.props.EnumProperty(
            name="模式",
            items=(
                ("remote", "连接画布", "主动连到画布服务端（托管站点用户选这个）"),
                ("local", "本机监听", "在本机开端口，由同机 Agent 运行时直连（开发用）"),
            ),
            default="remote",
        )
    if not hasattr(bpy.types.Scene, "weftcanvas_bridge_auto_start"):
        bpy.types.Scene.weftcanvas_bridge_auto_start = bpy.props.BoolProperty(
            name="随 Blender 自动启动", default=True,
        )
    if _auto_start_enabled():
        if _mode() == "remote":
            start_remote()
        else:
            start_bridge()


def unregister():
    global _REGISTERED
    stop_remote()
    stop_bridge()
    _REGISTERED = False
    for cls in _CLASSES:
        with contextlib.suppress(ValueError):
            bpy.utils.unregister_class(cls)
    if __package__:
        with contextlib.suppress(Exception):
            bpy.utils.unregister_class(WEFTCANVAS_AP_preferences)
    for prop in ("weftcanvas_bridge_host", "weftcanvas_bridge_port", "weftcanvas_bridge_mode", "weftcanvas_bridge_auto_start"):
        if hasattr(bpy.types.Scene, prop):
            with contextlib.suppress(AttributeError):
                delattr(bpy.types.Scene, prop)


if __name__ == "__main__":
    register()
    print("[weftcanvas] 模式=%s 状态=%s。在画布 Agent 面板的「外部连接」里配对。" % (_mode(), remote_status() if _mode() == "remote" else _STATUS))
