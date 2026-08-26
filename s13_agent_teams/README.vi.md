# s13: Agent Teams — Runtime và protocol phối hợp

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → ... → [s10](../s10_task_system/) → `s13` → [s14](../s14_mcp_plugin/) → s15 → s16 → s17

> *"When one agent cannot hold the whole job, let teammates divide the work."* — Teammate bền vững, chọn task dùng chung, worktree tùy chọn, và protocol phối hợp.
>
> **Tầng Harness**: Team — cách nhiều agent chia việc, chia sẻ state, và nằm dưới quyền kiểm soát của Lead.

---

## Vấn đề

Giả sử ta nhờ một agent refactor cả backend. Công việc có thể phủ việc nạp configuration, authentication, và test. Một agent có thể xử lý các phần đó tuần tự, nhưng mất lâu hơn và chi tiết sớm dần rời khỏi context.

Đây là ứng viên tốt cho làm việc song song, nhưng người dùng thường mô tả mục tiêu chứ không thiết kế team:

```text
Refactor this sample backend. Clean up configuration loading,
authentication, and tests, preserve the existing interfaces,
and make sure the tests pass.
```

Harness phải trả lời một nhóm câu hỏi gắn với nhau:

1. Ai quyết định việc song song là hữu ích, và ai xác nhận các agent thêm?
2. Mỗi teammate giữ identity và context xuyên các assignment thế nào?
3. Kết quả trở về Lead ra sao mà không bắt mô hình poll một inbox?
4. Teammate đang idle có thể nhận việc sẵn sàng mà không chờ assignment khác không?
5. Task nên dùng thư mục nào khi các lần sửa song song có thể xung đột?
6. Shutdown và duyệt plan trở thành protocol có thể truy vết, có thể thực thi thế nào?

---

## Giải pháp

![Agent Teams Overview](images/agent-teams-overview.en.svg)

s13 tái sử dụng tool cơ sở, hook, kiểm tra permission, và Task System của s10, rồi thêm runtime team do Lead quản lý:

- **Lead** sở hữu hội thoại với người dùng, đề xuất cách chia việc, và chờ xác nhận.
- **Teammate** chạy agent loop độc lập và luân phiên giữa WORK và IDLE.
- **MessageBus** mang tin nhắn thường, kết quả, và sự kiện điều khiển qua mailbox lưu trên file.
- **Runtime delivery** tiêu thụ mailbox của Lead và inject sự kiện team vào lượt tiếp theo.
- **Bảng task dùng chung** cho phép teammate idle tìm việc sẵn sàng và claim dưới lock.
- **Worktree tùy chọn** gắn một task với thư mục làm việc khác khi công việc cần. Task không gắn dùng thư mục repository bình thường.
- **Protocol có type và plan gate** làm state shutdown và duyệt tường minh, đồng thời chặn tool mutating cho đến khi plan bắt buộc được duyệt.

Viết đồ thị task giữ hợp đồng hai phase của s10. Lead gọi `create_task` cho mọi node trước, rồi dùng các ID runtime trả về với `update_task(addBlockedBy=...)` trước khi giao việc sẵn sàng. Chỉ Lead nhận `update_task`; teammate có thể list, claim, và complete task nhưng không được viết lại cấu trúc đồ thị trong lúc team đang chạy.

Background task s11 và scheduled task s12 không được mang vào chương này. Không cơ chế nào cần cho giao tiếp teammate, claim task, hay duyệt plan.

Tất cả đều là phần của tầng Harness Team. Teammate không cần vòng lặp riêng để phát hiện task, và một worktree không tạo ra một loại agent mới.

---

## Cách hoạt động

### 1. Lead đề xuất team và chờ người dùng xác nhận

Khởi động teammate đổi chi phí, concurrency, và tập actor có thể sửa workspace. System prompt của Lead giữ ranh giới đó hiện rõ:

```python
"When parallel work would help, first propose a small team with clear "
"responsibilities and wait for the user's confirmation. Do not call "
"spawn_teammate before the user confirms."
```

Với request đầu, Lead chỉ đề xuất cách chia:

```text
I suggest three parallel areas:
- config: clean up configuration loading
- auth: refactor authentication
- tests: add regression coverage

I will start the teammates after you confirm.
```

Sau khi người dùng nói "Go ahead," Lead có thể gọi `spawn_teammate`. Lead tạo Task trước rồi truyền `task_id` ban đầu cho teammate. Người dùng nêu mục tiêu, Lead thiết kế team, và người dùng xác nhận ranh giới thực thi.

### 2. Mỗi teammate sở hữu một vòng lặp độc lập

Subagent s06 là một lần gọi one-shot. Teammate là đơn vị thực thi bền vững:

| | s06 Subagent | s13 Teammate |
|---|---|---|
| Lifecycle | Kết thúc sau một lần gọi | `WORK → IDLE → WORK` cho đến shutdown |
| Context | Tồn tại cho một task | Persist xuyên các assignment |
| Communication | Trả một kết quả | Nhận tin nhắn và phát sự kiện |
| Coordination | Ủy thác một chiều | Cộng tác hai chiều với Lead |

`TeammateRuntime` cho mỗi teammate system prompt, messages, tool, và Task hiện tại riêng, rồi chạy vòng WORK / IDLE trong daemon thread. Lead có thể tiếp tục phối hợp trong lúc teammate làm việc. Tên `lead` và `agent` được dành cho identity runtime, còn `MessageBus` vẫn nhận `lead` như mailbox của coordinator.

`spawn_teammate` claim Task ban đầu trước khi thread khởi động. Claim thất bại ngăn teammate khởi động. Không có Task, các tool workspace và Shell bảo teammate claim một cái thay vì fallback về thư mục repository.

### 3. MessageBus giữ giao tiếp ngoài context của mô hình

Lead và teammate không thể chia một mảng messages. Nếu không, tool result của một teammate sẽ rò vào reasoning của teammate khác. `MessageBus` cho mỗi agent một inbox `.mailboxes/<name>.jsonl`:

```python
class MessageBus:
    def send(self, from_agent, to_agent, content,
             msg_type="message", metadata=None):
        msg = {
            "from": from_agent,
            "to": to_agent,
            "content": content,
            "type": msg_type,
            "metadata": metadata or {},
        }
        with self._changed:
            MAILBOX_DIR.mkdir(parents=True, exist_ok=True)
            with self._path(to_agent).open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(msg, ensure_ascii=True) + "\n")
            self._changed.notify_all()

    def wait_for_messages(self, agent, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._changed:
            while not self.peek(agent):
                remaining = (None if deadline is None
                             else deadline - time.monotonic())
                if remaining is not None and remaining <= 0:
                    return []
                self._changed.wait(remaining)
            return self._read_unlocked(agent)
```

Một lock bảo vệ file mailbox khỏi truy cập đồng thời. Một `Condition` cho runtime đánh thức teammate khi có tin nhắn và cũng hỗ trợ timeout ngắn dùng lúc IDLE.

### 4. Runtime giao sự kiện inbox

`read_inbox()` tiêu thụ tin nhắn bằng cách đọc rồi xóa file mailbox, nên Lead giữ một consumer duy nhất, `consume_lead_inbox()`:

```python
def consume_lead_inbox():
    messages = BUS.read_inbox("lead")
    for message in messages:
        if message["type"].endswith("_response"):
            match_response(...)
    return messages
```

Vòng CLI chờ input terminal và mailbox của Lead cùng lúc. Khi tin nhắn đến, nó tiêu thụ mailbox trước khi bắt đầu lượt Lead khác:

```text
MessageBus → consume_lead_inbox
           → update protocol state
           → inject [Team events] into history
           → start another Lead turn
```

Sau khi spawn teammate, Lead kết thúc lượt hiện tại thay vì gọi lặp `list_teammates` hay `get_task`. Runtime bắt đầu lượt tiếp khi sự kiện team đến.

`check_inbox` không phải tool của mô hình. Việc tin nhắn đến thuộc về runtime; mô hình xử lý sự kiện sau khi runtime đã giao chúng vào context.

### 5. Result và IDLE là sự kiện tách riêng

Khi teammate xong một assignment, runtime gửi hai sự kiện theo thứ tự:

```text
result:            "Authentication refactored; related tests pass."
idle_notification: "Waiting for more work."
```

`result` trả lời "Assignment này tạo ra gì?" `idle_notification` trả lời "Teammate này có nhận thêm việc được không?" Một chữ "done" mơ hồ không thể đại diện cả hai sự kiện.

Teammate idle không thoát. Tin nhắn trực tiếp hoặc task sẵn sàng đưa nó về WORK; một `shutdown_request` bắt đầu handshake shutdown có kiểm soát.

### 6. IDLE kiểm tra mailbox trước khi tìm task sẵn sàng

IDLE ưu tiên tin nhắn, rồi mới kiểm tra bảng task dùng chung:

```python
while True:
    inbox = BUS.wait_for_messages(name, IDLE_SCAN_INTERVAL)
    if inbox:
        should_stop = handle_messages(inbox)
        if should_stop or messages[-1]["role"] == "user":
            break
        continue

    task = claim_next_task(name)
    if task:
        messages.append({
            "role": "user",
            "content": f"[Auto-claimed task {task.id}] {task.subject}",
        })
        break
```

Shutdown, duyệt plan, và chỉ thị trực tiếp từ Lead nên đến trước việc opportunistic. Nếu không có tin nhắn và không có task sẵn sàng, teammate vẫn IDLE. Task đang bị block có thể sẵn sàng sau khi teammate khác hoàn thành prerequisite.

### 7. Discovery và claim tách nhau, và claim là atomic

Quét chỉ tìm candidate:

```python
def scan_unclaimed_tasks() -> list[Task]:
    return [
        task for task in list_tasks()
        if task.status == "pending"
        and task.owner is None
        and can_start(task.id)
    ]
```

Danh sách là snapshot. Teammate khác, hoặc harness process khác dùng cùng thư mục task, có thể thấy cùng task. Thay đổi ownership vì thế xảy ra trong `claim_task()` dưới `task_store_lock()`, kết hợp lock trong process với file lock:

```python
def claim_task(task_id: str, owner: str) -> str:
    with task_store_lock():
        task = load_task(task_id)
        if task.status != "pending" or task.owner is not None:
            return "Task is no longer available"
        if _owner_in_progress(owner):
            return "Owner must complete its current task first"
        if not can_start(task_id):
            return "Task is blocked"
        cwd, error = task_worktree_cwd(task)
        if error:
            return f"Cannot claim {task_id}: {error}"
        task.owner = owner
        task.status = "in_progress"
        save_task(task)
        teammate_assignments[owner] = {"task_id": task.id, "cwd": cwd}
        return f"Claimed {task.id}"
```

Nhiều teammate có thể phát hiện cùng candidate, nhưng chỉ một claim đưa nó sang `in_progress`. File task được ghi qua file tạm và thay thế atomic trong lúc cùng store lock được giữ. Teammate cũng phải xong task hiện tại trước khi claim cái khác, và binding worktree hỏng fail closed thay vì fallback về thư mục repository.

### 8. Việc đã claim tái sử dụng cùng vòng WORK

Sau claim thành công, runtime inject task ID, subject, và description vào messages của teammate:

```text
ready task appears
  → IDLE teammate discovers it
  → claim_task writes owner and in_progress
  → task enters teammate messages
  → WORK
  → complete_task
  → result + idle_notification
  → IDLE
```

Teammate dùng cùng lần gọi mô hình, file tool, Shell, plan gate, báo kết quả, và protocol shutdown như một assignment trực tiếp từ Lead. Phát hiện task là một lối vào khác của vòng WORK sẵn có.

### 9. Task chọn thư mục làm việc của tool

`Task.worktree` là tùy chọn:

```python
@dataclass
class Task:
    id: str
    subject: str
    description: str
    status: str
    owner: str | None
    blockedBy: list[str]
    worktree: str | None = None
```

Lead có thể tạo và gắn worktree khi thư mục tách sẽ giúp:

```python
create_worktree(name="auth-refactor", task_id="task_1a2b3c4d")
```

`create_worktree` là tool chỉ dành cho Lead. Nó nhận task pending, chưa có owner, chưa gắn, validate tên, path, branch, và Git registry, tạo checkout, rồi ghi binding của task. Nếu Git báo thất bại sau khi đã để lại branch hoặc checkout đã đăng ký, runtime báo thao tác một phần, để task không gắn, và giữ các artifact đó để khôi phục thủ công. Teammate chỉ thấy tool task và file.

Claim task lưu thư mục đã resolve vào `teammate_assignments`; các wrapper `bash`, `read_file`, `write_file`, `edit_file`, và `glob` của teammate đó đọc thư mục từ assignment. Task không có worktree resolve về `WORKDIR`; teammate không có Task đã claim không dùng được các tool workspace đó:

```python
cwd, error = task_worktree_cwd(task)
if not error:
    teammate_assignments[owner] = {
        "task_id": task.id,
        "cwd": cwd,
    }
```

`complete_task(task_id, owner)` kiểm tra caller sở hữu task in_progress. Hoàn thành thành công ghi kết quả nhưng giữ thư mục assignment đã chọn cho đến khi lượt mô hình đó kết thúc. Nhờ đó các tool call sau trong cùng response vẫn ở worktree của task. Runtime nhả assignment khi teammate trở về IDLE; hoàn thành thất bại giữ nó để teammate sửa task và thử lại.

Sau restart, `assignment_cwd()` có thể rebuild assignment in-progress từ owner bền vững của task và binding worktree. Nó cũng thay lease local cũ khi cùng owner đã chuyển sang task khác. Binding thiếu hoặc không hợp lệ fail closed thay vì lặng lẽ đưa việc về thư mục repository.

> Một worktree tách thư mục làm việc Git và branch. Nó không phải sandbox: lệnh Shell vẫn truy cập được path và tài nguyên mà process cha được phép.

### 10. Gỡ worktree thuộc về host

Mô hình có thể tạo worktree gắn task, nhưng không thể gỡ. Cleanup vẫn là helper của host để người dùng hoặc host kiểm tra ownership của task, lease assignment, và Git status trước. Helper từ chối binding task pending hoặc in-progress và lease của lượt hiện tại. Không có lựa chọn destructive tường minh, file tracked, untracked, và ignored đều chặn việc gỡ.

`remove_worktree(name, discard_changes=True)` dành cho code host đã có xác nhận tường minh của người dùng. Cả hai path gỡ đều giữ branch `wt/<name>`, kể cả commit local sạch không có upstream. Gỡ thành công xóa binding của task vì checkout không còn tồn tại.

```text
clean worktree   → host may remove directory and retain wt/<name> branch
changed worktree → user decides how to preserve or discard it
pending/running task → refuse removal
```

Hoàn thành task cũng tách khỏi cleanup worktree. `complete_task` ghi kết quả task; sau khi teammate đến IDLE, người dùng hoặc host có thể kiểm tra, merge, giữ, hoặc gỡ worktree.

### 11. Tin nhắn điều khiển dùng type và request ID

Text tự do dùng được cho cộng tác thường, nhưng shutdown và duyệt không nên phụ thuộc đoán ý định. Chúng dùng tin nhắn có cấu trúc:

![Team Protocols](images/team-protocols-overview.en.svg)

```python
@dataclass
class ProtocolState:
    request_id: str
    type: str
    sender: str
    target: str
    status: str
    payload: str
    work_version: int | None = None
    task_id: str | None = None


pending_requests: dict[str, ProtocolState] = {}
```

Path shutdown là:

```text
Lead creates a pending shutdown request
  → shutdown_request(request_id) enters the teammate inbox
  → the teammate finishes its current step
  → shutdown_response(request_id) returns to Lead
  → request_id locates the original request
  → pending becomes approved and the teammate loop exits
```

ID khớp một reply với một request, type ngăn reply lệch type đổi state, và status ngăn response trùng được áp dụng hai lần.

### 12. Duyệt plan ràng buộc thực thi

Protocol plan chạy theo chiều ngược:

```text
Lead → plan_request
teammate → plan_approval_request(request_id, plan)
Lead → plan_approval_response(request_id, approve, feedback)
```

Khi Lead đã biết teammate phải lập plan trước, `spawn_teammate(..., task_id=task.id, require_plan=True)` claim Task và kích hoạt gate trước khi thread teammate khởi động. `request_plan` cũng có thể yêu cầu plan từ teammate đang chạy.

Tool dispatch thực thi gate:

```python
def _run_teammate_tool(name, block, handlers):
    gate = plan_gates.get(name, "not_required")
    if block.name in {"bash", "write_file", "edit_file"} and gate not in {
        "not_required", "approved"
    }:
        return f"Blocked: plan status is {gate}."
    try:
        return handlers[block.name](**block.input)
    except Exception as error:
        return f"Error: {type(error).__name__}: {error}"
```

Trong lúc state là `required`, `pending`, hoặc `rejected`, teammate có thể đọc file và gửi hoặc sửa plan, nhưng không chạy lệnh Shell, ghi file, hay sửa file. Plan đã gửi ghi task hiện tại và work version của teammate. Claim hoặc nhả Task đổi version đó và vô hiệu hóa lần duyệt cũ; tin nhắn thường không đổi identity của task cũng không đổi state duyệt.

Teammate không đọc input người dùng từ thread nền. Lệnh nguy hiểm hoặc path ngoài workspace trả lỗi permission để Lead xử lý quyết định với người dùng.

---

## Một lần chạy hoàn chỉnh

```text
s13 >> Put the backend refactor on a shared task board. Clean up
       configuration, authentication, and tests in parallel where possible.
       Use a worktree for authentication, preserve existing interfaces,
       and make sure the tests pass.

Lead: I suggest config, auth, and tests as three areas.
      Shall I start the team?

s13 >> Go ahead.

[task] config created
[task] auth created → worktree auth-refactor
[task] tests created
[claim] alice → config (cwd: repository)
[claim] bob → auth (cwd: .worktrees/auth-refactor)
[teammate] alice spawned
[teammate] bob spawned
[complete] auth
[bus] bob → lead (result) ...
[bus] bob → lead (idle_notification) ...
[wake: 2 team events → new turn]
Lead: I received the authentication result and will coordinate the rest.
```

Terminal lộ request của người dùng, đề xuất của Lead, state task, claim, thư mục đã chọn, kết quả, chuyển IDLE, và sự kiện điều khiển. Người dùng không phải đặt tên Lead hay bảo nó kiểm tra inbox.

---

## Thay đổi so với s10

| Thành phần | s10 | s13 |
|---|---|---|
| Agents | Một agent | Một Lead cộng teammate bền vững |
| Luồng người dùng | Thực thi request | Đề xuất team, rồi xác nhận khởi động |
| Communication | Không | Mailbox file cộng runtime delivery |
| Lifecycle | Một vòng lặp | Teammate `WORK / IDLE / shutdown` |
| Việc dùng chung | Một agent dùng tool task | Quét IDLE cộng claim atomic của teammate |
| Thư mục làm việc | `WORKDIR` của repository | Task đã claim, với worktree tùy chọn |
| Báo cáo | Output của agent hiện tại | `result` và `idle_notification` tách riêng |
| Control | Không | Protocol shutdown và duyệt plan có type |
| Enforcement | Không ràng buộc team | Plan bắt buộc chặn tool mutating |

---

## Thử chạy

```sh
cd learn-claude-code
python s13_agent_teams/code.py
```

Bắt đầu bằng một request thường:

```text
Put the backend refactor on a shared task board. Complete configuration,
authentication, and tests in parallel where dependencies allow. Use a
worktree for authentication, preserve existing interfaces, and summarize
the result.
```

Sau khi Lead đề xuất team, trả lời:

```text
Go ahead.
```

Quan sát `.tasks/` chuyển từ `pending` sang `in_progress` và `completed`, `.mailboxes/` giao `result` và `idle_notification`, và `.worktrees/` chỉ xuất hiện cho task đã gắn. Cũng kiểm tra tin nhắn trực tiếp thắng quét bảng task, và `complete_task` thất bại không reset thư mục làm việc của teammate.

---

## Tiếp theo

Lead và teammate chỉ gọi được tool định nghĩa trực tiếp trong `code.py`. Kết nối Jira, nền tảng deploy, hoặc knowledge base vẫn cần schema tool và handler riêng cho từng hệ thống ngoài. Thay đổi các tool ngoài đó cũng đòi hỏi thay đổi code khóa học.

s14 MCP Tools → Kết nối dịch vụ ngoài lúc runtime qua một protocol discovery và invocation, rồi thêm tool của chúng vào pool.

<!-- translation-sync: zh@v12, en@v12, ja@v12, vi@v12 -->
