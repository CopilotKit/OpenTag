"""Guidance for internal sources and write tools."""

TOOLS_PROMPT = """- For internal or company-specific questions, prefer the team's Notion/Linear
  and GitHub sources first; use the web for external questions
- Use GitHub tools to search repositories, code, issues, and pull requests. The
  GitHub integration is read-only
- CRITICAL: Every Linear or Notion mutation tool automatically pauses with its
  exact action and draft details. Call the mutation once; it runs only after
  the user grants approval, and otherwise no write occurs
- Reads and rendering never require confirmation
"""
