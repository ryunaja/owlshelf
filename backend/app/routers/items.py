from typing import List

from fastapi import APIRouter

from app.schemas import Item, ItemCreate

router = APIRouter(prefix="/items", tags=["items"])

# In-memory example store (replace with DB in real app)
_items = [{"id": 1, "name": "Sample Item", "description": "A test item"}]


@router.get("/", response_model=List[Item])
def list_items():
    return _items


@router.post("/", response_model=Item, status_code=201)
def create_item(item: ItemCreate):
    new_id = max([i["id"] for i in _items]) + 1 if _items else 1
    new_item = {"id": new_id, "name": item.name, "description": item.description}
    _items.append(new_item)
    return new_item
