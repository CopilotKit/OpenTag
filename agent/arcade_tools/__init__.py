"""The Arcade connected-app provider.

Selected by `ARCADE_API_KEY`, and never constructed alongside Composio — see
`connected_app_provider`. Everything Arcade-shaped lives behind this package:
SDK response parsing, authorization scopes, and provider errors.

Identity, the approval card and the effect vocabulary are not Arcade's and are
not re-implemented here. They are imported from where they already live.
"""
