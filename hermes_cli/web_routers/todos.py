"""Mission Control — Todo dashboard routes.

Lightweight, self-contained todo store backed by a JSON file under
``HERMES_HOME/todos.json``.  Intentionally standalone (no late-bound
web_server helpers) so it does not entangle the cron/session seams.

Endpoints:
  GET    /api/todos            -> list all todos
  POST   /api/todos            -> create {content, status?}
  PUT    /api/todos/{id}       -> update {content?, status?}
  DELETE /api/todos/{id}       -> delete one
"""

import json
import logging
import threading
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from hermes_constants import get_hermes_home

_log = logging.getLogger("hermes_cli.web_server")

router = APIRouter()

_LOCK = threading.Lock()
_VALID = {"pending", "in_progress", "completed", "cancelled"}


class TodoCreate(BaseModel):
    content: str = Field(..., min_length=1, max_length=2000)
    status: str = Field("pending", pattern="^(pending|in_progress|completed|cancelled)$")


class TodoUpdate(BaseModel):
    content: Optional[str] = Field(None, min_length=1, max_length=2000)
    status: Optional[str] = Field(None, pattern="^(pending|in_progress|completed|cancelled)$")


def _path() -> str:
    return str(get_hermes_home() / "todos.json")


def _read() -> list:
    try:
        with open(_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except Exception as exc:  # corrupt file -> start clean, don't crash the API
        _log.warning("todos.json unreadable (%s); returning empty", exc)
        return []


def _write(items: list) -> None:
    get_hermes_home().mkdir(parents=True, exist_ok=True)
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    # atomic replace
    import os
    os.replace(tmp, _path())


@router.get("/api/todos")
async def list_todos():
    with _LOCK:
        return _read()


@router.post("/api/todos", status_code=201)
async def create_todo(body: TodoCreate):
    with _LOCK:
        items = _read()
        item = {
            "id": uuid.uuid4().hex[:12],
            "content": body.content,
            "status": body.status,
        }
        items.append(item)
        _write(items)
        return item


@router.put("/api/todos/{todo_id}")
async def update_todo(todo_id: str, body: TodoUpdate):
    with _LOCK:
        items = _read()
        for it in items:
            if it.get("id") == todo_id:
                if body.content is not None:
                    it["content"] = body.content
                if body.status is not None:
                    it["status"] = body.status
                _write(items)
                return it
        raise HTTPException(status_code=404, detail="todo not found")


@router.delete("/api/todos/{todo_id}", status_code=204)
async def delete_todo(todo_id: str):
    with _LOCK:
        items = _read()
        new = [it for it in items if it.get("id") != todo_id]
        if len(new) == len(items):
            raise HTTPException(status_code=404, detail="todo not found")
        _write(new)
        return None
