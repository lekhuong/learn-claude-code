# s14: MCP Tools — Phát hiện và gọi tool bên ngoài

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

[s04](../s04_hooks/) → `s14` → [s15](../s15_integrated_harness/) → s16 → s17

> **Tầng Harness**: MCP Tools — kết nối tới dịch vụ, phát hiện tool, rồi thêm chúng vào vòng lặp Agent.

---

## Vấn đề

Các tool cơ bản ở các chương trước được viết trực tiếp trong `code.py`. Ta có thể tích hợp hệ thống tài liệu và nền tảng triển khai bằng cách thêm `search_docs`, `deploy_status`, và `trigger_deploy`, nhưng mỗi dịch vụ lại đòi một bộ định nghĩa tool, schema tham số, và handler gọi riêng.

MCP tách các trách nhiệm đó. Server cung cấp danh sách tool và endpoint gọi. Harness kết nối tới nó, gán tên mà mô hình nhìn thấy, áp dụng kiểm tra quyền, rồi đưa các tool đã phát hiện cho mô hình.

---

## Giải pháp

![MCP Architecture](images/mcp-architecture.en.svg)

Chương này bắt đầu từ năm tool cơ bản và hooks của s04, rồi thêm ba phần:

- `MCPClient` lưu định nghĩa tool và handler gọi mà server trả về.
- `connect_mcp` kết nối tới một server và lấy danh sách tool của nó.
- `assemble_tool_pool` ghép các tool cơ bản với tool từ mọi server đã kết nối.

Server `docs` và `deploy` là bản giả lập in-process cho `tools/list`, `tools/call`, và một tool pool động. Chương này không triển khai MCP transport thật.

---

## Cách hoạt động

### 1. Vòng lặp Agent cơ bản giữ nguyên

Trước mỗi lần gọi mô hình, Harness lắp tool pool hiện tại:

```python
def agent_loop(messages: list):
    while True:
        tools, handlers = assemble_tool_pool()
        response = client.messages.create(
            model=MODEL,
            system=assemble_system_prompt(),
            messages=messages,
            tools=tools,
            max_tokens=8000,
        )
        ...
```

Sau khi một server mới kết nối, lần gọi `assemble_tool_pool()` tiếp theo thêm tool của nó vào input mô hình. Kết quả tool vẫn được append vào messages dưới dạng block `tool_result`.

### 2. MCPClient lưu kết quả phát hiện và handler gọi

```python
class MCPClient:
    def register(self, tool_defs, handlers):
        self.tools = list(tool_defs)
        self._handlers = dict(handlers)

    def call_tool(self, tool_name, args):
        handler = self._handlers.get(tool_name)
        if not handler:
            return f"MCP error: unknown tool '{tool_name}'"
        try:
            return str(handler(**args))
        except Exception as error:
            return f"MCP error: {type(error).__name__}: {error}"
```

`register()` đại diện cho danh sách tool đã phát hiện. `call_tool()` là ranh giới gọi. Lỗi được trả về mô hình thay vì kết thúc vòng lặp Agent.

### 3. connect_mcp chỉ kết nối và phát hiện

```python
def connect_mcp(name: str) -> str:
    if name in mcp_clients:
        return f"MCP server '{name}' already connected"
    factory = MOCK_SERVERS.get(name)
    if not factory:
        return f"Unknown server '{name}'"
    server = factory()
    mcp_clients[name] = server
    ...
```

Ban đầu, mô hình thấy năm tool cơ bản và `connect_mcp`. Sau `connect_mcp(name="docs")`, Harness lưu client docs. Lần gọi mô hình tiếp theo cũng thấy:

```text
mcp__docs__search
mcp__docs__get_version
```

### 4. Prefix tách tool từ các server khác nhau

Nhiều server có thể expose `search` hoặc `status`. Harness dùng:

```text
mcp__{server}__{tool}
```

`normalize_mcp_name()` thay các ký tự ngoài bảng chữ cái tên tool của mô hình bằng dấu gạch dưới. Việc lắp tool pool cũng kiểm tra va chạm tên đã chuẩn hóa và giới hạn 64 ký tự:

```python
prefixed = f"mcp__{safe_server}__{safe_tool}"
if prefixed in origins:
    raise ValueError("MCP tool name collision after normalization")
```

Do đó, `docs.one/get.version` và `docs_one/get_version` không thể silently map về cùng một tên.

### 5. Định nghĩa tool và handler vào pool cùng lúc

```python
tools.append({
    "name": prefixed,
    "description": tool_def.get("description", ""),
    "input_schema": schema,
})
handlers[prefixed] = (
    lambda *, client=server, tool=raw_name, **kwargs:
    client.call_tool(tool, kwargs)
)
```

Mô hình thấy tên đã prefix. Handler gọi `MCPClient` với tên tool gốc của server. Default argument capture client và tool hiện tại để mỗi lambda không trỏ tới phần tử cuối trong vòng lặp.

### 6. Host quyết định quyền

MCP server có thể cung cấp `readOnlyHint` hoặc `destructiveHint`, nhưng các hint đó đến từ server và không phải ủy quyền. Chương này dùng policy phía host:

```python
MCP_HOST_POLICY = {
    ("docs", "search"): "allow",
    ("docs", "get_version"): "allow",
    ("deploy", "status"): "allow",
    ("deploy", "trigger"): "confirm",
}
```

`permission_hook()` tra policy này bằng tên tool đã chuẩn hóa. Tool bên ngoài chưa cấu hình mặc định cần xác nhận. Description chứa `readOnly` không làm tool được tin tưởng.

### 7. Lỗi input dừng ở ranh giới tool

Mô hình có thể bỏ argument bắt buộc hoặc gửi field mà server không chấp nhận. Cả `execute_tool()` và `MCPClient.call_tool()` bắt các lỗi đó và trả về `tool_result` lỗi:

```text
MCP error: TypeError: <lambda>() missing 1 required argument: 'query'
```

Mô hình có thể sửa argument ở lượt tiếp theo mà không kết thúc script bài học.

---

## Thay đổi so với s04

| Thành phần | s04 | s14 |
|---|---|---|
| Tool cơ bản | Năm tool cố định | Không đổi |
| Nguồn tool | Định nghĩa trong `code.py` | Tool cơ bản cộng MCP tool đã phát hiện |
| Tool pool | `TOOLS` cố định | Lắp mỗi lượt bởi `assemble_tool_pool()` |
| Tên tool bên ngoài | Không có | `mcp__{server}__{tool}` |
| Quyền | Kiểm tra shell và path | Thêm MCP policy phía host |
| MCP transport | Không có | Bản giả lập server in-process minh họa ranh giới |

Chương này không mang theo Task, Background, Cron, Team, hay worktree. Chúng gặp MCP trong s15 Integrated Harness.

---

## Thử chạy

```sh
cd learn-claude-code
python s14_mcp_plugin/code.py
```

Nhập:

```text
Connect to the docs server, search for agent hooks, and tell me the current documentation API version.
```

Một tool trace điển hình:

```text
connect_mcp(name="docs")
mcp__docs__search(query="agent hooks")
mcp__docs__get_version()
```

Rồi nhập:

```text
Connect to the deploy server and check the web service status. Do not trigger a deployment.
```

`status` chạy theo host policy. `trigger` cần xác nhận của người dùng.

---

## Tiếp theo

MCP vẫn là một nhánh khóa học độc lập ở đây. s15 Integrated Harness kết hợp các tool cơ bản, hooks, skills, context, memory, tasks, background work, cron, teams, và MCP trong một runtime.

<!-- translation-sync: zh@v9, en@v9, ja@v9, vi@v9 -->
