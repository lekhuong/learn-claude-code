# s12: Cron Scheduler — Bắt đầu công việc theo lịch

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → ... → s10 → s11 → `s12` → [s13](../s13_agent_teams/) → ... → s17

---

## Vấn đề

S11 đổi cách một lệnh chạy sau khi đã bắt đầu: lệnh Bash dài có thể chạy nền. Nó không ghi khi nào công việc tương lai nên bắt đầu, và không có thành phần nào liên tục kiểm tra thời gian hiện tại.

Với request như "chạy test mỗi sáng lúc 9 giờ" hoặc "kiểm tra trạng thái CI mỗi 30 phút," người dùng vẫn phải gửi lại prompt đúng lúc mỗi lần. Harness cần lưu lịch, đưa prompt tương ứng vào hàng đợi pending khi đến hạn, và giao nó cho Agent Loop khi Agent đang idle.

---

## Giải pháp

![Cron Scheduler Overview](images/cron-scheduler-overview.en.svg)

Giả sử Agent đăng ký job này:

```text
cron:   0 9 * * *
prompt: run tests
```

Lúc 09:00 giờ địa phương, thread scheduler khớp job và đưa `[Scheduled] run tests` vào `cron_queue`. Queue processor chờ đến khi Agent idle, rồi bắt đầu một lượt Agent Loop. Mô hình sau đó có thể gọi Bash để chạy test.

Code S12 giữ năm tool cơ sở và Hooks từ S04, rồi thêm `schedule_cron`, `list_crons`, và `cancel_cron`. Nó không gồm lệnh nền S11 vì chương này giao một prompt để bắt đầu việc, không phải kết quả của lệnh đang chạy.

---

## Cách hoạt động

### CronJob lưu gì

```python
@dataclass
class CronJob:
    id: str
    cron: str
    prompt: str
    recurring: bool
    durable: bool
    pending_delivery: bool = False
    last_fired: str | None = None
```

`cron` điều khiển khi job đến hạn. `prompt` là task gửi tới Agent. `pending_delivery` đánh dấu job đã đến hạn mà mô hình chưa nhận, còn `last_fired` ngăn enqueue lần nữa trong cùng phút.

### Biểu thức cron năm trường

```text
minute hour day month weekday
   *     *    *    *      *    every minute
   0     9    *    *      *    every day at 09:00
  */5    *    *    *      *    every 5 minutes
   0     9    *    *     1-5   weekdays at 09:00
```

Chương này hỗ trợ `*`, `*/N`, `N`, `N-M`, và `N,M,...`. Trước khi lưu job, `schedule_job()` gọi `validate_cron()` và từ chối biểu thức sai số trường hoặc giá trị ngoài khoảng.

### Enqueue khi đến hạn

Thread scheduler đọc giờ địa phương mỗi giây. Khi biểu thức khớp và job chưa fire trong phút hiện tại, `_enqueue_due_job()` lưu `pending_delivery` và `last_fired` trước khi thêm job vào hàng đợi in-memory:

```python
def poll_due_jobs(moment: datetime):
    minute_marker = moment.strftime("%Y-%m-%d %H:%M")
    with cron_lock:
        for job in list(scheduled_jobs.values()):
            if job.pending_delivery or job.last_fired == minute_marker:
                continue
            if cron_matches(job.cron, moment):
                _enqueue_due_job(job, minute_marker)
```

Nếu persistence thất bại, `_enqueue_due_job()` khôi phục state trước đó và không để một lần giao chỉ-trong-bộ-nhớ lộ ra cho queue processor.

### Giao khi Agent đang idle

`queue_processor_loop()` không kiểm tra thời gian. Nó kiểm tra hàng đợi, và `agent_lock` ngăn một lượt theo lịch đổi phiên trong lúc lượt của người dùng đang chạy:

```python
def queue_processor_loop(stop_event=RUNTIME_STOP):
    while not stop_event.wait(0.2):
        if not has_cron_queue() or not agent_lock.acquire(blocking=False):
            continue
        try:
            if has_cron_queue():
                run_agent_turn_locked()
        finally:
            agent_lock.release()
```

Agent Loop lấy các job đến hạn từ hàng đợi và append từng cái như tin nhắn user mới:

```python
fired = consume_cron_queue()
for job in fired:
    messages.append({"role": "user", "content": f"[Scheduled] {job.prompt}"})
```

Nếu gọi mô hình thất bại, các tin nhắn đó bị gỡ khỏi phiên hiện tại và job trở lại hàng đợi. Khi mô hình đã nhận call, job one-shot bị xóa và job recurring xóa `pending_delivery` cho đến lần khớp tiếp theo.

### Ranh giới persistence

| Mode | Lưu ở | Sau khi restart process |
|---|---|---|
| `durable=True` | `.scheduled_tasks.json` | Được nạp lại |
| `durable=False` | Memory | Mất |

Code cập nhật `.scheduled_tasks.json` qua file tạm và `os.replace()`. Nếu file hỏng, lúc khởi động báo lỗi thay vì bỏ qua.

Delivery là at least once. Nếu process thoát sau khi mô hình đã nhận prompt nhưng trước khi acknowledgement ghi xuống đĩa, cùng job đó có thể được giao lại sau restart.

### Ranh giới runtime

- Scheduler dùng giờ địa phương của process Agent.
- Scheduler dừng khi process Agent thoát. `durable` chỉ giữ định nghĩa job.
- Restart nạp các job đã lưu nhưng không phát lại các mốc lịch bị miss khi process đang tắt.
- Các lượt theo lịch chạy trên thread của queue processor. Tool call cần duyệt tương tác sẽ bị từ chối thay vì tranh input với terminal chính.
- Thread scheduler và queue processor chỉ khởi động trong CLI. Import `code.py` không khởi thread nền nào.

Dùng crontab, systemd timer, hoặc scheduler bên ngoài khi job phải chạy trong lúc Agent đã đóng.

---

## Thử chạy

```sh
cd learn-claude-code
python s12_cron_scheduler/code.py
```

Nhập các prompt sau theo thứ tự:

1. `Schedule "run date" every 2 minutes and keep it after restart.`
2. `List all cron jobs.`
3. `Cancel the cron job you just created.`

Bạn có thể xem `.scheduled_tasks.json` và chờ tin nhắn `[Scheduled] run date` khi job đến hạn. Giữ process Agent chạy khi thử lịch mức phút.

---

## Tiếp theo

Scheduler có thể bắt đầu một lượt Agent Loop đúng giờ chỉ định, nhưng vẫn một Agent xử lý lượt đó. Khi task cần điều tra song song, thay đổi trên nhiều module, và một kết quả gộp, Harness cũng cần giao việc cho nhiều Agent và thu những gì mỗi cái tạo ra.

s13 Agent Teams → Lead giao task, teammate chạy độc lập, và kết quả trở về qua inbox.

<!-- translation-sync: zh@v9, en@v9, ja@v9, vi@v9 -->
