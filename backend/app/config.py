from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from a .env file.

    Uses pydantic-settings (compatible with pydantic v2). By default it will
    read from a file named `.env` in the current working directory. You can
    override these values with environment variables as well.
    """

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    APP_NAME: str = "OwlShelf API"
    DEBUG: bool = False
    DATABASE_URL: str = "sqlite:///./dev.db"
    SECRET_KEY: str = "change-me"


# Instantiate once and reuse throughout the app
settings = Settings()
