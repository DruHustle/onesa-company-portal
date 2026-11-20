import assert from 'node:assert/strict';
import {test} from 'node:test';
import {approvedMotion, permitsMotion, type HeroMotionAsset} from '../src/lib/hero-motion.ts';
const asset: HeroMotionAsset = {desktop:'/images/hero-motion-desktop.webm',mobile:'/images/hero-motion-mobile.mp4',durationSeconds:4,desktopBytes:1000,mobileBytes:500,desktopSha256:'a'.repeat(64),mobileSha256:'b'.repeat(64),rightsRecord:'synthetic-test-only'};
test('approval requires local variants, bounded duration/bytes and provenance',()=>{
  assert.equal(approvedMotion(null),false);assert.equal(approvedMotion(asset),true);
  for(const change of [{desktop:'https://example.com/video.mp4'},{mobile:'/images/../secret.mp4'},{durationSeconds:6},{desktopBytes:2_000_001},{mobileBytes:1_000_001},{rightsRecord:''},{desktopSha256:'unreviewed'}])assert.equal(approvedMotion({...asset,...change}),false);
});
test('static mode covers motion preference, hidden page and constrained connection',()=>{
  assert.equal(permitsMotion(false,true),true);
  assert.equal(permitsMotion(true,true),false);assert.equal(permitsMotion(false,false),false);
  for(const connection of [{saveData:true},{effectiveType:'slow-2g'},{effectiveType:'2g'},{effectiveType:'3g'},{downlink:1}])assert.equal(permitsMotion(false,true,connection),false);
  assert.equal(permitsMotion(false,true,{saveData:false,effectiveType:'4g',downlink:10}),true);
});
