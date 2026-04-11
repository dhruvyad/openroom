"""Unit tests for JCS canonicalization.

The load-bearing guarantee is byte-for-byte compatibility with the JS
SDK's packages/sdk/src/jcs.ts. We lock that in two ways: (1) a handful
of precomputed fixtures in this file, and (2) the cross-language smoke
test that actually verifies a Python-signed envelope under the JS SDK.
"""

from __future__ import annotations

import pytest

from openroom.jcs import canonicalize


def test_primitives() -> None:
    assert canonicalize(None) == "null"
    assert canonicalize(True) == "true"
    assert canonicalize(False) == "false"
    assert canonicalize(0) == "0"
    assert canonicalize(42) == "42"
    assert canonicalize(-7) == "-7"
    assert canonicalize("") == '""'
    assert canonicalize("hello") == '"hello"'


def test_string_escapes_match_js_json_stringify() -> None:
    assert canonicalize("a\nb") == '"a\\nb"'
    assert canonicalize('he said "hi"') == '"he said \\"hi\\""'
    assert canonicalize("back\\slash") == '"back\\\\slash"'


def test_non_ascii_is_preserved() -> None:
    # JS JSON.stringify does NOT escape non-ASCII printables. Python's
    # default ensure_ascii=True would — we pass False to match.
    assert canonicalize("héllo") == '"héllo"'
    assert canonicalize("日本語") == '"日本語"'


def test_object_keys_are_sorted() -> None:
    assert canonicalize({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_nested_objects() -> None:
    data = {"outer": {"b": 2, "a": 1}}
    assert canonicalize(data) == '{"outer":{"a":1,"b":2}}'


def test_arrays_preserve_order() -> None:
    assert canonicalize([3, 1, 2]) == "[3,1,2]"
    assert canonicalize(["b", "a"]) == '["b","a"]'


def test_empty_containers() -> None:
    assert canonicalize({}) == "{}"
    assert canonicalize([]) == "[]"


def test_realistic_envelope_body() -> None:
    # Matches the shape we actually sign in practice.
    unsigned = {
        "type": "send",
        "id": "fixed-id",
        "ts": 1700000000,
        "from": "abc",
        "payload": {"topic": "main", "body": "hi"},
    }
    canonical = canonicalize(unsigned)
    # Keys sorted alphabetically: from, id, payload, ts, type
    # Within payload: body, topic
    assert canonical == (
        '{"from":"abc",'
        '"id":"fixed-id",'
        '"payload":{"body":"hi","topic":"main"},'
        '"ts":1700000000,'
        '"type":"send"}'
    )


def test_non_string_dict_key_rejected() -> None:
    with pytest.raises(TypeError, match="dict keys must be str"):
        canonicalize({1: "a"})


def test_non_finite_float_rejected() -> None:
    with pytest.raises(ValueError, match="non-finite"):
        canonicalize(float("inf"))
    with pytest.raises(ValueError, match="non-finite"):
        canonicalize(float("nan"))


def test_ellipsis_sentinel_omits_key() -> None:
    # Allows callers to build dicts where "this optional field is not set"
    # is expressed as ``{"field": ...}`` without needing to conditionally
    # construct the dict. Mirrors the JS undefined behavior.
    assert canonicalize({"a": 1, "b": ...}) == '{"a":1}'


def test_tuple_treated_as_list() -> None:
    assert canonicalize((1, 2, 3)) == "[1,2,3]"
