"""统一错误：错误码对应 DESIGN §9 envelope.error.code。

DESIGN 列出的错误码之外，补充四个运营性代码（实现必需，文档已注明）：
- CONFIG_INVALID：配置文件/环境变量非法（与 jev-browser 同名约定）
- INVALID_PARAMS：调用参数不满足 schema
- ASSERT_FAILED：execute 的 assert 步骤断言失败
- GOAL_BLOCKED：run/goal 步被阻塞（登录墙/弹窗/验证码等）
- CANCELLED：协作取消信号（不是错误，envelope.status=cancelled）
"""

CODES = [
    "STALE_REF",
    "TARGET_NOT_FOUND",
    "AMBIGUOUS_TARGET",
    "APP_NOT_FOUND",
    "WINDOW_LOST",
    "UIA_UNAVAILABLE",
    "OCR_UNAVAILABLE",
    "PLANNER_NOT_CONFIGURED",
    "PROVIDER_ERROR",
    "INVALID_STEP",
    "BUDGET_EXCEEDED",
    "TIMEOUT",
    "INPUT_DENIED",
    "INTERNAL_ERROR",
    # 实现补充（见模块 docstring）
    "CONFIG_INVALID",
    "INVALID_PARAMS",
    "ASSERT_FAILED",
    "GOAL_BLOCKED",
]


class JevError(Exception):
    """统一错误：code 对应 envelope.error.code；message 面向调用者，可操作。"""

    def __init__(self, code: str, message: str, *, retryable: bool = False, details: dict | None = None):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details = details

    def to_dict(self) -> dict:
        out = {"code": self.code, "message": self.message, "retryable": self.retryable}
        if self.details:
            out["details"] = self.details
        return out


def err(code: str, message: str, *, retryable: bool = False, details: dict | None = None) -> JevError:
    return JevError(code, message, retryable=retryable, details=details)


class CancelledSignal(Exception):
    """协作取消：引擎在步骤间检查取消事件后抛出；envelope.status=cancelled。"""
