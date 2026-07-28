"""Prompts for optional web research."""

RESEARCH_TOOL_ADDENDUM = """

Live web research is available via web_search(query, max_results=5):
- Use it when a request needs current or external information
- Start with one focused query and search again only when a material gap remains
- The tool returns source snippets with URLs; synthesize the evidence and cite
  the useful sources rather than dumping raw results
"""

NO_RESEARCH_TOOL_ADDENDUM = """

You do NOT have a live web research tool available right now. Answer from your
own knowledge, state plainly when you cannot look up current or external
information, and never claim to have searched the web.
"""
