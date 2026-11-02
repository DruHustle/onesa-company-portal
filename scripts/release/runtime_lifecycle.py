"""Private host lifecycle interlock; never grants deployment or recovery authority.

The recovery controller and commissioned owner operations share this lock. A hold
survives interruption and is removed only by explicit matching completion. Before
state enrollment, absent/disabled configuration preserves owner-operation behavior.
After enrollment, disabling remediation never disables the lifecycle interlock.
"""

import fcntl
import json
import os
import stat
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID, uuid4

CONFIG = Path("/etc/onesa/runtime-recovery.json")
STATE = Path("/var/lib/onesa/runtime-recovery")
LOCK = STATE / "lifecycle.lock"
HOLD = STATE / "maintenance.json"
MAX_BYTES = 128 * 1024
OWNER_UID = 0


class LifecycleError(ValueError):
    pass


class LifecycleBusy(LifecycleError):
    pass


def require(value, code):
    if not value:
        raise LifecycleError(code)


def private_path(path, *, directory=False):
    """Validate custody without following a final or ancestor symlink."""
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts, "LIFECYCLE_PATH")
    info = path.lstat()
    require(
        info.st_uid == OWNER_UID
        and info.st_mode & 0o077 == 0
        and (
            stat.S_ISDIR(info.st_mode)
            if directory
            else stat.S_ISREG(info.st_mode) and info.st_nlink == 1
        ),
        "LIFECYCLE_PRIVATE_CUSTODY",
    )
    for ancestor in path.parents:
        parent = ancestor.lstat()
        require(
            stat.S_ISDIR(parent.st_mode)
            and parent.st_uid in {0, OWNER_UID}
            and parent.st_mode & 0o022 == 0,
            "LIFECYCLE_ANCESTOR_CUSTODY",
        )
    return info


def _same_file(fd, path):
    observed, current = os.fstat(fd), private_path(path)
    require(
        (observed.st_dev, observed.st_ino) == (current.st_dev, current.st_ino)
        and observed.st_nlink == 1,
        "LIFECYCLE_FILE_REPLACED",
    )


def _unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "LIFECYCLE_DUPLICATE_FIELD")
        result[key] = value
    return result


def _nonfinite(_value):
    raise LifecycleError("LIFECYCLE_NONFINITE_VALUE")


def read_private_json(path, *, limit=MAX_BYTES, required=True):
    path = Path(path)
    try:
        info = private_path(path)
    except FileNotFoundError:
        if not required:
            return None
        raise LifecycleError("LIFECYCLE_FILE_MISSING") from None
    require(0 < info.st_size <= limit, "LIFECYCLE_FILE_SIZE")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        _same_file(fd, path)
        with os.fdopen(os.dup(fd), "rb") as stream:
            raw = stream.read(limit + 1)
        require(0 < len(raw) <= limit, "LIFECYCLE_FILE_SIZE")
        _same_file(fd, path)
        try:
            value = json.loads(raw, object_pairs_hook=_unique, parse_constant=_nonfinite)
            require(isinstance(value, dict), "LIFECYCLE_JSON_OBJECT_REQUIRED")
            return value
        except (UnicodeError, json.JSONDecodeError):
            raise LifecycleError("LIFECYCLE_JSON_INVALID") from None
    finally:
        os.close(fd)


def _sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_private_json(path, value, *, create_only=False):
    """Commit a private record durably before any separately authorized action."""
    path = Path(path)
    require(isinstance(value, dict), "LIFECYCLE_JSON_OBJECT_REQUIRED")
    private_path(path.parent, directory=True)
    try:
        private_path(path)
        require(not create_only, "LIFECYCLE_RECORD_EXISTS")
    except FileNotFoundError:
        pass
    raw = (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()
    require(0 < len(raw) <= MAX_BYTES, "LIFECYCLE_FILE_SIZE")
    temporary = path if create_only else path.with_name("." + path.name + "." + uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        if not create_only:
            os.replace(temporary, path)
        _sync_directory(path.parent)
    finally:
        if not create_only:
            temporary.unlink(missing_ok=True)


class LifecycleGuard:
    def __init__(self, fd=None):
        self.active = fd is not None
        self._fd = fd
        self._open = True

    def _check(self):
        require(self._open, "LIFECYCLE_GUARD_CLOSED")
        if self.active:
            _same_file(self._fd, LOCK)

    def read_hold(self):
        self._check()
        if not self.active:
            return None
        hold = read_private_json(HOLD, required=False)
        if hold is None:
            return None
        require(
            isinstance(hold, dict)
            and {"schema_version", "token", "kind", "scope", "reference", "created_at"} <= set(hold)
            and set(hold) <= {"schema_version", "token", "kind", "scope", "reference", "created_at", "revocations"}
            and type(hold["schema_version"]) is int
            and hold["schema_version"] == 1
            and all(isinstance(hold[key], str) and 0 < len(hold[key]) <= 4096 for key in ["token", "kind", "scope", "reference"])
            and type(hold["created_at"]) in {int, float}
            and hold["created_at"] > 0,
            "LIFECYCLE_HOLD_INVALID",
        )
        try:
            require(str(UUID(hold["token"])) == hold["token"], "LIFECYCLE_HOLD_TOKEN")
        except (ValueError, TypeError, AttributeError):
            raise LifecycleError("LIFECYCLE_HOLD_TOKEN") from None
        if "revocations" in hold:
            require(
                isinstance(hold["revocations"], list)
                and 1 <= len(hold["revocations"]) <= 128
                and all(
                    isinstance(row, dict)
                    and set(row) == {"scope", "reference"}
                    and all(isinstance(value, str) and 0 < len(value) <= 4096 for value in row.values())
                    for row in hold["revocations"]
                ),
                "LIFECYCLE_REVOCATION_INVALID",
            )
        return hold

    def begin_hold(self, kind, scope, reference, *, resume=False):
        self._check()
        if not self.active:
            return None
        require(
            all(isinstance(value, str) and 0 < len(value) <= 4096 for value in [kind, scope, reference]),
            "LIFECYCLE_HOLD_BINDING",
        )
        existing = self.read_hold()
        if existing is not None:
            require(
                resume and all(existing[key] == value for key, value in [("kind", kind), ("scope", scope), ("reference", reference)]),
                "LIFECYCLE_MAINTENANCE_HOLD",
            )
            return existing["token"]
        token = str(uuid4())
        write_private_json(HOLD, {
            "schema_version": 1,
            "token": token,
            "kind": kind,
            "scope": scope,
            "reference": reference,
            "created_at": time.time(),
        }, create_only=True)
        return token

    def complete_hold(self, token):
        self._check()
        if not self.active:
            return
        hold = self.read_hold()
        require(hold is not None and hold["token"] == token, "LIFECYCLE_HOLD_CHANGED")
        require(not hold.get("revocations"), "LIFECYCLE_REVOKED_REENROLLMENT_REQUIRED")
        HOLD.unlink()
        _sync_directory(HOLD.parent)

    def mark_revocation(self, scope, reference):
        """Retain pending-operation identity and add a sticky owner inhibition."""
        self._check()
        if not self.active:
            return
        require(
            all(isinstance(value, str) and 0 < len(value) <= 4096 for value in [scope, reference]),
            "LIFECYCLE_HOLD_BINDING",
        )
        if self.read_hold() is None:
            self.begin_hold("owner-revoke", scope, reference)
        hold = self.read_hold()
        revoked = {"scope": scope, "reference": reference}
        rows = hold.setdefault("revocations", [])
        if revoked not in rows:
            require(len(rows) < 128, "LIFECYCLE_REVOCATION_BOUND")
            rows.append(revoked)
            write_private_json(HOLD, hold)


@contextmanager
def lifecycle_lock(*, required=False):
    """Global-before-component lock order; no lock-file deletion or lazy enrollment."""
    config = read_private_json(CONFIG, required=False)
    if config is not None:
        require(isinstance(config, dict) and type(config.get("enabled")) is bool, "LIFECYCLE_CONFIG_INVALID")
    enabled = config is not None and config["enabled"] is True
    require(not required or enabled, "LIFECYCLE_RECOVERY_DISABLED")
    try:
        STATE.lstat()
        enrolled = True
    except FileNotFoundError:
        enrolled = False
    # Disabling remediation must not erase maintenance or revocation exclusion.
    # Commissioning pre-creates STATE while quiescent, before enabling recovery;
    # that permanently opts owner operations into the shared lock protocol.
    if not enabled and not enrolled:
        guard = LifecycleGuard()
        try:
            yield guard
        finally:
            guard._open = False
        return
    require(os.geteuid() == OWNER_UID, "LIFECYCLE_OWNER_REQUIRED")
    private_path(STATE, directory=True)
    fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    guard = LifecycleGuard(fd)
    try:
        _same_file(fd, LOCK)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LifecycleBusy("LIFECYCLE_BUSY") from None
        _same_file(fd, LOCK)
        # Enabling/disabling or replacing enrollment must use this same lock.
        require(read_private_json(CONFIG, required=False) == config, "LIFECYCLE_CONFIG_CHANGED")
        yield guard
    finally:
        guard._open = False
        os.close(fd)
