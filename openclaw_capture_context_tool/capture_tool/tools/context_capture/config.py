from pydantic import BaseModel, Field


class CaptureConfig(BaseModel):
    listen_host: str = "0.0.0.0"
    listen_port: int = Field(default=18080, ge=1, le=65535)
