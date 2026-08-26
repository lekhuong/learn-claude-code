# s11: Background Tasks — Đưa thao tác chậm ra nền

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → ... → s09 → s10 → `s11` → [s12](../s12_cron_scheduler/) → s13 → ... → s16 → s17

> *"Slow operations go to the background, the Agent Loop continues"* — Thread nền chạy lệnh, và các lượt sau thu kết quả đã xong.
>
> **Tầng Harness**: Background — Thực thi async, không chặn vòng lặp chính.

---

## Vấn đề

Đọc file hoặc chạy `git status` thường trả về nhanh, nên thực thi đồng bộ ít gây trễ đáng kể. Cài dependency, chạy bộ test đầy đủ, hoặc build project có thể mất vài phút. Cho đến khi lệnh trả về, Harness không xử lý được tool call tiếp theo trong response hiện tại, cũng không bắt được lượt mô hình kế tiếp.

Nếu công việc sau không phụ thuộc lệnh đó, không cần block. Ví dụ, sau khi bắt đầu bộ test đầy đủ, Agent có thể xem tài liệu hoặc sắp xếp file khác trong lúc test chạy.

S11 giải quyết việc này bằng cách chạy lệnh Bash chậm ở nền, để Agent Loop tiếp tục và thu kết quả đã xong ở lượt sau.

---

## Giải pháp

![Background Tasks Overview](images/background-tasks-overview.en.svg)

Chương này đưa thao tác chậm sang thread nền. Tool call hiện tại trước hết trả một `tool_result` placeholder, để Agent Loop tiếp tục. Đầu một lượt sau, kết quả đã xong được thu và thêm vào hội thoại dưới dạng notification.

Sync so với Background:

| | Sync (s04) | Background (s11) |
|---|---|---|
| Thao tác chậm | Tool call hiện tại bị chặn | Thread nền thực thi |
| Agent Loop | Chờ lệnh trả về | Tiếp tục sau placeholder result |
| Kết quả | Trả về sau khi lệnh xong | Trả `bg_id` trước; thu kết quả ở lượt sau |
| Tiêu chí quyết định | — | Tham số bash `run_in_background` |

---

## Cách hoạt động

### should_run_background: Yêu cầu tường minh

Mô hình yêu cầu thực thi nền qua tham số `run_in_background` của tool bash. Chỉ các lần gọi bash có tham số được đặt tường minh thành `true` mới vào path này. Các lần gọi khác vẫn chạy đồng bộ.

```python
def should_run_background(tool_name: str, tool_input: dict) -> bool:
    return (
        tool_name == "bash"
        and tool_input.get("run_in_background") is True
    )
```

Harness không còn đoán từ keyword như `install`, `build`, hay `test`. Tool call chọn mode thực thi một cách tường minh.

### BackgroundManager: Thực thi nền và lifecycle

`BackgroundManager` sở hữu state của task và hàng đợi hoàn thành. `start()` đăng ký một task, khởi động daemon thread, và trả `bg_id` ngay:

```python
class BackgroundManager:
    def __init__(self):
        self.tasks = {}
        self.results = {}
        self._ready = []
        self._lock = threading.Lock()

    def start(self, block) -> str:
        # Register task, then run _run() in a daemon thread.
        ...

    def _run(self, task_id: str, command: str):
        output, exit_code = _run_bash_process(command)
        status = "completed" if exit_code == 0 else "failed"
        with self._lock:
            self.tasks[task_id]["status"] = status
            self.results[task_id] = _format_bash_result(output, exit_code)
            self._ready.append(task_id)
```

Exit code khác 0 hoặc exception của worker trở thành `failed`. Shell khởi động trong process group riêng. Khi lệnh xong, hết giờ, hoặc Agent thoát theo path bình thường hay `SIGTERM`, runtime dừng group gốc đó. Đây là dọn lifecycle, không phải sandbox: process tạo session khác có thể rời group.

### collect_background_results: Thu notification

Đầu một lượt sau, `collect()` lấy kết quả đã xong ra khỏi hàng đợi và định dạng chúng thành tin nhắn `<task_notification>`:

```python
def collect_background_results() -> list[str]:
    return BACKGROUND.collect()
```

Notification không tái sử dụng `tool_use_id` gốc. Tool call gốc đã được trả lời bằng một `tool_result` placeholder; khi kết quả hoàn thành được thu, nó được thêm như một sự kiện độc lập theo format `task_notification`. Một `tool_use` vẫn chỉ nhận đúng một `tool_result`.

### Tích hợp vào vòng lặp

Trước mỗi lần gọi LLM, Agent Loop thu kết quả nền đã xong. `execute_tool()` vẫn chạy `PreToolUse` trên thread chính trước khi chọn thực thi đồng bộ hay nền:

```python
while True:
    inject_background_results(messages)
    response = client.messages.create(...)

def execute_tool(block) -> str:
    blocked = trigger_hooks("PreToolUse", block)
    if blocked is not None:
        return str(blocked)
    if should_run_background(block.name, block.input):
        task_id = start_background_task(block)
        output = f"[Background task {task_id} started]"
    else:
        output = call_tool(block)
    trigger_hooks("PostToolUse", block, output)
    return output
```

Thao tác chậm trước hết trả một tool_result placeholder kèm `bg_id`. Task đã xong không tự đánh thức Agent; `inject_background_results()` thu nó lần sau Agent Loop chạy.

### Ghép lại

```
Turn 1:
  LLM → bash "npm install" (run_in_background=true)
  → start_background_task → bg_0001
  → tool_result: "[Background task bg_0001 started]..."
  → LLM: "OK, I'll check later. Let me also read the config."

Turn 2:
  LLM → read_file "package.json" (fast, sync)
  → tool_result: file content

Turn 3:
  → collect bg_0001 as <task_notification>
  → LLM sees: config file + install notification in one message
```

Trong lúc npm install chạy nền, Agent Loop tiếp tục với read_file.

---

## s11 thêm gì

| Thành phần | s04 Kernel | s11 |
|-----------|-------------|-------------|
| Mô hình thực thi | Tất cả đồng bộ | Thao tác chậm sang thread nền + inject notification |
| Schema bash | `command` | `command` + `run_in_background` |
| Hàm mới | — | `should_run_background`, `start_background_task`, `collect_background_results`, `inject_background_results` |
| Type mới | — | `BackgroundManager` |
| Format notification | — | `<task_notification>` (không tái sử dụng tool_use_id) |
| Hành vi vòng lặp | Tool thực thi đồng bộ | Thực thi nền tường minh, kết quả đã xong được thu ở lượt sau |
| Tools | 5 | 5 (thêm một tham số vào schema bash) |

---

## Thử chạy

```sh
cd learn-claude-code
python s11_background_tasks/code.py
```

Thử các prompt sau:

1. `Run pip list in the background and find all Python files in this directory`
2. `Run npm install (use run_in_background) and while waiting, read package.json`
3. `Run a short sleep in the background, then list all Markdown files`

Điều cần quan sát: Sau khi đặt tường minh `run_in_background`, lệnh có được gửi ra nền không? Có `bg_id` được trả về không? Kết quả đã xong có được thu theo format `<task_notification>` ở lượt sau không?

---

## Tiếp theo

Background task đã giải "thao tác chậm không block." Nhưng nếu muốn làm gì đó theo lịch? Như "chạy test mỗi sáng lúc 9 giờ" hoặc "kiểm tra trạng thái server mỗi 5 phút."

s12 Cron Scheduler → Cho agent một đồng hồ báo thức.


<!-- translation-sync: zh@v7, en@v7, ja@v7, vi@v7 -->
