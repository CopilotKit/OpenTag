"""Turning one Arcade execute response into one thing we can act on.

The plan requires six outcomes to stay distinct: needs authorization, revoked or
expired authorization, provider unavailable, invalid arguments, a definite
failure, and an outcome nobody can determine. Arcade publishes a typed error
kind, so these are read rather than guessed from message text.

The outcome that matters most is the last one. A write whose result is unknown
must never be replayed automatically, however cheerfully the provider says it
may be retried.
"""

from __future__ import annotations

import pytest

from arcade_tools.outcomes import (
    Outcome,
    describe_outcome,
    outcome_of_response,
    outcome_of_transport_error,
)


def response(**output):
    return {"success": False, "output": output}


def error(kind, **fields):
    return response(error={"kind": kind, "message": "provider text", **fields})


def test_a_successful_call_is_a_success():
    result = outcome_of_response({"success": True, "output": {"value": {"ok": 1}}})

    assert result.outcome is Outcome.SUCCEEDED
    assert result.value == {"ok": 1}


def test_unmet_requirements_read_as_needing_authorization():
    result = outcome_of_response(error("TOOL_REQUIREMENTS_NOT_MET"))

    assert result.outcome is Outcome.NEEDS_AUTHORIZATION


def test_an_upstream_auth_error_reads_as_revoked_rather_than_never_connected():
    # Different sentence to the person: "connect your account" is wrong advice
    # for somebody who connected it last month and had the token revoked.
    result = outcome_of_response(error("UPSTREAM_RUNTIME_AUTH_ERROR"))

    assert result.outcome is Outcome.AUTHORIZATION_EXPIRED


@pytest.mark.parametrize(
    "kind",
    ["TOOL_RUNTIME_BAD_INPUT_VALUE", "UPSTREAM_RUNTIME_VALIDATION_ERROR",
     "UPSTREAM_RUNTIME_BAD_REQUEST"],
)
def test_bad_arguments_are_their_own_outcome(kind):
    # The model can fix this one itself, and telling it "the provider is
    # unavailable" would make it wait instead.
    assert outcome_of_response(error(kind)).outcome is Outcome.INVALID_ARGUMENTS


def test_rate_limiting_carries_how_long_to_wait():
    result = outcome_of_response(
        error("UPSTREAM_RUNTIME_RATE_LIMIT", retry_after_ms=4500)
    )

    assert result.outcome is Outcome.RATE_LIMITED
    assert result.retry_after_ms == 4500


@pytest.mark.parametrize(
    "kind", ["UPSTREAM_RUNTIME_SERVER_ERROR", "TOOLKIT_LOAD_FAILED"]
)
def test_provider_trouble_is_unavailable_rather_than_a_tool_failure(kind):
    assert outcome_of_response(error(kind)).outcome is Outcome.PROVIDER_UNAVAILABLE


def test_a_fatal_runtime_error_is_a_definite_failure():
    # Definite matters: the call did not happen, so saying so is safe.
    assert outcome_of_response(error("TOOL_RUNTIME_FATAL")).outcome is Outcome.FAILED


def test_an_unknown_error_kind_is_not_guessed_at():
    # A kind this build has never heard of is an outcome nobody can determine,
    # not a failure. Calling it a failure would tell an approver their write did
    # not happen, which is a claim nothing here can support.
    assert outcome_of_response(error("SOMETHING_NEW")).outcome is Outcome.UNKNOWN


def test_a_response_with_no_output_at_all_is_unknown():
    assert outcome_of_response({"success": False}).outcome is Outcome.UNKNOWN


def test_a_response_that_is_not_a_response_is_unknown():
    for junk in (None, "ok", 42, []):
        assert outcome_of_response(junk).outcome is Outcome.UNKNOWN


def test_success_false_with_no_error_is_unknown_rather_than_failed():
    assert outcome_of_response(response()).outcome is Outcome.UNKNOWN


def test_a_transport_failure_is_unknown_not_failed():
    # The request left; nothing came back. Whether the write landed is exactly
    # what cannot be established.
    result = outcome_of_transport_error(TimeoutError("read timed out"))

    assert result.outcome is Outcome.UNKNOWN


def test_the_providers_retry_opinion_never_reaches_an_unknown_outcome():
    # `can_retry` is Arcade's opinion about its own error. For an outcome nobody
    # can determine, replaying is how one write becomes two.
    result = outcome_of_response(error("SOMETHING_NEW", can_retry=True))

    assert result.outcome is Outcome.UNKNOWN
    assert result.safe_to_retry is False


def test_only_a_definite_non_write_failure_is_ever_retryable():
    retryable = outcome_of_response(error("TOOL_RUNTIME_RETRY", can_retry=True))

    assert retryable.outcome is Outcome.FAILED
    assert retryable.safe_to_retry is True


def test_an_authorization_url_never_survives_into_the_outcome():
    # `output.authorization` carries a bearer capability. It reaches the model
    # as a tool result unless something removes it here.
    raw = response(
        error={"kind": "TOOL_REQUIREMENTS_NOT_MET", "message": "connect first"},
        authorization={
            "id": "auth_1",
            "url": "https://arcade.example/authorize?secret=abcd",
            "status": "pending",
        },
    )

    result = outcome_of_response(raw)
    rendered = describe_outcome(result, action="Send an email")

    assert result.outcome is Outcome.NEEDS_AUTHORIZATION
    assert "https://" not in rendered
    assert "abcd" not in rendered
    assert result.authorization_url is None


def test_the_provider_message_reaches_the_model_for_a_fixable_error():
    # A validation message is the one case where the provider's own words help:
    # the model needs to know which argument it got wrong.
    result = outcome_of_response(
        {
            "success": False,
            "output": {
                "error": {
                    "kind": "TOOL_RUNTIME_BAD_INPUT_VALUE",
                    "message": "field 'to' must be an email address",
                }
            },
        }
    )
    rendered = describe_outcome(result, action="Send an email")

    assert "must be an email address" in rendered


def test_an_unknown_outcome_says_the_write_may_already_have_happened():
    rendered = describe_outcome(
        outcome_of_transport_error(TimeoutError()), action="Send an email"
    )

    assert "may already" in rendered.lower()


def test_a_definite_failure_does_not_cast_doubt_on_a_write_that_never_ran():
    rendered = describe_outcome(
        outcome_of_response(error("TOOL_RUNTIME_FATAL")), action="Send an email"
    )

    assert "may already" not in rendered.lower()



def test_an_upstream_auth_error_does_not_declare_the_account_dead():
    # Found live: `ListPullRequests` succeeded and `WhoAmI`, on the same
    # account seconds later, came back with this error. Arcade authorizes per
    # action, so the likelier reading is missing permission for this action,
    # and saying "revoked" sent the model to look for a different tool.
    rendered = describe_outcome(
        outcome_of_response(error("UPSTREAM_RUNTIME_AUTH_ERROR")), action="Who am i"
    )

    assert "additional permission" in rendered
