from fastapi import FastAPI

from app.routers import items_router, users_router


def create_app() -> FastAPI:
    app = FastAPI(title="OwlShelf API")
    app.include_router(items_router)
    app.include_router(users_router)
    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
