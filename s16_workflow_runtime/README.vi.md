# s16: Workflow Runtime — Mô hình quyết định từng bước; script quyết định điều phối

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → ... → s14 → [s15](../s15_integrated_harness/) → `s16` → [s17](../s17_goal_loop/)

> *"One tool_use runs an entire orchestration"* — Tool `Workflow` khởi chạy một script runtime có thể phục hồi, điều phối nhiều lần gọi Agent.
>
> **Tầng Harness**: Điều phối — chạy script đa Agent đã lưu phía trên vòng lặp đơn Agent.

---

Từ s01 đến s15, mô hình quyết định tool nào được gọi trong mỗi vòng. Kết quả của chúng vào `messages[]`, và mô hình quyết định bước tiếp theo từ ngữ cảnh đã cập nhật. Cách này hợp khi đường đi phụ thuộc vào những gì bước trước phát hiện.

Một số task lặp một chuỗi cố định. Code review có thể kiểm tra nhiều chiều song song, xác minh từng phát hiện, gộp trùng, rồi sắp kết quả. Chuỗi và dependency đã biết trước khi chạy. Lúc này host cần ba thứ:

- **Song song**, thay vì chờ từng mục một;
- **Cấu trúc kết quả ổn định**, ngay cả khi câu trả lời từng Agent khác nhau;
- **Khả năng phục hồi**, để gián đoạn không chạy lại việc đã xong.

Nếu điều phối này chỉ tồn tại trong lịch sử hội thoại, thứ tự và checkpoint cũng chỉ tồn tại trong lịch sử đó. Workflow đã lưu đặt chuỗi cố định vào code và ghi các lời gọi đã hoàn thành vào journal.

## Đặt kế hoạch vào code, không phải chuỗi lượt chat

Thêm tool `Workflow` vào tool pool của Harness. Host đăng ký script đáng tin, dựng từ `agent()`, `parallel()`, `pipeline()`, và `phase()`. Mô hình chỉ cung cấp tên Workflow đã lưu, argument, và run ID tùy chọn để resume; nó không gửi code thực thi hay metadata.

Workflow vào vòng lặp chính như một `tool_use`. Khi script chạy, runtime phát sự kiện vòng đời và tiến độ, rồi ghi mọi bước vào journal trên đĩa. Khi script xong, lời gọi trả về launch envelope, kết quả, và trạng thái task. Kết quả trung gian của script sống trong biến thay vì chiếm chỗ trong lịch sử hội thoại. Khi restart với `resume_from_run_id`, các lời gọi `agent()` không đổi trúng journal cache và tái sử dụng kết quả trước.

![Workflow Runtime Overview](images/workflow-runtime-overview.svg)

```python
SAMPLE_META = {"name": "review-changes", "description": "Review code changes", "phases": ["Review", "Verify"]}

async def sample_workflow(ctx, args):
    ctx.phase("Review")
    results = await ctx.pipeline(DIMENSIONS, audit, verify)   # Each dimension independently runs audit → verify
    confirmed = [f for r in results if r for f in r["confirmed"]]
    ctx.log(f"Confirmed {len(confirmed)} real issues")
    return {"confirmed": confirmed}
```

## Tool Workflow: một lần gọi, một lần chạy hoàn chỉnh

`Workflow` được thêm vào tool pool sẵn có của host s15. Người dùng có thể yêu cầu một Workflow đã lưu, hoặc mô hình chọn nó khi task khớp một điều phối đã biết. Adapter phân giải tên qua registry `WORKFLOWS` do host sở hữu, rồi đưa metadata và hàm đáng tin cho runtime. Các tool s15 khác vẫn dùng được trong cùng vòng lặp.

Schema phía mô hình nhận `name`, `args`, và `resume_from_run_id`. Tên lạ và argument sai dạng thành tool result lỗi thay vì kết thúc vòng lặp host. Runtime rồi kiểm tra metadata đã đăng ký, kiểm tra quyền, đăng ký workflow task local, và phát `async_launched` trước khi chạy script. Sự kiện tiến độ theo sau, rồi `task_notification` cuối; lời gọi trả JSON-safe launch information, kết quả, và trạng thái task.

```python
WORKFLOW_TOOL = {
    "name": "Workflow",
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "args": {"type": "object"},
            "resume_from_run_id": {"type": "string"},
        },
        "required": ["name"],
        "additionalProperties": False,
    },
}

async def run_workflow(name, args=None, resume_from_run_id=None):
    meta, script_fn = WORKFLOWS[name]
    out = await WorkflowTool().call(
        meta, script_fn,
        args=args,
        resume_from_run_id=resume_from_run_id,
    )
    return {"launched": out["launched"], "result": out["result"],
            "task": serialize_task(out["task"])}
```

## Metadata Workflow: kiểm tra trước khi chạy

Mỗi Workflow đã lưu đăng ký metadata đáng tin với `name`, `description`, và `phases` tùy chọn. Runtime kiểm tra nó trước khi thực thi code Workflow. `name` và `description` nhận diện task trên UI, còn `phases` đặt tên nhóm trên hiển thị tiến độ. Các field này thuộc registry của host, không thuộc input mô hình.

Đăng ký không hợp lệ raise `WorkflowInputError` trước khi chạy. Đây cùng ý tưởng với kiểm tra cron expression ở s12: đừng đợi đến lúc thực thi mới phát hiện Workflow đã lưu bị sai.

Vì runtime dùng `meta.name` trong tên file artifact local, nó cũng yêu cầu slug an toàn 1-64 ký tự gồm chữ, số, `.`, `_`, hoặc `-`.

```python
def validate_meta(meta):
    if not isinstance(meta, dict):
        raise WorkflowInputError("meta must be an object literal")
    if not meta.get("name") or not meta.get("description"):
        raise WorkflowInputError("meta requires name and description")
    if not isinstance(meta["name"], str) or not WORKFLOW_NAME_RE.fullmatch(meta["name"]):
        raise WorkflowInputError("meta.name must be a safe 1-64 character slug")
    if "phases" in meta and (
        not isinstance(meta["phases"], list)
        or not all(isinstance(p, str) and p for p in meta["phases"])
    ):
        raise WorkflowInputError("meta.phases must contain non-empty strings")
    return meta
```

## Primitive điều phối

Script nhận một `ExecutionState` expose một tập nhỏ primitive điều phối. Nó không đọc file hay chạy lệnh shell trực tiếp. Chế độ interactive mặc định nối `agent()` tới cùng API client thật với host, và mỗi Workflow Agent chỉ đọc nội dung được đưa qua argument của Workflow. `demo` và unit test dùng `MockAgentRunner` để sự kiện và journal replay lặp lại được.

| Primitive | Mục đích |
|------|------|
| `agent(prompt, {schema, label, phase})` | Dispatch một subagent |
| `parallel(thunks)` | **Barrier**: chạy mọi task đồng thời và chờ đến khi tất cả kết quả trả về |
| `pipeline(items, *stages)` | Chạy từng mục qua các stage **không barrier**; mục xong đi tiếp ngay |
| `phase(title)` | Đánh dấu pha tiến độ hiện tại và cập nhật hiển thị tiến độ |
| `log(message)` | Phát một dòng log tiến độ |
| `workflow(name, args)` | Chạy sub-workflow lồng nhau, chỉ một cấp |

Dùng `pipeline` khi mỗi mục độc lập đi qua cùng các stage. Mục A có thể tới stage ba trong khi mục B vẫn ở stage một. Dùng `parallel` khi bước tiếp theo cần mọi kết quả từ nhóm trước.

```python
async def pipeline(self, items, *stages):
    async def run_item(item, idx):
        value = item
        for stage in stages:                       # Each item independently completes every stage
            value = await stage(value, item, idx)
        return value
    return await asyncio.gather(*[run_item(it, i) for i, it in enumerate(items)])
```

## Output có cấu trúc: đừng để subagent trả về bài văn

`agent({schema})` yêu cầu Workflow Agent chỉ trả một JSON object khớp schema. Runtime parse và kiểm tra kết quả, rồi retry một lần nếu không khớp. Code phía dưới nhận object thay vì tách field từ văn xuôi.

s05 cảnh báo rằng argument của tool không thể tin hoàn toàn. Đây cùng bài học theo chiều ngược: output của subagent cũng không thể tin hoàn toàn. Kiểm tra ở ranh giới điều phối, cho một lần retry, và giữ sự không chắc chắn ra khỏi phần còn lại của luồng.

```python
run = await asyncio.to_thread(self.runner.run, prompt, schema, label)
result = run.value
if schema is not None:
    ok, err = SimpleJsonSchema(schema).validate(result)
    if not ok:                                       # Retry once with a reminder, then fail
        retry = await asyncio.to_thread(
            self.runner.run, prompt + "\n\nReturn valid JSON.", schema, label
        )
        result = retry.value
        ok, err = SimpleJsonSchema(schema).validate(result)
        if not ok:
            raise WorkflowInputError(f"agent({{schema}}) returned invalid output: {err}")
```

## Trạng thái task và sự kiện tiến độ

`LocalWorkflowTask` giữ status và token usage, rồi phát event stream kiểu SDK: `task_started` → chuỗi sự kiện `task_progress` chứa đổi pha, subagent bắt đầu, và log batch → một `task_notification` cuối báo hoàn thành hoặc thất bại, kèm file output và số Agent cùng token.

Demo in các sự kiện theo thứ tự và trả trạng thái task sau notification cuối.

```python
class LocalWorkflowTask:
    def progress_event(self, ptype, **data):         # Phase/subagent/log
        self.progress.append({"type": ptype, **data})
        print(f"  progress   {ptype} ...")
```

## Lưu trữ: Snapshot + Journal để resume sau gián đoạn

Runtime lưu mỗi lần chạy dưới `s16_workflow_runtime/.runtime/`: snapshot `<runId>.json`, output `<runId>.output.json`, journal `<runId>.journal.jsonl`, và file phối hợp `<runId>.lock`. Mọi lần chạy mới dành một `runId` mới bằng tạo file độc quyền trước khi mở journal. Run lock được giữ suốt thực thi và persist cuối, nên process khác không resume cùng lần chạy cùng lúc. Snapshot ghi tên Workflow, argument, và trạng thái task; resume kiểm tra snapshot và journal đã lưu trước khi đổi artifact thành công.

Journal là lõi của resume có checkpoint. Nó ghi mọi kết quả `agent()` từng dòng một:

```python
class WorkflowJournal:
    def record(self, key, value):
        self._f.write(json.dumps({"key": key, "value": value}) + "\n")
        self._f.flush()
        self.cache[key] = value
```

## Resume: tiếp tục theo runId và tái sử dụng mọi thứ không đổi

Gọi lại Workflow với `resume_from_run_id` chạy lại script, nhưng mỗi `agent()` tính một semantic key xác định. Nếu key đó có trong journal, nó trả kết quả đã cache mà không thực thi lại. Mọi lời gọi không đổi trúng cache; chỉ lời gọi đã đổi và các bước phụ thuộc phía dưới thực sự chạy lại.

Chi tiết then chốt: key không được phụ thuộc thứ tự đồng thời. Agent trong `parallel` và `pipeline` kết thúc theo thứ tự không xác định. Nếu "lần hoàn thành thứ n" thành key, cache entry sẽ map nhầm lời gọi ở lần chạy sau. Vì thế key dùng hash ổn định của nội dung gọi, gồm type, label, prompt, và schema, chứ không phải counter dùng chung:

```python
def key(self, kind, label, prompt, schema):
    basis = f"{kind}|{label}|{prompt}|{json.dumps(schema, sort_keys=True)}"
    return f"{kind}-{_stable_hash(basis) % 10**10:010d}"

# Inside agent():
cached = self.journal.cached(key)
if cached is not MISS:
    self.task.progress_event("workflow_agent", label=label, status="cached")
    return cached
```

## Call key ổn định

Khi resume, runtime phải khớp mỗi lời gọi `agent()` hiện tại với bản ghi journal trước đó. Hash ổn định cho code và argument Workflow không đổi cùng một call key. Output mô hình thật có thể khác; khi nội dung lời gọi chưa đổi, resume dùng kết quả đã lưu trong journal.

## Xem nó chạy

Workflow mẫu `review-changes` dùng `pipeline` để gửi từng chiều review độc lập qua audit → verify. Chế độ interactive dùng API thật và đọc tài liệu cần review từ `args.changes`. `demo` dùng dữ liệu runner cố định để hiện pipeline, validation, journal, và hành vi resume.

```python
async def sample_workflow(ctx, args):
    ctx.phase("Review")
    changes = args.get("changes", "")

    async def audit(_v, dimension, _i):
        out = await ctx.agent(f"Inspect this change for {dimension} issues:\n{changes}",
                              schema=FINDINGS_SCHEMA, label=f"audit:{dimension}", phase="Review")
        return {"dimension": dimension, "findings": out["findings"]}

    async def verify(audited, dimension, _i):
        ctx.phase("Verify")
        verdicts = await ctx.parallel([                       # Verify every finding independently
            (lambda f=f: ctx.agent(f"Verify this finding against the change:\n{changes}\n\n{f}",
                                   schema=VERDICT_SCHEMA, label=f"verify:{dimension}:{f['title']}"))
            for f in audited["findings"]])
        return {"dimension": dimension,
                "confirmed": [f for f, v in zip(audited["findings"], verdicts) if v and v["isReal"]]}

    results = await ctx.pipeline(DIMENSIONS, audit, verify)
    ...
```

## Thay đổi so với s15

| | s15 Integrated Harness | s16 Workflow Runtime |
|--|-----------|---------------------|
| Vòng lặp | Một vòng lặp do mô hình điều khiển | Vòng lặp chính không đổi; một tool chạy điều phối theo script |
| Ai quyết định bước tiếp | Mô hình quyết định mỗi vòng | Script khai báo điều phối trước |
| Nhiều Agent | Subagent one-shot s06 | Lời gọi theo script, resume được, qua ranh giới agent-runner |
| Cơ chế mới | — | Primitive script, host registry và tool adapter, vòng đời task, sự kiện tiến độ, journal/resume, output có cấu trúc |

s16 không thay vòng lặp chính. Nó expose `Workflow` ở tầng tool và khởi chạy workflow runtime local phía sau: một script đã lưu điều phối N lời gọi qua ranh giới agent-runner. Subagent s06 được dispatch một lần theo quyết định của mô hình; s16 biến điều phối thành host code có thể resume.

## Thử chạy

```bash
python s16_workflow_runtime/code.py          # Both the main model and Workflow agents use the real API
python s16_workflow_runtime/code.py demo     # Deterministic review-changes fixture and event stream
python s16_workflow_runtime/code.py resume   # Resume by the last runId; every agent() hits the journal cache
```

Ở lệnh mặc định, nhờ mô hình đọc các thay đổi, đặt text đó vào `args.changes`, và chạy Workflow `review-changes` đã lưu. Cả mô hình chính lẫn Workflow Agent dùng API thật. Lệnh `demo` dùng dữ liệu runner cố định để quan sát vòng đời và resume nhiều lần. Demo resume báo `agents=0 tokens=0` khi mọi lời gọi trúng cache.

## Tiếp theo

[s17 Goal Loop](../s17_goal_loop/) dùng một vòng lặp nhỏ hơn, độc lập, để kiểm tra mục tiêu đã nêu đã đạt chưa và quyết định có cần thêm một lượt nữa không.

<!-- translation-sync: zh@v10, en@v10, ja@v10, vi@v10 -->
