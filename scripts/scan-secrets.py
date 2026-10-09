from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
blocked=[]
patterns=[re.compile(rb'AKIA[0-9A-Z]{16}'),re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),re.compile(rb'sk-[A-Za-z0-9_-]{40,}')]
for path in root.rglob('*'):
    if not path.is_file() or any(part in {'node_modules','.git','.next','dist','storage','backups','test-results'} for part in path.relative_to(root).parts) or path.name.startswith('.env') or path.suffix in {'.pdf','.png','.jpg'}:continue
    content=path.read_bytes()
    if any(p.search(content) for p in patterns):blocked.append(str(path.relative_to(root)))
assert not blocked,'Potential secrets found in: '+', '.join(blocked)
print('Source secret pattern scan passed (not a replacement for provider-side secret scanning)')
