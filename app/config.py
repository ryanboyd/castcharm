import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "sqlite:////data/castcharm.db"
    default_download_path: str = "/downloads"
    clean_rss_path: str = "/downloads/clean-rss"

    class Config:
        env_file = ".env"


settings = Settings()
