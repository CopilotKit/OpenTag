"""Per-request calendar context for the agent."""

from datetime import datetime, timezone

from langchain.agents.middleware import dynamic_prompt
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import SystemMessage


def current_date_context(now: datetime | None = None) -> str:
    """Return authoritative UTC date guidance for the model."""
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    current = current.astimezone(timezone.utc)
    formatted_date = f"{current.strftime('%B')} {current.day}, {current.year}"
    return (
        "Current date: "
        f"{formatted_date} (UTC). Treat this date as authoritative. Compare "
        "dates in the user's request against it: a date before this date is "
        "in the past, even if it falls beyond your training data."
    )


@dynamic_prompt
def current_date_prompt(request: ModelRequest) -> SystemMessage:
    """Append a freshly computed date to every model request."""
    date_context = current_date_context()
    system_message = request.system_message
    if system_message is None:
        return SystemMessage(content=date_context)

    content = system_message.content
    if isinstance(content, str):
        updated_content = f"{content}\n\n{date_context}"
    else:
        updated_content = [
            *content,
            {"type": "text", "text": f"\n\n{date_context}"},
        ]
    return system_message.model_copy(update={"content": updated_content})
