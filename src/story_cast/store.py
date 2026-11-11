"""Revisioned JSON storage for Auto cast sessions (one file per session)."""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

from src.json_storage import write_json_atomic

_SESSION_ID = re.compile(r"^[a-f0-9]{32}$")


class SessionNotFound(KeyError):
    pass


class RevisionConflict(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class StoryCastStore:
    def __init__(self, base_dir: Path):
        self.base_dir = Path(base_dir)
        self._lock = threading.RLock()

    def _path(self, session_id: str) -> Path:
        if not _SESSION_ID.match(str(session_id or "")):
            raise SessionNotFound(session_id)
        return self.base_dir / f"{session_id}.json"

    def load(self, session_id: str) -> Dict:
        path = self._path(session_id)
        with self._lock:
            if not path.exists():
                raise SessionNotFound(session_id)
            return json.loads(path.read_text(encoding="utf-8"))

    def delete(self, session_id: str) -> bool:
        path = self._path(session_id)
        with self._lock:
            try:
                path.unlink()
                return True
            except FileNotFoundError:
                return False

    def create(self, session: Dict) -> Dict:
        with self._lock:
            session["rev"] = 1
            session["updated_at"] = utc_now()
            write_json_atomic(self._path(session["id"]), session, indent=None, ensure_ascii=False)
            return session

    def update(self, session_id: str, mutate: Callable[[Dict], Optional[Dict]],
               expected_rev: Optional[int] = None) -> Dict:
        """Load, mutate and save atomically under the store lock."""
        with self._lock:
            session = self.load(session_id)
            if expected_rev is not None and int(expected_rev) != int(session.get("rev", 0)):
                raise RevisionConflict(
                    f"Session changed (revision {session.get('rev')}, expected {expected_rev}); reload it first"
                )
            result = mutate(session)
            if result is not None:
                session = result
            session["rev"] = int(session.get("rev", 0)) + 1
            session["updated_at"] = utc_now()
            write_json_atomic(self._path(session_id), session, indent=None, ensure_ascii=False)
            return session

    def list_sessions(self, project_id: Optional[str] = None) -> List[Dict]:
        summaries = []
        with self._lock:
            if not self.base_dir.exists():
                return []
            for path in self.base_dir.glob("*.json"):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if project_id and str(data.get("project_id") or "") != str(project_id):
                    continue
                summaries.append({
                    "id": data.get("id"),
                    "project_id": data.get("project_id"),
                    "status": data.get("status"),
                    "phase": data.get("phase"),
                    "updated_at": data.get("updated_at"),
                    "title": data.get("title"),
                })
        summaries.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
        return summaries

    def mark_interrupted(self) -> int:
        """After a restart no worker is alive: running sessions become interrupted."""
        count = 0
        with self._lock:
            if not self.base_dir.exists():
                return 0
            for path in self.base_dir.glob("*.json"):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if data.get("status") == "running":
                    data["status"] = "interrupted"
                    data["rev"] = int(data.get("rev", 0)) + 1
                    data["updated_at"] = utc_now()
                    write_json_atomic(path, data, indent=None, ensure_ascii=False)
                    count += 1
        return count
