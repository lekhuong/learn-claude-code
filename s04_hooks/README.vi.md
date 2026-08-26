# s04: Hooks — Treo vào vòng lặp, đừng viết vào trong

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → s02 → s03 → `s04` → [s05](../s05_todo_write/) → s06 → ... → s16 → s17

> *"Hang on the loop, don't write into it"* — Hook tiêm logic mở rộng trước và sau khi thực thi tool.
>
> **Tầng Harness**: Hooks — Điểm mở rộng không xâm nhập vòng lặp.

---

## Vấn đề

Agent s03 đã có kiểm tra permission. Nhưng mỗi lần kiểm tra mới, "log mọi lần gọi bash", "tự git add sau khi ghi", đều phải sửa hàm `agent_loop`.

Vòng lặp nhanh chóng thành thế này:

```python
def agent_loop(messages):
    while True:
        # ... LLM call ...
        for block in response.content:
            if block.type != "tool_use":
                continue
            log_to_file(block)          # added a line
            check_permission(block)     # added a line
            notify_slack(block)         # added another line
            output = execute(block)
            auto_git_add(block)         # yet another line
            # ... the loop is unrecognizable
```

Bạn muốn mở rộng hành vi của Agent, nhưng thứ đang sửa lại là chính vòng lặp. Vòng lặp nên là lõi ổn định; phần mở rộng nên treo ở bên ngoài.

---

## Giải pháp

![Hooks Overview](images/hooks-overview.en.svg)

Vòng lặp và logic permission của s03 được giữ nguyên. Thay đổi duy nhất là chuyển `check_permission()` từ thân vòng lặp ra một Hook. Vòng lặp không còn gọi trực tiếp hàm kiểm tra nào. Thay vào đó nó gọi `trigger_hooks("PreToolUse", block)`, registry quyết định chạy gì.

Bốn event, phủ một chu kỳ Agent đầy đủ:

| Event | Thời điểm kích hoạt | Dùng điển hình |
|-------|---------------|-------------|
| UserPromptSubmit | Sau input của user, trước khi vào LLM | Validate input, tiêm context |
| PreToolUse | Trước khi thực thi tool | Kiểm tra permission, logging |
| PostToolUse | Sau khi thực thi tool | Side effect (tự git add, v.v.), kiểm tra output |
| Stop | Khi vòng lặp sắp thoát | Dọn dẹp, quyết định vòng lặp có tiếp không |

Phần mở rộng được thêm qua `register_hook()`. Vòng lặp chỉ gọi `trigger_hooks()`.

---

## Cách hoạt động

**Hook registry**: một dict ánh xạ tên event tới list callback.

```python
HOOKS = {
    "UserPromptSubmit": [],
    "PreToolUse": [],
    "PostToolUse": [],
    "Stop": [],
}

def register_hook(event: str, callback):
    HOOKS[event].append(callback)

def trigger_hooks(event: str, *args):
    for callback in HOOKS[event]:
        result = callback(*args)
        if result is not None:   # return value ≠ None → hook says "stop"
            return result
    return None
```

Khi `PreToolUse` trả về khác None, lần thực thi tool hiện tại bị chặn. Khi `Stop` trả về khác None, vòng lặp tiếp tục. Giá trị trả về của `UserPromptSubmit` và `PostToolUse` không ảnh hưởng control flow.

**UserPromptSubmit** kích hoạt sau input của user và trước khi vào LLM. Hook sau ghi lại working directory hiện tại:

```python
def context_inject_hook(query: str) -> str | None:
    """Inject current working directory info into every prompt."""
    print(f"\033[90m[HOOK] UserPromptSubmit: working in {WORKDIR}\033[0m")
    return None   # return None = no modification, let prompt through

register_hook("UserPromptSubmit", context_inject_hook)
```

Trong vòng lặp chính, kích hoạt ngay sau input của user:

```python
query = input("s04 >> ")
trigger_hooks("UserPromptSubmit", query)   # ← before entering LLM
history.append({"role": "user", "content": query})
agent_loop(history)
```

**PreToolUse / PostToolUse**, Hook trước và sau khi thực thi tool. Logic kiểm tra permission của s03 giờ được bọc thành Hook PreToolUse, cộng thêm Hook logging và nhắc output lớn:

```python
# PreToolUse: permission check (s03 logic, moved from loop to hook)
def permission_hook(block):
    if block.name == "bash":
        for pattern in DENY_LIST:
            if pattern in block.input.get("command", ""):
                return "Permission denied by deny list"
    if block.name in ("read_file", "write_file", "edit_file"):
        path = block.input.get("path", "")
        if not (WORKDIR / path).resolve().is_relative_to(WORKDIR):
            choice = input("   Allow? [y/N] ").strip().lower()
            if choice not in ("y", "yes"):
                return "Permission denied by user"
    return None

# PreToolUse: logging
def log_hook(block):
    print(f"[HOOK] {block.name}(...)")

# PostToolUse: large output reminder
def large_output_hook(block, output):
    if len(str(output)) > 100000:
        print(f"[HOOK] ⚠ Large output from {block.name}")

register_hook("PreToolUse", permission_hook)
register_hook("PreToolUse", log_hook)
register_hook("PostToolUse", large_output_hook)
```

**Stop** kích hoạt khi vòng lặp sắp thoát. Hook sau in một tóm tắt dọn dẹp:

```python
def summary_hook(messages: list) -> str | None:
    """Print a summary when the loop is about to stop."""
    tool_count = sum(1 for m in messages
                     for b in (m.get("content") if isinstance(m.get("content"), list) else [])
                     if isinstance(b, dict) and b.get("type") == "tool_result")
    print(f"\033[90m[HOOK] Stop: session used {tool_count} tool calls\033[0m")
    return None   # return None = allow stop, return string = force continuation

register_hook("Stop", summary_hook)
```

Trong agent_loop, kích hoạt trước khi thoát:

```python
tool_calls = [
    block for block in response.content if block.type == "tool_use"
]
if not tool_calls:
    force = trigger_hooks("Stop", messages)   # ← before exiting
    if force:
        # hook returned a message → inject it and continue
        messages.append({"role": "user", "content": force})
        continue
    return
```

**Chỉ một thay đổi trong vòng lặp**: s03 gọi trực tiếp `check_permission(block)`, s04 thay bằng `trigger_hooks("PreToolUse", block)`:

```python
for block in tool_calls:
    # s03: if not check_permission(block): ...
    # s04: hooks replace hardcoding
    blocked = trigger_hooks("PreToolUse", block)
    if blocked:
        results.append({"type": "tool_result", "tool_use_id": block.id,
                        "content": str(blocked)})
        continue

    handler = TOOL_HANDLERS.get(block.name)
    output = handler(**block.input) if handler else f"Unknown: {block.name}"

    trigger_hooks("PostToolUse", block, output)

    results.append({"type": "tool_result", "tool_use_id": block.id,
                    "content": output})
```

Bốn Hook phủ các nút then chốt của chu kỳ Agent: input → trước thực thi → sau thực thi → thoát. Vòng lặp chỉ gọi trigger_hooks(); toàn bộ logic nằm trong callback của Hook.

---

## Thay đổi so với s03

| Thành phần | Trước (s03) | Sau (s04) |
|-----------|-------------|-------------|
| Cách mở rộng | check_permission() hardcode trong vòng lặp | Registry HOOKS + trigger_hooks() |
| Hàm mới | — | register_hook, trigger_hooks |
| Callback Hook | — | context_inject_hook, permission_hook, log_hook, large_output_hook, summary_hook |
| Vòng lặp | Gọi trực tiếp check_permission() | Gọi trigger_hooks("PreToolUse", ...) |
| Kiểm soát thoát | Không | trigger_hooks("Stop", ...) có thể ngăn thoát |
| Chặn input | Không | trigger_hooks("UserPromptSubmit", ...) có thể tiêm context |

---

## Thử chạy

```sh
cd learn-claude-code
python s04_hooks/code.py
```

Thử các prompt sau:

1. `Read the file README.md` (nên đi thẳng, quan sát log Hook)
2. `Create a file called test.txt` (sau khi tạo, xem PostToolUse có chạy không)
3. `Delete all temporary files in /tmp` (bash + rm kích hoạt permission hook)

Điều cần quan sát: Trước mỗi lần thực thi tool, log `[HOOK]` có hiện không? Khi permission bị từ chối, có phải Hook chặn, hay hardcode trong vòng lặp?

---

## Tiếp theo

Agent giờ thực thi thao tác an toàn được. Nhưng nó có bao giờ dừng lại nghĩ "nên làm gì trước, gì sau?" Đưa một task phức tạp, nó nhảy vào làm luôn, hay lên kế hoạch trước?

→ s05 TodoWrite: Cho Agent một tool lập kế hoạch. Liệt kê trước, rồi mới thực thi.


<!-- translation-sync: zh@v1, en@v1, ja@v1, vi@v1 -->
