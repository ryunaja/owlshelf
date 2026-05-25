from typing import List

from app.schemas import User, UserCreate
from fastapi import APIRouter

router = APIRouter(prefix="/users", tags=["users"])

# In-memory example store (replace with DB in real app)
_users = [{"id": 1, "username": "alice", "email": "alice@example.com"}]


@router.get("/", response_model=List[User])
def list_users():
    return _users


@router.post("/", response_model=User, status_code=201)
def create_user(user: UserCreate):
    new_id = max([u["id"] for u in _users]) + 1 if _users else 1
    new_user = {"id": new_id, "username": user.username, "email": user.email}
    _users.append(new_user)
    return new_user
