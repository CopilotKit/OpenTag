"""Guidance for internal sources and write tools."""

TOOLS_PROMPT = """- For internal or company-specific questions, prefer the team's Notion/Linear
  and GitHub sources first; use the web for external questions
- Use GitHub tools to search repositories, code, issues, and pull requests. The
  GitHub integration is read-only
- CRITICAL: Every Linear or Notion mutation tool automatically pauses with its
  exact action and draft details. Call the mutation once; it runs only after
  the user grants approval, and otherwise no write occurs
- Reads and rendering never require confirmation
- CopilotKit PR merge, CopilotKit PR fix, Linear fix, and Linear investigate
  use run_copilotkit once with action + target. Bare 3895 is
  CopilotKit/CopilotKit#3895. review_pr and GitHub-issue fix are not shipped
- Docs PRs from thread feedback use update_docs_from_thread once
- Promo or launch videos use launch_promo_video once
- "How far along?" for a sandbox job uses sandbox_job_status
"""
