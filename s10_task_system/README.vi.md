# s10: Task System — Từ checklist thực thi đến trạng thái task phối hợp

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → ... → s08 → s09 → `s10` → [s11](../s11_background_tasks/) → s12 → ... → s16 → s17

> *"Break big goals into small tasks, order them, persist"* — Đồ thị task persist trên file, nền tảng cho cộng tác multi-agent.
>
> **Tầng Harness**: Tasks — Mục tiêu được persist, tiến độ có thể khôi phục.

---

## Vấn đề

TodoWrite của s05 cho phép agent ghi lại các bước của task hiện tại. Mỗi mục checklist có content và status, giúp agent theo dõi phần còn lại.

Khi một project được tách thành ba task—tạo bảng database, viết API, và thêm test—Harness cũng cần biết chúng liên hệ thế nào: API phải chờ bảng database, và test phải chờ API ổn định. Nó cũng cần ghi ai chịu trách nhiệm cho từng task.

TodoWrite không ghi các dependency hay assignment này. Nó có thể cho thấy "write the API" chưa xong, nhưng Harness không dùng được thông tin đó để quyết định task đã sẵn sàng bắt đầu hay chưa.

Chương này thêm một Task System. Mỗi task có ID và status riêng; `blockedBy` ghi điều kiện tiên quyết, và `owner` ghi agent chịu trách nhiệm cho task.

---

## Giải pháp

![Task System Overview](images/task-system-overview.en.svg)

Code giữ năm tool cơ sở của S04, Permission, Hooks, và `execute_tool` dùng chung, rồi thêm 6 tool task, persistence trong thư mục `.tasks/`, và kiểm tra dependency `blockedBy`.

TodoWrite so với Task System:

| | TodoWrite (s05) | Task System (s10) |
|---|---|---|
| Vai trò | Checklist thực thi cho task hiện tại | Hệ thống task có thể khôi phục |
| Storage | Trong process / state của phiên | `.tasks/{id}.json` |
| Dependencies | Không | Đồ thị dependency `blockedBy` |
| Lifecycle | Phiên hiện tại / task hiện tại | Xuyên phiên |
| Coordination | Không claim task | `owner` / claim |
| Status | pending / in_progress / completed | pending / in_progress / completed |
| Độ chi tiết | Các bước của chính agent | Task có thể được claim, theo dõi, và unblock |
| Hợp đồng cập nhật | Thay cả checklist | Create/get/update/list từng bản ghi |

---

## Cách hoạt động

![Task DAG](images/task-dag.en.svg)

### Task: Cấu trúc dữ liệu

Mỗi task là một file JSON, lưu trong thư mục `.tasks/`:

```python
@dataclass
class Task:
    id: str
    subject: str
    description: str
    status: str          # pending | in_progress | completed
    owner: str | None    # Agent responsible for this task
    blockedBy: list[str] # List of dependency task IDs
```

ID dùng prefix `task_` theo sau là 8 ký tự hexadecimal ngẫu nhiên. File được tạo exclusive; ID đã tồn tại bị bỏ và sinh lại.

`TaskStore` validate ID task rồi đọc và ghi các file JSON. `TASKS = TaskStore(TASKS_DIR)` là store dùng trong chương này.

### create_task: Tạo Task

```python
def create_task(subject: str, description: str = "") -> Task:
    return TASKS.create(subject, description)
```

`TaskStore.create` kiểm tra subject, cấp một ID ngẫu nhiên, và ghi `.tasks/{id}.json`. Task mới luôn bắt đầu với danh sách `blockedBy` rỗng. Tool result trả ID sinh lúc runtime về cho mô hình.

### update_task: Thêm dependency bằng ID đã trả về

```python
def update_task(task_id: str, addBlockedBy: list[str]) -> Task:
    return TASKS.update_dependencies(task_id, addBlockedBy)
```

Xây đồ thị task dùng hai phase: tạo mọi node trước, rồi gọi `update_task` với các ID mà `create_task` trả về để thêm cạnh. Điều này quan trọng khi mô hình phát vài tool call trong một response: các call cùng cấp được hình thành trước khi có tool result nào, nên một lần gọi `create_task` không thể dùng ID vừa sinh của lần gọi khác.

`update_task` validate toàn bộ thay đổi trước khi lưu. Target và các dependency phải tồn tại, target vẫn phải pending và chưa có owner, và các cạnh mới không được tạo self-dependency hay cycle. Lặp lại một cạnh đã có thì an toàn và không nhân đôi.

### can_start: Kiểm tra dependency

Một task chỉ được bắt đầu sau khi mọi dependency `blockedBy` đều **completed**:

```python
def can_start(task_id: str) -> bool:
    return not incomplete_dependencies(load_task(task_id))
```

`incomplete_dependencies` nạp từng điều kiện tiên quyết. Task không thể được claim nếu bất kỳ prerequisite nào chưa completed hoặc file của nó không còn tồn tại.

### claim_task: Claim một Task

Khi agent bắt đầu làm một task, nó gọi `claim_task`: gán `owner`, đổi status từ `pending` → `in_progress`. Trường `owner` ghi ai đã claim task:

```python
def claim_task(task_id: str, owner: str = "agent") -> str:
    task = load_task(task_id)
    if task.status != "pending":
        return f"Task {task_id} is {task.status}, cannot claim"
    dependencies = incomplete_dependencies(task)
    if dependencies:
        return f"Blocked by: {dependencies}"
    task.owner = owner
    task.status = "in_progress"
    TASKS.save(task)
    return f"Claimed {task_id} ({task.subject})"
```

Claim bị từ chối nếu task không pending hoặc dependency chưa hoàn tất. S10 chỉ cập nhật state task tuần tự.

### complete_task: Hoàn thành và unblock

Khi task xong, đặt nó thành `completed`. Đồng thời quét mọi task khác để tìm các task downstream **vừa được unblock**:

```python
def complete_task(task_id: str, owner: str = "agent") -> str:
    task = load_task(task_id)
    if task.status != "in_progress":
        return f"Task {task_id} is {task.status}, cannot complete"
    if task.owner != owner:
        return f"Task {task_id} is owned by {task.owner}, not {owner}"
    ready_before = {t.id for t in list_tasks()
                    if t.status == "pending" and t.blockedBy
                    and can_start(t.id)}
    task.status = "completed"
    TASKS.save(task)
    unblocked = [t.subject for t in list_tasks()
                 if t.status == "pending" and t.blockedBy
                 and t.id not in ready_before
                 and can_start(t.id)]
    msg = f"Completed {task_id} ({task.subject})"
    if unblocked:
        msg += f"\nUnblocked: {', '.join(unblocked)}"
    return msg
```

Sau khi hoàn thành "schema", `can_start` trả True cho "endpoints" và "docs"; chúng có thể bắt đầu.

### get_task: Xem chi tiết đầy đủ

`list_tasks` chỉ hiện tóm tắt một dòng. `get_task` trả JSON đầy đủ của task, gồm description và chi tiết dependency. Khi khôi phục xuyên phiên, agent cần đọc description đầy đủ để tiếp tục công việc:

```python
def get_task(task_id: str) -> str:
    task = load_task(task_id)
    return json.dumps(asdict(task), indent=2)
```

### State Machine: Hai action, ba state

```
pending ──claim──→ in_progress ──complete──→ completed
```

Ở đây `claim` / `complete` là action, còn `pending` / `in_progress` / `completed` là state:

- **claim_task**: `pending` → `in_progress`. Gán owner, bắt đầu làm.
- **complete_task**: `in_progress` → `completed`. Đánh dấu task xong và unblock downstream.

### Ghép lại

```python
# Phase 1: create every node and receive its runtime ID
schema = create_task("setup database schema")
endpoints = create_task("create API endpoints")
tests = create_task("write tests")
docs = create_task("write docs")

# Phase 2: add edges using those returned IDs
update_task(endpoints.id, addBlockedBy=[schema.id])
update_task(tests.id, addBlockedBy=[endpoints.id])
update_task(docs.id, addBlockedBy=[schema.id])

# Agent claims the first available task
claim_task(schema.id)       # ✓ Claimed (no dependencies)
complete_task(schema.id)    # ✓ Completed → unblocks endpoints, docs

claim_task(endpoints.id)    # ✓ Claimed (schema completed)
complete_task(endpoints.id) # ✓ Completed → unblocks tests

claim_task(docs.id)         # ✓ Claimed (schema completed)
complete_task(docs.id)      # ✓ Completed

claim_task(tests.id)        # ✓ Claimed (endpoints completed)
complete_task(tests.id)     # ✓ Completed
```

Mỗi `create_task` ghi một file JSON; `update_task`, `claim_task`, và `complete_task` cập nhật nó. Xuyên phiên, thư mục `.tasks/` vẫn còn — agent đọc các file để khôi phục tiến độ.

---

## Thử chạy

```sh
cd learn-claude-code
python s10_task_system/code.py
```

Thử các prompt sau:

1. `Create tasks: setup database schema, create API endpoints (depends on schema), write tests (depends on endpoints), write docs (depends on schema)`
2. `List all tasks and their statuses`
3. `Claim the first unblocked task and complete it`
4. `List tasks again — which ones are now unblocked?`

Điều cần quan sát: Có file JSON được sinh trong thư mục `.tasks/` không? Sau khi hoàn thành một task, các task bị block có được unblock không?

---

## Tiếp theo

Đồ thị task đã có, nhưng bộ test đầy đủ, cài dependency, và lệnh deploy có thể mất rất lâu. Khi các lệnh này chạy đồng bộ, Agent Loop vẫn bị block trong tool call hiện tại và không thể tiếp tục cho đến khi lệnh xong.

s11 Background Tasks → Thao tác chậm chạy nền. Agent Loop có thể tiếp tục xử lý task khác và nhận thông báo khi công việc nền xong.


<!-- translation-sync: zh@v5, en@v5, ja@v5, vi@v5 -->
