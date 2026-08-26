# s05: TodoWrite — Agent không có kế hoạch sẽ lệch hướng

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → s02 → s03 → s04 → `s05` → [s06](../s06_subagent/) → s07 → ... → s16 → s17

> *"An agent without a plan goes wherever the wind blows"* — Liệt kê bước trước, rồi mới thực thi. Task phức tạp ít bỏ sót bước hơn.
>
> **Tầng Harness**: Planning — Để Agent nghĩ trước khi làm.

---

## Vấn đề

Giao Agent một task phức tạp: "Rename all Python files to snake_case, run tests, and fix failures."

Agent bắt tay làm, đổi tên 3 file, chạy test, thấy 2 failure, bắt đầu sửa. Đang sửa thì quên mục tiêu ban đầu là "rename to snake_case", các test failure đã chiếm hết sự chú ý.

Hội thoại càng dài càng tệ: kết quả tool cứ nhồi vào context, pha loãng ảnh hưởng của system prompt. Một lần refactor 10 bước: sau bước 1-3, Agent bắt đầu ứng biến vì bước 4-10 đã bị đẩy ra khỏi attention.

---

## Giải pháp

![Todo Overview](images/todo-overview.en.svg)

S05 giữ tool dispatch, permission và Hook từ S04, rồi thêm `todo_write` và một bộ đếm nhắc. `todo_write` chỉ cập nhật trạng thái lập kế hoạch; các tool sẵn có vẫn làm việc thật.

Tool mới đi cùng đường dispatch `TOOL_HANDLERS[block.name]`. Sau ba vòng tool-use liên tiếp không có `todo_write`, harness gắn một reminder vào kết quả tool của vòng đó.

---

## Cách hoạt động

**TodoManager** sở hữu list trong bộ nhớ, validate bản cập nhật, và render trạng thái trả về cho mô hình. `run_todo_write` cũng in trạng thái đó ra terminal:

```python
class TodoManager:
    def __init__(self):
        self.items = []

    def update(self, todos: list | str) -> str:
        # Parse and validate before replacing the current list.
        validated = []
        ...
        self.items = validated
        return self.render()

    def render(self) -> str:
        # [ ] pending, [>] in progress, [x] completed
        ...


TODO = TodoManager()

def run_todo_write(todos: list | str) -> str:
    output = TODO.update(todos)
    print(output)
    return output
```

Một lần cập nhật tối đa 20 mục, mỗi mục cần `content` không rỗng, và chỉ một mục được `in_progress`. Đường nhập chuỗi nhận JSON hoặc biểu diễn list Python, không dùng `eval`.

Định nghĩa tool được thêm vào 5 tool kia trong map dispatch:

```python
TOOLS = [
    {"name": "bash",       ...},
    {"name": "read_file",  ...},
    {"name": "write_file", ...},
    {"name": "edit_file",  ...},
    {"name": "glob",       ...},
    # s05: new entry
    {"name": "todo_write", "description": "Create and manage a task list ...",
     "input_schema": {
         "type": "object",
         "properties": {
             "todos": {
                 "type": "array",
                 "items": {
                     "type": "object",
                     "properties": {
                         "content": {"type": "string"},
                         "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]},
                     },
                 },
             },
         },
     },
    },
]

TOOL_HANDLERS["todo_write"] = run_todo_write
```

**Reminder**: sau ba vòng tool-use không có `todo_write`, reminder được append vào kết quả vòng thứ ba và bộ đếm reset:

```python
rounds_since_todo = 0 if used_todo else rounds_since_todo + 1
if rounds_since_todo >= 3:
    results.append({
        "type": "text",
        "text": "<reminder>Update your todos.</reminder>",
    })
    rounds_since_todo = 0
```

Luồng điển hình khi Agent nhận task: gọi `todo_write` trước để liệt kê mọi bước (tất cả `pending`) → chọn một bước, đặt thành `in_progress` → xong thì đặt `completed` → nhìn `pending` tiếp theo → tiếp tục.

**Điểm then chốt**: todo_write không cho Agent thêm **năng lực thực thi**. Thứ nó thêm là **năng lực lập kế hoạch**.

---

## Thay đổi so với s04

| Thành phần | Trước (s04) | Sau (s05) |
|-----------|-------------|-------------|
| Số tool | 5 (bash, read, write, edit, glob) | 6 (+todo_write) |
| Planning | Không | List TODO có state + reminder |
| SYSTEM prompt | Prompt generic | Thêm hướng dẫn "plan before executing" |
| Vòng lặp | Tool dispatch và Hook | Cùng đường dispatch, thêm rounds_since_todo và tiêm reminder |

---

## Thử chạy

```sh
cd learn-claude-code
python s05_todo_write/code.py
```

Thử các prompt sau:

1. `Refactor s05_todo_write/example/hello.py: add type hints, docstrings, and a main guard` (nên liệt kê 3 bước trước, rồi mới thực thi)
2. `Create a Python package under s05_todo_write/example/demo_pkg with __init__.py, utils.py, and tests/test_utils.py`
3. `Review Python files under s05_todo_write/example and fix any style issues`

Điều cần quan sát: Lần gọi tool đầu tiên có phải `todo_write`? Liệt kê bao nhiêu bước TODO? Status có đi từ `pending` sang `in_progress` / `completed` trong lúc thực thi không?

---

## Tiếp theo

Agent lập kế hoạch được rồi. Nhưng nếu task quá lớn, kiểu "refactor the entire auth module", một list TODO thôi chưa đủ. Task đó bản thân là tập hợp hàng chục subtask, sẽ chìm trong context của một hội thoại.

→ s06 Subagent: Tách task lớn thành subtask, mỗi cái do một Agent độc lập xử lý với context sạch riêng, không nhiễm chéo.


<!-- translation-sync: zh@v1, en@v1, ja@v1, vi@v1 -->
