from pathlib import Path

p = Path("A:/bla/backend/app/routers/driver_tasks.py")
t = p.read_text(encoding="utf-8")
old = '"""Map the JWT caller to their driver row (None for staff/dev-bypass)."""'
assert t.count(old) == 1, t.count(old)
p.write_text(t.replace(old, '"""Map the JWT caller to their driver row (None for staff)."""'), encoding="utf-8")
print("driver_tasks docstring fixed")

