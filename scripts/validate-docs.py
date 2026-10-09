from pathlib import Path
root=Path(__file__).resolve().parents[1]
required=['README.md','IMPLEMENTATION_STATUS.md','SESSION_HANDOFF.md','CHANGELOG.md','RELEASE_CHECKLIST.md','docs/api/API.md','docs/engineering/BUILD_AND_TEST.md','docs/engineering/DEPLOYMENT.md','SECURITY.md','docs/database/SCHEMA.md']
for p in required:
 assert (root/p).is_file() and (root/p).stat().st_size>100,p
print('Required documentation exists and is nonempty')
