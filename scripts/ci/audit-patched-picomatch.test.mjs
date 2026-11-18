import test from 'node:test';
import assert from 'node:assert/strict';
import {traceAudit} from './audit-patched-picomatch.mjs';
const issue={name:'picomatch',url:'https://github.com/advisories/GHSA-fc5q-39xc-vjpf'};
const root={via:[issue],nodes:['node_modules/picomatch']};
const report=vulnerabilities=>({auditReportVersion:2,vulnerabilities});
test('accepts exactly the known fixed-source advisory and transitive derived chain',()=>{
 assert.equal(traceAudit(report({})).kind,'clear');
 assert.deepEqual(traceAudit(report({picomatch:root,fdir:{via:['picomatch']},tinyglobby:{via:['fdir','picomatch']}})),{kind:'mitigated-source',count:3,nodes:['node_modules/picomatch']});
});
test('unknown advisories, extra direct issue, unknown dependency and malformed output are refused',()=>{
 for(const input of [
  report({picomatch:root,other:{via:[{name:'other',url:'https://example.invalid'}]}}),
  report({picomatch:{via:[issue,{name:'picomatch',url:'https://example.invalid'}],nodes:['node_modules/picomatch']}}),
  report({picomatch:root,unknown:{via:['unknown-dep']}}),
  report({picomatch:{via:[issue],nodes:[]}}),
  {error:{code:'EAUDITERROR'}}
 ])assert.throws(()=>traceAudit(input));
});
