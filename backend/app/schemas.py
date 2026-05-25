from typing import Optional

from pydantic import BaseModel, EmailStr


class Item(BaseModel):
    id: int
    name: str
    description: Optional[str] = None


class ItemCreate(BaseModel):
    name: str
    description: Optional[str] = None


class User(BaseModel):
    id: int
    username: str
    email: EmailStr


class UserCreate(BaseModel):
    username: str
    email: EmailStr
