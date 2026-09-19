"""Voice-instruction composition in its only permitted order."""


def compose_instructions(
    instructions: str,
    accent_style: str,
    waiting_behavior: str,
) -> str:
    """Join non-empty instruction layers without inventing separators."""

    return "\n\n".join(
        part.strip() for part in (instructions, accent_style, waiting_behavior) if part.strip()
    )
