from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parents[1]
files=[root/'onesa-company-portal-backend/openapi/openapi.json',root/'onesa-company-portal-frontend/src/lib/api/generated/schema.d.ts']
before={p:p.read_bytes() for p in files}
subprocess.run(['npm','run','api:export'],cwd=root/'onesa-company-portal-backend',check=True)
subprocess.run(['npm','run','api:generate'],cwd=root/'onesa-company-portal-frontend',check=True)
changed=[str(p.relative_to(root)) for p in files if p.read_bytes()!=before[p]]
if changed:
 print('API schema drift detected: '+', '.join(changed),file=sys.stderr);sys.exit(1)
print('OpenAPI and generated client match route schemas')
