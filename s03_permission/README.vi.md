# s03: Permission — Kiểm tra quyền trước khi thực thi

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → s02 → `s03` → [s04](../s04_hooks/) → s05 → ... → s16 → s17
> *"Check permissions before executing"* — Pipeline permission quyết định thao tác nào cần duyệt.
>
> **Tầng Harness**: Permission — một cổng trước khi thực thi tool.

---

## Vấn đề

Agent của s02 có 5 tool. File tools được `safe_path` bảo vệ, nhưng bash thì không hạn chế. Bảo nó "dọn dự án", nó có thể chạy `rm -rf /`.

An toàn không thể dựa vào việc tin mô hình — cần code: kiểm tra trước mọi lần thực thi tool.

---

## Giải pháp

![Permission Overview](images/permission-overview.en.svg)

Vòng lặp s02 được giữ nguyên. Thay đổi duy nhất là chèn `check_permission()` trước khi thực thi tool — mỗi lần gọi tool đi qua ba cổng theo thứ tự cố định: deny cứng trước, rồi ask mềm, không khớp cái nào thì allow.

Ba cổng tương ứng ba quyết định:

| Cổng | Mục đích | Khi khớp |
|------|---------|----------|
| 1. Deny List | Thao tác cấm vĩnh viễn (`rm -rf /`, `sudo`) | Từ chối ngay, không thực thi |
| 2. Rule Matching | Thao tác phụ thuộc ngữ cảnh (đọc/ghi ngoài workspace, `rm` file) | Chuyển sang Cổng 3 |
| 3. User Approval | Sau khi Cổng 2 khớp, tạm dừng để user xác nhận | User quyết định allow hoặc deny |

Cả ba cổng đều không khớp → thực thi luôn. Phần lớn thao tác thường ngày đi đường này.

---

## Cách hoạt động

![Permission Pipeline](images/permission-pipeline.en.svg)

**Cổng 1**: Deny list cứng. Kiểm tra trước; khớp thì trả về thông báo chặn. List này dùng so khớp chuỗi đơn giản để chỉ vị trí cổng permission; không phải biên giới bảo mật đầy đủ.

```python
DENY_LIST = [
    "rm -rf /", "sudo", "shutdown", "reboot",
    "mkfs", "dd if=", "> /dev/sda",
]

def check_deny_list(command: str) -> str | None:
    for pattern in DENY_LIST:
        if pattern in command:
            return f"Blocked: '{pattern}' is on the deny list"
    return None
```

**Cổng 2**: Rule matching — mô tả "khi nào hỏi user." Mỗi rule chỉ định một tool và điều kiện kiểm tra.

```python
PERMISSION_RULES = [
    {
        "tools": ["read_file", "write_file", "edit_file"],
        "check": lambda args: not (WORKDIR / args.get("path", "")).resolve().is_relative_to(WORKDIR),
        "message": "Access outside workspace",
    },
    {
        "tools": ["bash"],
        "check": lambda args: any(kw in args.get("command", "") for kw in ["rm ", "> /etc/", "chmod 777"]),
        "message": "Potentially destructive command",
    },
]

def check_rules(tool_name: str, args: dict) -> str | None:
    for rule in PERMISSION_RULES:
        if tool_name in rule["tools"] and rule["check"](args):
            return rule["message"]
    return None
```

**Cổng 3**: Sau khi rule khớp, tạm dừng chờ input của user.

```python
def ask_user(tool_name: str, args: dict, reason: str) -> str:
    print(f"\n⚠  {reason}")
    print(f"   Tool: {tool_name}({args})")
    choice = input("   Allow? [y/N] ").strip().lower()
    return "allow" if choice in ("y", "yes") else "deny"
```

**Cả ba cổng nối thành chuỗi**, chèn trước khi thực thi tool:

```python
def check_permission(block) -> bool:
    # Gate 1: Hard deny
    if block.name == "bash":
        reason = check_deny_list(block.input.get("command", ""))
        if reason:
            print(f"\n⛔ {reason}")
            return False

    # Gate 2 + 3: Rule matching → User approval
    reason = check_rules(block.name, block.input)
    if reason:
        decision = ask_user(block.name, block.input, reason)
        if decision == "deny":
            return False

    return True

# In agent_loop — s02's loop with just one line added:
for block in tool_calls:
    if not check_permission(block):           # ← NEW
        results.append({... "content": "Permission denied."})
        continue
    output = TOOL_HANDLERS[block.name](**block.input)  # s02 original
    results.append(...)
```

---

## Thay đổi so với s02

| Thành phần | Trước (s02) | Sau (s03) |
|-----------|-------------|-------------|
| Security model | Không (tin mô hình) | Pipeline permission ba cổng |
| Hàm mới | — | check_deny_list, check_rules, ask_user, check_permission |
| Vòng lặp | Thực thi mọi tool trực tiếp | Chèn check_permission() trước khi thực thi |

---

## Thử chạy

```sh
cd learn-claude-code
python s03_permission/code.py
```

Thử các prompt sau:

1. `Create a file called test.txt in the current directory` (nên đi thẳng)
2. `Delete the file test.txt` (bash + rm kích hoạt Cổng 2)
3. `What files are in the current directory?` (chỉ đọc, tất cả đi qua)
4. `Try to write a file to /etc/something` (ghi ngoài workspace kích hoạt Cổng 2)

Điều cần quan sát: Thao tác nào đi thẳng? Thao tác nào cần bạn xác nhận? Thao tác nào bị từ chối ngay?

---

## Tiếp theo

Kiểm tra permission đã có — nhưng mỗi lần kiểm tra đều hardcode thành `check_permission()` trong vòng lặp. Muốn thêm logging trước và sau mỗi lần thực thi tool thì sao? Muốn tự git commit sau một số thao tác thì sao? Rải logic mở rộng khắp vòng lặp chỉ làm nó phình ra.

→ s04 Hooks: Gắn Hook vào vòng lặp. Logic mở rộng treo trên Hook; vòng lặp vẫn gọn.


<!-- translation-sync: zh@v1, en@v1, ja@v1, vi@v1 -->
