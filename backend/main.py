from fastapi import FastAPI

from app.config import settings
from app.routers import items_router, users_router


def create_app() -> FastAPI:
    app = FastAPI(title=settings.APP_NAME)
    # attach settings to the app state so it's accessible in routes and middleware
    app.state.settings = settings

    app.include_router(items_router)
    app.include_router(users_router)
    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=settings.DEBUG)
