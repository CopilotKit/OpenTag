"""Prompt guidance for optional direct web search."""

WEB_SEARCH_TOOL_ADDENDUM = """

Live web research is available via web_search(query, max_results=5):
- You MUST call web_search before answering when a request depends on facts
  that may have changed or happened after your training data. This includes
  current/latest/recent claims, news, sports results or schedules, elections
  and officeholders, prices, weather, laws, product releases, and live service
  status
- You MUST also search when the user names a real-world event in the current
  calendar year or later, asks whether an event has happened, requests links
  or sources, or explicitly asks you to search
- Compare mentioned dates with the authoritative current date in the system
  prompt. Never reject or "correct" a premise as being in the future based
  only on training data; search first if the event could have happened by now
- Example: if asked who won the 2026 World Cup after that event's date, search
  for the result instead of claiming that the tournament has not happened
- Do not search for timeless facts, casual conversation, writing, translation,
  or summarization when the user has already supplied all necessary material
- Start with one focused query and search again only when a material gap remains
- The tool returns source snippets with URLs; synthesize the evidence and cite
  the useful sources rather than dumping raw results
"""

NO_WEB_SEARCH_TOOL_ADDENDUM = """

You do NOT have a live web research tool available right now. Answer from your
own knowledge, state plainly when you cannot look up current or external
information, and never claim to have searched the web. Still use the
authoritative current date from the system prompt; do not substitute the
chronology implied by your training data.
"""
