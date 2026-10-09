from pathlib import Path
import json,subprocess,tempfile
root=Path(__file__).resolve().parents[1]
frontend=root/'onesa-company-portal-frontend'
with tempfile.TemporaryDirectory(prefix='.contract-check-',dir=frontend) as directory:
    target=Path(directory)
    spec=json.loads((root/'onesa-company-portal-backend/openapi/openapi.json').read_text())
    body=spec['paths']['/api/v1/public/enquiries']['post']['requestBody']['content']['application/json']['schema']
    body['properties']['contractProbeField']={'type':'string'}
    body['required'].append('contractProbeField')
    (target/'spec.json').write_text(json.dumps(spec))
    subprocess.run(['node','node_modules/openapi-typescript/bin/cli.js',str(target/'spec.json'),'-o',str(target/'schema.d.ts')],cwd=frontend,check=True,stdout=subprocess.DEVNULL)
    (target/'consumer.ts').write_text("import createClient from 'openapi-fetch';\nimport type {paths} from './schema';\nconst api=createClient<paths>();\napi.POST('/api/v1/public/enquiries',{body:{category:'general',name:'Test',email:'test@example.test',organization:'',message:'Contract fixture',locale:'en',consent:true,website:''}});\n")
    result=subprocess.run(['node','node_modules/typescript/bin/tsc','--noEmit','--strict','--skipLibCheck','--target','es2022','--module','esnext','--moduleResolution','bundler',str(target/'consumer.ts')],cwd=frontend,capture_output=True,text=True)
    assert result.returncode!=0 and 'contractProbeField' in result.stdout, 'An incompatible request unexpectedly compiled: '+result.stdout+result.stderr
print('Breaking backend schema change regenerated client types and failed consumer compilation as expected')
