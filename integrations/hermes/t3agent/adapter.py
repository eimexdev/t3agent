"""Hermes platform adapter for the T3 Agent surface.

The adapter owns a loopback-only HTTP ingress used by the local T3 server and
posts all Hermes output to that server's authenticated event bridge.  It is a
normal Hermes platform adapter: inbound messages become ``MessageEvent``
instances and therefore use the gateway's regular sessions, commands,
interrupts, approvals, clarifications, and async-delivery machinery.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
from collections import OrderedDict
import hashlib
import hmac
import ipaddress
import json
import logging
import mimetypes
import os
from pathlib import Path
import re
import secrets
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote, unquote_to_bytes, urlparse

try:
    from aiohttp import ClientError, ClientSession, ClientTimeout, web

    AIOHTTP_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised by Hermes' requirement probe
    ClientError = Exception  # type: ignore[assignment]
    ClientSession = None  # type: ignore[assignment]
    ClientTimeout = None  # type: ignore[assignment]
    web = None  # type: ignore[assignment]
    AIOHTTP_AVAILABLE = False

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    ProcessingOutcome,
    SendResult,
    cache_image_from_url,
    cache_media_bytes,
)
from gateway.session import build_session_key
from hermes_constants import get_hermes_dir


logger = logging.getLogger(__name__)

PROTOCOL_VERSION = 1
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8789
DEFAULT_MAX_BODY_BYTES = 16 * 1_048_576
MAX_IMAGE_BYTES = 10 * 1_048_576
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_IDEMPOTENCY_CACHE_SIZE = 2_048
CANONICAL_CHAT_ID = "t3agent"

_INGRESS_TOKEN_ENV = "T3_AGENT_INGRESS_TOKEN"
_BRIDGE_TOKEN_ENV = "T3_AGENT_BRIDGE_TOKEN"
_BRIDGE_URL_ENV = "T3_AGENT_BRIDGE_URL"
_INSTANCE_ID_ENV = "T3_AGENT_INSTANCE_ID"
_HOME_CHAT_ENV = "T3_AGENT_HOME_CHAT"
_HOME_THREAD_ENV = "T3_AGENT_HOME_CHAT_THREAD_ID"
_OUTBOX_PATH_ENV = "T3_AGENT_OUTBOX_PATH"
_INGRESS_LEDGER_PATH_ENV = "T3_AGENT_INGRESS_LEDGER_PATH"

_DISCORD_TRIGGERING_MESSAGE_PREFIX = re.compile(
    r"^\[Triggering message id:[^\r\n]*\]\s*",
    re.IGNORECASE,
)
_DISCORD_TEXT_DOCUMENT_PREFIX = re.compile(
    r"^\[The user sent a text document: '([^'\r\n]+)'\. "
    r"Its content has been included below\. The file is also saved at: "
    r"[^\]\r\n]+\]\s*",
    re.IGNORECASE,
)
_DISCORD_SENDER_PREFIX = re.compile(r"^\[([^\]\r\n:]{1,80})\]\s+")
_DISCORD_NON_SENDER_LABEL = re.compile(r"^(?:async\b|the user\b)", re.IGNORECASE)
_HERMES_ASYNC_DELEGATION_RESULT_PREFIX = re.compile(
    r"^\[ASYNC DELEGATION BATCH COMPLETE\b",
    re.IGNORECASE,
)


def _env_or_extra(config: PlatformConfig, env_name: str, key: str, default: Any = "") -> Any:
    value = os.getenv(env_name)
    if value is not None and value != "":
        return value
    return (getattr(config, "extra", {}) or {}).get(key, default)


def _positive_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _positive_float(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _is_loopback_host(host: str) -> bool:
    normalized = host.strip().strip("[]").lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def _bridge_url_is_valid(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc) and not parsed.username


def _canonical_id(prefix: str, value: Dict[str, Any]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:32]
    return f"{prefix}_{digest}"


def _metadata_value(metadata: Optional[Dict[str, Any]], *keys: str) -> Optional[str]:
    if not isinstance(metadata, dict):
        return None
    for key in keys:
        value = metadata.get(key)
        if value is not None and str(value).strip():
            return str(value)
    return None


def _require_string(payload: Dict[str, Any], key: str, *, allow_empty: bool = False) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ValueError(f"{key} must be a non-empty string")
    return value


def _optional_string(payload: Dict[str, Any], key: str) -> Optional[str]:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string when provided")
    return value


def _ack(request_id: str, status: str, message: Optional[str] = None) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "status": status,
    }
    if message:
        body["message"] = message
    return body


async def _apply_gateway_model_selection(
    gateway_runner: Any,
    event: MessageEvent,
    session_key: str,
    model: str,
    provider: str,
) -> Optional[str]:
    """Apply a Hermes-native model change and verify it committed.

    Hermes owns provider validation and expensive-model confirmations.  The
    bridge deliberately goes through that command path, but it must not send
    the user's prompt until the requested session override actually exists.
    """
    rehydrate = getattr(gateway_runner, "_rehydrate_session_model_override", None)
    if callable(rehydrate):
        rehydrate(session_key)
    overrides = getattr(gateway_runner, "_session_model_overrides", {}) or {}
    selected = overrides.get(session_key) or {}
    if selected.get("model") == model and selected.get("provider") == provider:
        return None
    if not selected:
        try:
            from gateway.run import _load_gateway_config

            config = _load_gateway_config() or {}
            configured_model = config.get("model", {})
            if (
                isinstance(configured_model, dict)
                and str(configured_model.get("default") or "").strip() == model
                and str(configured_model.get("provider") or "openrouter").strip()
                == provider
            ):
                return None
        except Exception:
            logger.debug("[t3agent] unable to compare the Hermes default model", exc_info=True)
    result = await gateway_runner._handle_model_command(event)
    overrides = getattr(gateway_runner, "_session_model_overrides", {}) or {}
    selected = overrides.get(session_key) or {}
    if selected.get("model") == model and selected.get("provider") == provider:
        return None
    detail = result.strip() if isinstance(result, str) and result.strip() else ""
    retry = (
        "The message was not sent. Complete the model confirmation if one is "
        "pending, then send it again."
    )
    return f"{detail}\n\n{retry}" if detail else retry


def _apply_gateway_reasoning_selection(
    gateway_runner: Any,
    session_key: str,
    platform: Platform,
    reasoning_effort: str,
) -> None:
    from gateway.run import _platform_config_key

    gateway_runner._apply_reasoning_selection(
        session_key,
        _platform_config_key(platform),
        reasoning_effort,
    )


def _gateway_session_resources(gateway_runner: Any) -> Tuple[Any, Any, Any]:
    """Keep Hermes' session-store compatibility seam in one place."""
    session_db = getattr(gateway_runner, "_session_db", None)
    async_store = getattr(gateway_runner, "async_session_store", None)
    db = getattr(session_db, "_db", session_db)
    return session_db, async_store, db


def _is_synthetic_history_user(content: Any) -> bool:
    return isinstance(content, str) and bool(
        _HERMES_ASYNC_DELEGATION_RESULT_PREFIX.match(content)
    )


def _normalize_history_user_content(source: str, content: str) -> str:
    if source.strip().casefold() != "discord":
        return content

    body = _DISCORD_TRIGGERING_MESSAGE_PREFIX.sub("", content, count=1)
    document_match = _DISCORD_TEXT_DOCUMENT_PREFIX.match(body)
    attachment_label = ""
    if document_match is not None:
        attachment_label = f"**Attached:** {document_match.group(1)}\n\n"
        body = body[document_match.end() :]

    sender_match = _DISCORD_SENDER_PREFIX.match(body)
    if sender_match is not None and not _DISCORD_NON_SENDER_LABEL.match(
        sender_match.group(1)
    ):
        body = body[sender_match.end() :]
    return f"{attachment_label}{body}"


def _stored_model_config(session: Dict[str, Any]) -> Dict[str, Any]:
    raw_config = session.get("model_config")
    if isinstance(raw_config, dict):
        return dict(raw_config)
    if isinstance(raw_config, str) and raw_config.strip():
        try:
            parsed = json.loads(raw_config)
            if isinstance(parsed, dict):
                return parsed
        except (TypeError, ValueError):
            logger.debug("[t3agent] unable to parse stored Hermes model config", exc_info=True)
    return {}


def _reasoning_effort_from_config(config: Any) -> Optional[str]:
    if not isinstance(config, dict):
        return None
    if config.get("enabled") is False:
        return "none"
    effort = str(config.get("effort") or "").strip()
    return effort or None


def _session_runtime_selection(
    gateway_runner: Any,
    session: Dict[str, Any],
    persisted_model_override: Optional[Dict[str, Any]],
) -> Tuple[Optional[Dict[str, str]], Dict[str, Any], Optional[Dict[str, Any]]]:
    """Snapshot the source session's effective runtime for a child copy."""
    model_config = _stored_model_config(session)
    gateway_runtime = model_config.get("gateway_runtime")
    if not isinstance(gateway_runtime, dict):
        gateway_runtime = {}
    session_key = str(session.get("session_key") or "").strip()
    rehydrate = getattr(gateway_runner, "_rehydrate_session_model_override", None)
    if session_key and callable(rehydrate):
        rehydrate(session_key)
    live_model_overrides = getattr(gateway_runner, "_session_model_overrides", {}) or {}
    model_override = live_model_overrides.get(session_key) or persisted_model_override or {}

    model = str(
        model_override.get("model")
        or session.get("model")
        or model_config.get("model")
        or ""
    ).strip()
    provider = str(
        model_override.get("provider")
        or model_config.get("provider")
        or gateway_runtime.get("provider")
        or ""
    ).strip()
    if not provider:
        try:
            from gateway.run import _load_gateway_config

            configured_model = (_load_gateway_config() or {}).get("model", {})
            if isinstance(configured_model, dict):
                provider = str(
                    configured_model.get("provider") or "openrouter"
                ).strip()
        except Exception:
            logger.debug("[t3agent] unable to resolve the stored model provider", exc_info=True)

    reasoning_overrides = getattr(gateway_runner, "_session_reasoning_overrides", {}) or {}
    reasoning_config = reasoning_overrides.get(session_key)
    if not isinstance(reasoning_config, dict):
        reasoning_config = model_config.get("reasoning_config")
    if not isinstance(reasoning_config, dict):
        resolve_reasoning = getattr(
            gateway_runner, "_resolve_session_reasoning_config", None
        )
        if callable(resolve_reasoning):
            reasoning_config = resolve_reasoning(
                session_key=session_key or None,
                model=model,
            )
    reasoning_effort = _reasoning_effort_from_config(reasoning_config)
    selection = (
        {
            "provider": provider,
            "model": model,
            **(
                {"reasoningEffort": reasoning_effort}
                if reasoning_effort is not None
                else {}
            ),
        }
        if provider and model
        else None
    )
    return selection, model_config, reasoning_config if isinstance(reasoning_config, dict) else None


def _image_source_value(attachment: Dict[str, Any]) -> str:
    if attachment.get("type") != "image":
        raise ValueError("each images entry must have type image")
    _require_string(attachment, "id")
    _require_string(attachment, "name")
    mime_type = _require_string(attachment, "mimeType")
    if not mime_type.lower().startswith("image/"):
        raise ValueError("image mimeType must start with image/")
    source = attachment.get("source")
    if not isinstance(source, dict):
        raise ValueError("image source must be an object")
    source_type = source.get("type")
    key = {"local-path": "path", "url": "url", "data-url": "dataUrl"}.get(source_type)
    if key is None:
        raise ValueError("image source type must be local-path, url, or data-url")
    source_value = _require_string(source, key)
    if source_type != "data-url":
        return source_value

    try:
        header, encoded = source_value.split(",", 1)
        if not header.lower().startswith("data:image/"):
            raise ValueError("data-url image must use an image media type")
        if ";base64" in header.lower():
            data = base64.b64decode(encoded, validate=True)
        else:
            data = unquote_to_bytes(encoded)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("image dataUrl is invalid") from exc
    cached = cache_media_bytes(
        data,
        filename=str(attachment["name"]),
        mime_type=mime_type,
        default_kind="image",
    )
    if cached is None:
        raise ValueError("image dataUrl did not contain a supported image")
    return cached.path


def _local_image_attachment(path_value: str) -> Dict[str, Any]:
    path = Path(path_value)
    mime_type = mimetypes.guess_type(path.name)[0] or ""
    if not mime_type.startswith("image/"):
        raise ValueError(f"T3 Agent only supports image attachments: {path.name}")
    try:
        stat = path.stat()
        if not path.is_file() or stat.st_size <= 0 or stat.st_size > MAX_IMAGE_BYTES:
            raise ValueError(
                f"Image attachment must be a regular file between 1 byte and {MAX_IMAGE_BYTES} bytes"
            )
        data = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"Unable to read image attachment: {path.name}") from exc
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError(f"Image attachment must be between 1 byte and {MAX_IMAGE_BYTES} bytes")
    attachment: Dict[str, Any] = {
        "type": "image",
        "id": _canonical_id("image", {"path": str(path), "sha256": hashlib.sha256(data).hexdigest()}),
        "name": path.name or "image",
        "mimeType": mime_type,
        "sizeBytes": len(data),
        "source": {
            "type": "data-url",
            "dataUrl": f"data:{mime_type};base64,{base64.b64encode(data).decode('ascii')}",
        },
    }
    return attachment


def _choice(value: Any, index: int) -> Dict[str, Any]:
    if isinstance(value, dict):
        choice_id = str(value.get("id") or value.get("value") or index).strip()
        label = str(value.get("label") or value.get("text") or choice_id).strip()
        result: Dict[str, Any] = {"id": choice_id, "label": label}
        description = value.get("description")
        if description is not None and str(description).strip():
            result["description"] = str(description)
        return result
    label = str(value).strip()
    return {"id": label or str(index), "label": label or str(index)}


def _command_catalog() -> List[Dict[str, Any]]:
    """Read Hermes' canonical gateway command registry, including plugins."""
    try:
        from hermes_cli.commands import (
            COMMAND_REGISTRY,
            _is_gateway_available,
            _iter_plugin_command_entries,
            _resolve_config_gates,
        )

        overrides = _resolve_config_gates()
        commands: List[Dict[str, Any]] = []
        for command in COMMAND_REGISTRY:
            if not _is_gateway_available(command, overrides):
                continue
            entry: Dict[str, Any] = {
                "name": command.name,
                "description": command.description,
            }
            if command.args_hint:
                entry["inputHint"] = command.args_hint
            if command.aliases:
                entry["aliases"] = list(command.aliases)
            commands.append(entry)
        known = {entry["name"] for entry in commands}
        for name, description, args_hint in _iter_plugin_command_entries():
            if name in known:
                continue
            entry = {"name": name, "description": description}
            if args_hint:
                entry["inputHint"] = args_hint
            commands.append(entry)
        try:
            from agent.skill_commands import get_skill_commands

            for name, skill in sorted(get_skill_commands().items()):
                normalized_name = str(name).lstrip("/")
                if not normalized_name or normalized_name in known:
                    continue
                description = str(skill.get("description") or "Run this Hermes skill")
                commands.append({"name": normalized_name, "description": description})
                known.add(normalized_name)
        except Exception:
            logger.debug("[t3agent] could not read Hermes skill commands", exc_info=True)
        return commands
    except Exception:
        logger.debug("[t3agent] could not read Hermes command registry", exc_info=True)
        return [
            {"name": "new", "description": "Start a new Hermes conversation"},
            {"name": "stop", "description": "Interrupt the active Hermes turn"},
            {"name": "model", "description": "Show or change the conversation model"},
            {"name": "restart", "description": "Restart the Hermes gateway"},
            {"name": "help", "description": "Show Hermes gateway commands"},
        ]


def _runtime_identity() -> Dict[str, str]:
    """Best-effort snapshot of the default Hermes provider/model/profile."""
    identity: Dict[str, str] = {}
    try:
        from hermes_cli.inventory import load_picker_context

        context = load_picker_context()
        if context.current_provider:
            identity["provider"] = str(context.current_provider)
        if context.current_model:
            identity["model"] = str(context.current_model)
    except Exception:
        logger.debug("[t3agent] could not read Hermes model identity", exc_info=True)
    try:
        from hermes_cli.profiles import get_active_profile_name

        profile = get_active_profile_name()
        if profile:
            identity["profile"] = str(profile)
    except Exception:
        logger.debug("[t3agent] could not read Hermes profile identity", exc_info=True)
    return identity


def _model_inventory() -> List[Dict[str, Any]]:
    """Return Hermes' authenticated model catalog with picker capabilities."""
    try:
        from hermes_cli.inventory import build_models_payload, load_picker_context

        payload = build_models_payload(
            load_picker_context(),
            explicit_only=True,
            picker_hints=True,
            canonical_order=True,
            capabilities=True,
            probe_custom_providers=False,
            probe_current_custom_provider=False,
            max_models=None,
        )
        current = _runtime_identity()
        result: List[Dict[str, Any]] = []
        for provider in payload.get("providers", []):
            provider_slug = str(provider.get("slug") or "").strip()
            if not provider_slug or provider.get("authenticated") is False:
                continue
            capabilities = provider.get("capabilities") or {}
            for raw_model in provider.get("models") or []:
                if isinstance(raw_model, dict):
                    model_slug = str(raw_model.get("slug") or raw_model.get("id") or "").strip()
                    model_name = str(raw_model.get("name") or model_slug).strip()
                else:
                    model_slug = str(raw_model).strip()
                    model_name = model_slug
                if not model_slug:
                    continue
                model_capabilities = capabilities.get(model_slug) or {}
                reasoning = model_capabilities.get("reasoning")
                entry: Dict[str, Any] = {
                    "provider": provider_slug,
                    "slug": model_slug,
                    "name": model_name,
                    "isDefault": (
                        provider_slug == current.get("provider")
                        and model_slug == current.get("model")
                    ),
                }
                if reasoning is True:
                    from hermes_constants import VALID_REASONING_EFFORTS

                    normalized_reasoning = ["none", *VALID_REASONING_EFFORTS]
                elif isinstance(reasoning, list):
                    normalized_reasoning = [
                        str(level).strip() for level in reasoning if str(level).strip()
                    ]
                else:
                    normalized_reasoning = []
                if normalized_reasoning:
                    entry["reasoningEfforts"] = normalized_reasoning
                default_reasoning = (
                    model_capabilities.get("default_reasoning")
                    or _current_reasoning_effort(model_slug)
                )
                if default_reasoning:
                    entry["defaultReasoningEffort"] = str(default_reasoning)
                result.append(entry)
        return result
    except Exception:
        logger.debug("[t3agent] could not read Hermes model inventory", exc_info=True)
        return []


def _current_reasoning_effort(model: str = "") -> Optional[str]:
    try:
        from hermes_cli.config import load_config_readonly
        from hermes_constants import resolve_reasoning_config

        config = resolve_reasoning_config(load_config_readonly(), model)
        if config is None:
            return "medium"
        if config.get("enabled") is False:
            return "none"
        value = config.get("effort")
        return str(value).strip() if value else "medium"
    except Exception:
        return None


def _iso_timestamp(value: Any) -> str:
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
    except (TypeError, ValueError, OSError):
        return datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z")


class T3AgentAdapter(BasePlatformAdapter):
    """Bridge a local T3 Agent server into Hermes as platform ``t3agent``."""

    supports_async_delivery = True
    supports_code_blocks = True

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("t3agent"))
        self.instance_id = str(_env_or_extra(config, _INSTANCE_ID_ENV, "instance_id", "")).strip()
        self.ingress_token = str(_env_or_extra(config, _INGRESS_TOKEN_ENV, "ingress_token", ""))
        self.bridge_token = str(_env_or_extra(config, _BRIDGE_TOKEN_ENV, "bridge_token", ""))
        self.bridge_url = str(_env_or_extra(config, _BRIDGE_URL_ENV, "bridge_url", "")).rstrip("/")
        self.ingress_host = str(
            _env_or_extra(config, "T3_AGENT_INGRESS_HOST", "ingress_host", DEFAULT_HOST)
        ).strip()
        self.ingress_port = _positive_int(
            _env_or_extra(config, "T3_AGENT_INGRESS_PORT", "ingress_port", DEFAULT_PORT),
            DEFAULT_PORT,
        )
        self.max_body_bytes = _positive_int(
            _env_or_extra(
                config, "T3_AGENT_MAX_BODY_BYTES", "max_body_bytes", DEFAULT_MAX_BODY_BYTES
            ),
            DEFAULT_MAX_BODY_BYTES,
        )
        self.timeout_seconds = _positive_float(
            _env_or_extra(
                config,
                "T3_AGENT_BRIDGE_TIMEOUT_SECONDS",
                "bridge_timeout_seconds",
                DEFAULT_TIMEOUT_SECONDS,
            ),
            DEFAULT_TIMEOUT_SECONDS,
        )
        self._runner: Optional[web.AppRunner] = None if AIOHTTP_AVAILABLE else None
        self._site: Optional[web.TCPSite] = None if AIOHTTP_AVAILABLE else None
        self._client: Optional[ClientSession] = None
        self._bound_port: Optional[int] = None
        self._idempotency_lock = asyncio.Lock()
        self._completed_requests: "OrderedDict[str, Tuple[int, Dict[str, Any], str]]" = (
            OrderedDict()
        )
        configured_ledger = str(
            _env_or_extra(config, _INGRESS_LEDGER_PATH_ENV, "ingress_ledger_path", "")
        ).strip()
        if configured_ledger == ":memory:":
            self._ingress_ledger_path: Optional[Path] = None
        elif configured_ledger:
            self._ingress_ledger_path = Path(configured_ledger)
        else:
            instance_hash = hashlib.sha256(self.instance_id.encode("utf-8")).hexdigest()[:16]
            self._ingress_ledger_path = (
                get_hermes_dir("state", "state") / f"t3agent-ingress-{instance_hash}.json"
            )
        self._load_ingress_ledger()
        self._message_destinations: Dict[str, Dict[str, str]] = {}
        self._processing_sources: Dict[Tuple[str, str], str] = {}
        configured_outbox = str(
            _env_or_extra(config, _OUTBOX_PATH_ENV, "outbox_path", "")
        ).strip()
        if configured_outbox == ":memory:":
            self._completion_outbox_path: Optional[Path] = None
        elif configured_outbox:
            self._completion_outbox_path = Path(configured_outbox)
        else:
            instance_hash = hashlib.sha256(self.instance_id.encode("utf-8")).hexdigest()[:16]
            self._completion_outbox_path = (
                get_hermes_dir("state", "state") / f"t3agent-completions-{instance_hash}.json"
            )
        self._completion_outbox: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._completion_outbox_lock = asyncio.Lock()
        self._completion_outbox_wakeup = asyncio.Event()
        self._completion_outbox_task: Optional[asyncio.Task] = None
        self._completion_outbox_stopping = False

    @staticmethod
    def _destination_key(
        chat_id: str, metadata: Optional[Dict[str, Any]] = None
    ) -> Tuple[str, str]:
        thread_id = _metadata_value(metadata, "threadId", "thread_id") or ""
        return str(chat_id), thread_id

    def _source_message_id(
        self,
        chat_id: str,
        metadata: Optional[Dict[str, Any]] = None,
        reply_to: Optional[str] = None,
    ) -> Optional[str]:
        explicit = _metadata_value(
            metadata,
            "sourceMessageId",
            "source_message_id",
            "reply_to_message_id",
        )
        if explicit:
            return explicit
        # Busy-session bypass commands are handled inline while the original
        # turn is still processing. Their reply anchor is therefore more
        # specific than the destination-wide processing source.
        if reply_to and str(reply_to).startswith("hermes-user:"):
            return str(reply_to)
        current = self._processing_sources.get(self._destination_key(chat_id, metadata))
        if current:
            return current
        return None

    async def on_processing_start(self, event: MessageEvent) -> None:
        metadata = {"thread_id": getattr(event.source, "thread_id", None)}
        self._processing_sources[self._destination_key(event.source.chat_id, metadata)] = str(
            event.message_id
        )

    async def handle_message(self, event: MessageEvent) -> None:
        """Complete Hermes' inline busy-session commands as real T3 turns."""
        if not self._message_handler:
            return
        session_key = build_session_key(
            event.source,
            group_sessions_per_user=self.config.extra.get("group_sessions_per_user", True),
            thread_sessions_per_user=self.config.extra.get("thread_sessions_per_user", False),
        )
        command = event.get_command()
        from hermes_cli.commands import should_bypass_active_session

        if session_key not in self._active_sessions or not should_bypass_active_session(command):
            await super().handle_message(event)
            return

        outcome = ProcessingOutcome.SUCCESS
        try:
            if command in {"stop", "new", "reset"}:
                self._discard_text_debounce(session_key)
                await self._dispatch_active_session_command(event, session_key, command)
            else:
                response = await self._message_handler(event)
                text, ephemeral_ttl = self._unwrap_ephemeral(response)
                if text:
                    metadata = {
                        "thread_id": getattr(event.source, "thread_id", None),
                        "notify": True,
                    }
                    result = await self._send_with_retry(
                        chat_id=event.source.chat_id,
                        content=text,
                        reply_to=str(event.message_id),
                        metadata=metadata,
                    )
                    if result is not None and not getattr(result, "success", False):
                        outcome = ProcessingOutcome.FAILURE
                    if (
                        ephemeral_ttl > 0
                        and result is not None
                        and getattr(result, "success", False)
                        and getattr(result, "message_id", None)
                    ):
                        self._schedule_ephemeral_delete(
                            chat_id=event.source.chat_id,
                            message_id=result.message_id,
                            ttl_seconds=ephemeral_ttl,
                        )
        except Exception:
            logger.exception(
                "[t3agent] busy command '/%s' dispatch failed",
                command or "",
            )
            outcome = ProcessingOutcome.FAILURE
        await self.on_processing_complete(event, outcome)

    def _load_completion_outbox(self) -> None:
        path = self._completion_outbox_path
        if path is None or not path.exists():
            return
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            logger.warning("[t3agent] could not load completion outbox", exc_info=True)
            return
        if not isinstance(payload, list):
            return
        for fields in payload:
            if not isinstance(fields, dict):
                continue
            if (
                isinstance(fields.get("chatId"), str)
                and isinstance(fields.get("sourceMessageId"), str)
                and fields.get("outcome") in {"success", "failure", "cancelled"}
            ):
                key = _canonical_id("completion", fields)
                self._completion_outbox[key] = dict(fields)

    def _load_ingress_ledger(self) -> None:
        path = self._ingress_ledger_path
        if path is None or not path.exists():
            return
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            logger.warning("[t3agent] could not load ingress ledger", exc_info=True)
            return
        if not isinstance(payload, list):
            return
        for record in payload[-DEFAULT_IDEMPOTENCY_CACHE_SIZE:]:
            if not isinstance(record, dict):
                continue
            request_id = record.get("requestId")
            status = record.get("statusCode")
            body = record.get("body")
            state = record.get("state", "completed")
            if isinstance(request_id, str) and isinstance(status, int) and isinstance(body, dict):
                if state in {"pending", "completed", "failed"}:
                    self._completed_requests[request_id] = (status, dict(body), state)

    def _persist_ingress_ledger(self) -> None:
        path = self._ingress_ledger_path
        if path is None:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.tmp")
        records = [
            {
                "requestId": request_id,
                "statusCode": status,
                "body": body,
                "state": state,
            }
            for request_id, (status, body, state) in self._completed_requests.items()
        ]
        temporary.write_text(json.dumps(records, separators=(",", ":")), encoding="utf-8")
        temporary.chmod(0o600)
        temporary.replace(path)

    def _persist_completion_outbox(self) -> None:
        path = self._completion_outbox_path
        if path is None:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.tmp")
        temporary.write_text(
            json.dumps(list(self._completion_outbox.values()), separators=(",", ":")),
            encoding="utf-8",
        )
        temporary.chmod(0o600)
        temporary.replace(path)

    def _ensure_completion_outbox_task(self) -> None:
        if self._client is None or self._completion_outbox_stopping:
            return
        if self._completion_outbox_task is None or self._completion_outbox_task.done():
            self._completion_outbox_task = asyncio.create_task(self._completion_outbox_loop())

    async def _enqueue_turn_completion(self, fields: Dict[str, Any]) -> None:
        key = _canonical_id("completion", fields)
        persist_error: Optional[OSError] = None
        try:
            async with self._completion_outbox_lock:
                self._completion_outbox[key] = dict(fields)
                self._persist_completion_outbox()
        except OSError as exc:
            persist_error = exc
        finally:
            # Even with degraded disk durability, keep the live delivery path
            # running so a completed turn is not stranded in memory.
            self._completion_outbox_wakeup.set()
            self._ensure_completion_outbox_task()
        if persist_error is not None:
            raise persist_error

    async def _completion_outbox_loop(self) -> None:
        backoff_seconds = 0.5
        while not self._completion_outbox_stopping:
            async with self._completion_outbox_lock:
                next_item = next(iter(self._completion_outbox.items()), None)
            if next_item is None:
                self._completion_outbox_wakeup.clear()
                await self._completion_outbox_wakeup.wait()
                continue
            key, fields = next_item
            ok, _, error = await self._post_event("turn.complete", fields)
            if ok:
                persisted = True
                async with self._completion_outbox_lock:
                    if self._completion_outbox.get(key) == fields:
                        self._completion_outbox.pop(key, None)
                        try:
                            self._persist_completion_outbox()
                        except OSError:
                            # Keep retrying the same idempotent delivery until
                            # its durable removal can also be recorded.
                            self._completion_outbox[key] = fields
                            persisted = False
                            logger.warning(
                                "[t3agent] could not persist completion delivery",
                                exc_info=True,
                            )
                if not persisted:
                    await asyncio.sleep(backoff_seconds)
                    backoff_seconds = min(backoff_seconds * 2, 30.0)
                    continue
                backoff_seconds = 0.5
                continue
            logger.debug(
                "[t3agent] completion outbox retry in %.1fs: %s",
                backoff_seconds,
                error or "unknown error",
            )
            self._completion_outbox_wakeup.clear()
            try:
                await asyncio.wait_for(
                    self._completion_outbox_wakeup.wait(), timeout=backoff_seconds
                )
            except asyncio.TimeoutError:
                pass
            backoff_seconds = min(backoff_seconds * 2, 30.0)

    @property
    def authorization_is_upstream(self) -> bool:
        # The T3 server is trusted only after constant-time bearer validation on
        # a loopback transport. User IDs are assertions by that trusted server.
        return True

    @property
    def bound_port(self) -> Optional[int]:
        return self._bound_port

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not AIOHTTP_AVAILABLE:
            logger.error("[t3agent] aiohttp is required")
            return False
        if not validate_config(self.config):
            logger.error("[t3agent] configuration is incomplete or unsafe")
            return False

        app = web.Application(client_max_size=self.max_body_bytes)
        app.router.add_get("/v1/health", self._health)
        app.router.add_get("/v1/capabilities", self._capabilities)
        app.router.add_get("/v1/sessions", self._list_sessions)
        app.router.add_post("/v1/sessions/fork", self._fork_session)
        app.router.add_post("/v1/sessions/delete", self._delete_session)
        app.router.add_post("/v1/messages", self._submit_message)
        app.router.add_post("/v1/interrupt", self._interrupt_turn)
        app.router.add_post("/v1/approvals", self._respond_approval)
        app.router.add_post("/v1/clarifications", self._respond_clarification)
        app.router.add_post("/v1/slash-confirmations", self._respond_slash_confirmation)

        self._client = ClientSession(timeout=ClientTimeout(total=self.timeout_seconds))
        self._runner = web.AppRunner(app, access_log=None)
        try:
            await self._runner.setup()
            self._site = web.TCPSite(self._runner, self.ingress_host, self.ingress_port)
            await self._site.start()
            server = getattr(self._site, "_server", None)
            sockets = getattr(server, "sockets", None) or []
            self._bound_port = int(sockets[0].getsockname()[1]) if sockets else self.ingress_port
        except Exception:
            logger.exception("[t3agent] failed to start loopback ingress")
            await self.disconnect()
            return False

        self._mark_connected()
        self._completion_outbox_stopping = False
        self._load_completion_outbox()
        if self._completion_outbox:
            self._completion_outbox_wakeup.set()
            self._ensure_completion_outbox_task()
        logger.info("[t3agent] ingress listening on %s:%s", self.ingress_host, self._bound_port)
        return True

    async def disconnect(self) -> None:
        self._completion_outbox_stopping = True
        self._completion_outbox_wakeup.set()
        if self._completion_outbox_task is not None:
            self._completion_outbox_task.cancel()
            try:
                await self._completion_outbox_task
            except asyncio.CancelledError:
                pass
            self._completion_outbox_task = None
        if self._runner is not None:
            try:
                await self._runner.cleanup()
            finally:
                self._runner = None
                self._site = None
                self._bound_port = None
        if self._client is not None:
            await self._client.close()
            self._client = None
        self._mark_disconnected()

    def _authorized(self, request: web.Request) -> bool:
        supplied = request.headers.get("Authorization", "")
        prefix = "Bearer "
        if not supplied.startswith(prefix):
            return False
        return hmac.compare_digest(
            supplied[len(prefix) :].encode("utf-8"), self.ingress_token.encode("utf-8")
        )

    def _unauthorized(self) -> web.Response:
        return web.json_response({"error": "unauthorized"}, status=401)

    def _discovery_identity(
        self, request: web.Request
    ) -> Tuple[Optional[str], Optional[web.Response]]:
        if request.query.get("protocolVersion") != str(PROTOCOL_VERSION):
            return None, web.json_response(
                {"error": f"protocolVersion must be {PROTOCOL_VERSION}"}, status=400
            )
        request_id = request.query.get("requestId", "").strip()
        if not request_id:
            return None, web.json_response({"error": "requestId is required"}, status=400)
        return request_id, None

    async def _read_frame(self, request: web.Request, expected_type: str) -> Dict[str, Any]:
        try:
            payload = await request.json()
        except Exception as exc:
            raise ValueError("request body must be a JSON object") from exc
        if not isinstance(payload, dict):
            raise ValueError("request body must be a JSON object")
        if payload.get("protocolVersion") != PROTOCOL_VERSION:
            raise ValueError(f"protocolVersion must be {PROTOCOL_VERSION}")
        if payload.get("type") != expected_type:
            raise ValueError(f"type must be {expected_type}")
        _require_string(payload, "requestId")
        return payload

    async def _run_once(
        self,
        request_id: str,
        operation: Callable[[], Awaitable[Tuple[int, Dict[str, Any]]]],
        *,
        accepted_status: int = 200,
    ) -> web.Response:
        # Holding this lock across the short dispatch/resolver call also closes
        # the race where two identical requests arrive before either is cached.
        async with self._idempotency_lock:
            cached = self._completed_requests.get(request_id)
            if cached is not None:
                self._completed_requests.move_to_end(request_id)
                # A prior write may have failed while the process remained
                # alive. Never acknowledge a duplicate until the ledger is
                # durably synchronized.
                self._persist_ingress_ledger()
                if cached[2] == "pending":
                    failure = {
                        "protocolVersion": PROTOCOL_VERSION,
                        "requestId": request_id,
                        "error": (
                            "Hermes restarted or failed after durably claiming this request; "
                            "execution cannot be replayed safely."
                        ),
                    }
                    self._completed_requests[request_id] = (409, failure, "failed")
                    self._persist_ingress_ledger()
                    return web.json_response(failure, status=409)
                if cached[2] == "failed":
                    return web.json_response(cached[1], status=cached[0])
                duplicate = dict(cached[1])
                duplicate["status"] = "duplicate"
                return web.json_response(duplicate, status=cached[0])
            # Write the idempotency claim before dispatch. If Hermes exits at
            # any later point, a replay is suppressed rather than risking the
            # same agent/tool side effects twice. Validation has already run,
            # so this is the narrow durable inbox boundary.
            pending_body = _ack(request_id, "accepted")
            self._completed_requests[request_id] = (
                accepted_status,
                pending_body,
                "pending",
            )
            try:
                self._persist_ingress_ledger()
            except OSError:
                self._completed_requests.pop(request_id, None)
                raise
            try:
                status, body = await operation()
            except Exception:
                failure = {
                    "protocolVersion": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "error": "Hermes failed while executing the durably claimed request.",
                }
                self._completed_requests[request_id] = (500, failure, "failed")
                self._persist_ingress_ledger()
                raise
            self._completed_requests[request_id] = (status, body, "completed")
            self._completed_requests.move_to_end(request_id)
            while len(self._completed_requests) > DEFAULT_IDEMPOTENCY_CACHE_SIZE:
                self._completed_requests.popitem(last=False)
            # Persist before returning the acknowledgement so a T3 retry after
            # a Hermes restart cannot execute an already-completed operation.
            self._persist_ingress_ledger()
            return web.json_response(body, status=status)

    async def _health(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        request_id, error = self._discovery_identity(request)
        if error is not None:
            return error
        return web.json_response(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": request_id,
                "status": "healthy",
                "instanceId": self.instance_id,
            }
        )

    async def _capabilities(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        request_id, error = self._discovery_identity(request)
        if error is not None:
            return error
        return web.json_response(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": request_id,
                "capabilities": {
                    "asynchronousDelivery": True,
                    "imageAttachments": True,
                    "interrupts": True,
                    "approvals": True,
                    "clarifications": True,
                    "slashConfirmations": True,
                    "threadCreation": True,
                    "commandCatalog": True,
                },
                "commands": _command_catalog(),
                "models": _model_inventory(),
                **(
                    {"reasoningEffort": _current_reasoning_effort()}
                    if _current_reasoning_effort()
                    else {}
                ),
                **_runtime_identity(),
            }
        )

    async def _list_sessions(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        request_id, error = self._discovery_identity(request)
        if error is not None:
            return error
        gateway_runner = getattr(self, "gateway_runner", None)
        _, _, db = _gateway_session_resources(gateway_runner)
        if db is None:
            return web.json_response(
                {"error": "Hermes session database is unavailable"}, status=503
            )

        try:
            rows = await asyncio.to_thread(
                db.list_sessions_rich,
                exclude_sources=["tool", "subagent"],
                limit=200,
                include_children=True,
                min_message_count=1,
                order_by_last_active=True,
            )
        except Exception:
            logger.exception("[t3agent] failed to list Hermes sessions")
            return web.json_response({"error": "Unable to list Hermes sessions"}, status=500)

        imported_threads_by_parent: Dict[str, List[str]] = {}
        for row in rows:
            if str(row.get("source") or "") != "t3agent":
                continue
            parent_id = str(row.get("parent_session_id") or "").strip()
            thread_id = str(row.get("thread_id") or "").strip()
            if parent_id and thread_id:
                imported_threads_by_parent.setdefault(parent_id, []).append(thread_id)

        sessions: List[Dict[str, Any]] = []
        for row in rows:
            session_id = str(row.get("id") or "").strip()
            source = str(row.get("source") or "unknown").strip() or "unknown"
            if not session_id:
                continue
            item: Dict[str, Any] = {
                "sessionId": session_id,
                "source": source,
                "startedAt": _iso_timestamp(row.get("started_at")),
                "messageCount": max(0, int(row.get("message_count") or 0)),
            }
            for source_key, target_key in (
                ("title", "title"),
                ("model", "model"),
                ("parent_session_id", "parentSessionId"),
            ):
                value = str(row.get(source_key) or "").strip()
                if value:
                    item[target_key] = value
            thread_id = str(row.get("thread_id") or "").strip()
            if source == "t3agent" and thread_id:
                item["threadId"] = thread_id
            if row.get("ended_at") is not None:
                item["endedAt"] = _iso_timestamp(row.get("ended_at"))
            imported_thread_ids = imported_threads_by_parent.get(session_id, [])
            if imported_thread_ids:
                item["importedThreadIds"] = imported_thread_ids
            sessions.append(item)
        return web.json_response(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": request_id,
                "sessions": sessions,
            }
        )

    async def _fork_session(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        try:
            payload = await self._read_frame(request, "session.fork")
            request_id = _require_string(payload, "requestId")
            source_session_id = _require_string(payload, "sourceSessionId")
            child_session_id = _require_string(payload, "childSessionId")
            target_thread_id = _require_string(payload, "targetThreadId")
            raw_turn_count = payload.get("userTurnCount")
            if raw_turn_count is not None and (
                not isinstance(raw_turn_count, int) or raw_turn_count < 0
            ):
                raise ValueError("userTurnCount must be a non-negative integer")
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        async def fork_once() -> Tuple[int, Dict[str, Any]]:
            gateway_runner = getattr(self, "gateway_runner", None)
            session_db, async_store, db = _gateway_session_resources(gateway_runner)
            if session_db is None or async_store is None or db is None:
                raise RuntimeError("Hermes session database is unavailable")
            source_session = await asyncio.to_thread(db.get_session, source_session_id)
            if not source_session:
                return 404, {
                    "protocolVersion": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "error": f"Hermes session not found: {source_session_id}",
                }
            source_session_key = str(source_session.get("session_key") or "").strip()
            persisted_model_override = (
                await async_store.get_model_override(source_session_key)
                if source_session_key
                else None
            )
            model_selection, child_model_config, reasoning_config = (
                _session_runtime_selection(
                    gateway_runner,
                    source_session,
                    persisted_model_override,
                )
            )
            existing_child = await asyncio.to_thread(db.get_session, child_session_id)
            if existing_child is not None:
                existing_config = _stored_model_config(existing_child)
                existing_target = str(
                    existing_child.get("thread_id")
                    or existing_config.get("_t3agent_target_thread")
                    or ""
                ).strip()
                if (
                    str(existing_child.get("source") or "") != "t3agent"
                    or str(existing_child.get("parent_session_id") or "")
                    != source_session_id
                    or existing_target != target_thread_id
                ):
                    return 409, {
                        "protocolVersion": PROTOCOL_VERSION,
                        "requestId": request_id,
                        "error": "The requested child Hermes session identity is already in use.",
                    }
            child_exists = existing_child is not None

            messages = await asyncio.to_thread(db.get_messages, source_session_id)
            copied_messages: List[Dict[str, Any]] = []
            user_turns = 0
            for message in messages:
                role = str(message.get("role") or "")
                if role == "user" and not _is_synthetic_history_user(
                    message.get("content")
                ):
                    user_turns += 1
                    if raw_turn_count is not None and user_turns > raw_turn_count:
                        break
                copied_messages.append(message)

            source_title = (
                str(source_session.get("title") or "Conversation").strip()
                or "Conversation"
            )
            child_title = (
                str(existing_child.get("title") or "").strip()
                if existing_child is not None
                else ""
            )
            if not child_title:
                child_title = await asyncio.to_thread(
                    db.get_next_title_in_lineage,
                    source_title,
                )
            child_model_config["_t3agent_imported_from"] = source_session_id
            child_model_config["_t3agent_target_thread"] = target_thread_id
            if not child_exists:
                await session_db.create_session(
                    session_id=child_session_id,
                    source="t3agent",
                    model=(
                        model_selection.get("model")
                        if model_selection is not None
                        else source_session.get("model")
                    ),
                    model_config=child_model_config,
                    system_prompt=source_session.get("system_prompt"),
                    parent_session_id=source_session_id,
                )
                await asyncio.to_thread(
                    db.replace_messages,
                    child_session_id,
                    copied_messages,
                )
                await session_db.set_session_title(child_session_id, child_title)

            target_source = self.build_source(
                chat_id=CANONICAL_CHAT_ID,
                chat_name=target_thread_id,
                chat_type="thread",
                user_id="owner",
                user_name="Owner",
                thread_id=target_thread_id,
            )
            target_session_key = build_session_key(
                target_source,
                group_sessions_per_user=self.config.extra.get(
                    "group_sessions_per_user", True
                ),
                thread_sessions_per_user=self.config.extra.get(
                    "thread_sessions_per_user", False
                ),
            )
            # A newly created T3 thread has not sent a gateway message yet, so
            # it has no routing entry for switch_session to replace. Establish
            # that route first; switch_session then records the child session's
            # T3 peer metadata (including thread_id) for future /sessions calls.
            await async_store.get_or_create_session(target_source)
            switched = await async_store.switch_session(
                target_session_key, child_session_id
            )
            if switched is None:
                raise RuntimeError("Unable to bind the child Hermes session")
            if model_selection is not None:
                child_override = {
                    "model": model_selection["model"],
                    "provider": model_selection["provider"],
                }
                await async_store.set_model_override(target_session_key, child_override)
                live_overrides = getattr(gateway_runner, "_session_model_overrides", None)
                if isinstance(live_overrides, dict):
                    live_overrides[target_session_key] = child_override
            if reasoning_config is not None:
                set_reasoning = getattr(
                    gateway_runner, "_set_session_reasoning_override", None
                )
                if callable(set_reasoning):
                    set_reasoning(target_session_key, reasoning_config)

            history: List[Dict[str, Any]] = []
            source = str(source_session.get("source") or "unknown")
            for message in copied_messages:
                role = str(message.get("role") or "")
                content = message.get("content")
                if role not in {"user", "assistant", "system"} or not isinstance(
                    content, str
                ):
                    continue
                if role == "assistant" and not content.strip():
                    continue
                if role == "user" and _is_synthetic_history_user(content):
                    continue
                history.append(
                    {
                        "role": role,
                        "content": (
                            _normalize_history_user_content(source, content)
                            if role == "user"
                            else content
                        ),
                        "createdAt": _iso_timestamp(message.get("timestamp")),
                    }
                )
            return 201, {
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": request_id,
                "sourceSessionId": source_session_id,
                "childSessionId": child_session_id,
                "targetThreadId": target_thread_id,
                "source": source,
                "title": child_title,
                "messages": history,
                **(
                    {"modelSelection": model_selection}
                    if model_selection is not None
                    else {}
                ),
            }

        async def fork() -> Tuple[int, Dict[str, Any]]:
            try:
                return await fork_once()
            except Exception:
                gateway_runner = getattr(self, "gateway_runner", None)
                _, _, db = _gateway_session_resources(gateway_runner)
                if db is not None:
                    child = await asyncio.to_thread(db.get_session, child_session_id)
                    if child is not None:
                        child_config = _stored_model_config(child)
                        child_target = str(
                            child.get("thread_id")
                            or child_config.get("_t3agent_target_thread")
                            or ""
                        ).strip()
                        if (
                            str(child.get("source") or "") == "t3agent"
                            and str(child.get("parent_session_id") or "")
                            == source_session_id
                            and child_target == target_thread_id
                        ):
                            await asyncio.to_thread(
                                db.delete_session,
                                child_session_id,
                            )
                raise

        return await self._run_once(request_id, fork, accepted_status=201)

    async def _delete_session(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        try:
            payload = await self._read_frame(request, "session.delete")
            request_id = _require_string(payload, "requestId")
            session_id = _require_string(payload, "sessionId")
            target_thread_id = _require_string(payload, "targetThreadId")
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        async def delete() -> Tuple[int, Dict[str, Any]]:
            gateway_runner = getattr(self, "gateway_runner", None)
            _, _, db = _gateway_session_resources(gateway_runner)
            if db is None:
                raise RuntimeError("Hermes session database is unavailable")
            session = await asyncio.to_thread(db.get_session, session_id)
            if not session:
                return 200, _ack(request_id, "accepted")
            source = str(session.get("source") or "").strip()
            thread_id = str(session.get("thread_id") or "").strip()
            stored_target_thread_id = str(
                _stored_model_config(session).get("_t3agent_target_thread") or ""
            ).strip()
            parent_session_id = str(session.get("parent_session_id") or "").strip()
            if (
                source != "t3agent"
                or target_thread_id not in {thread_id, stored_target_thread_id}
                or not parent_session_id
            ):
                return 409, _ack(
                    request_id,
                    "rejected",
                    "Only the matching child session created by T3 Agent can be deleted.",
                )
            await asyncio.to_thread(db.delete_session, session_id)
            return 200, _ack(request_id, "accepted")

        return await self._run_once(request_id, delete)

    async def _submit_message(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        try:
            payload = await self._read_frame(request, "message.submit")
            request_id = _require_string(payload, "requestId")
            message_id = _require_string(payload, "messageId")
            chat_id = _require_string(payload, "chatId")
            thread_id = _optional_string(payload, "threadId")
            content = _require_string(payload, "content", allow_empty=True)
            raw_model_selection = payload.get("modelSelection")
            if raw_model_selection is not None and not isinstance(
                raw_model_selection, dict
            ):
                raise ValueError("modelSelection must be an object")
            model = (
                _require_string(raw_model_selection, "model")
                if raw_model_selection is not None
                else None
            )
            model_provider = (
                _require_string(raw_model_selection, "provider")
                if raw_model_selection is not None
                else None
            )
            reasoning_effort = (
                _optional_string(raw_model_selection, "reasoningEffort")
                if raw_model_selection is not None
                else None
            )
            user = payload.get("user")
            if not isinstance(user, dict):
                raise ValueError("user must be an object")
            user_id = _require_string(user, "id")
            user_name = _require_string(user, "name")
            images = payload.get("images", [])
            if not isinstance(images, list) or not all(isinstance(item, dict) for item in images):
                raise ValueError("images must be an array of image attachments")
            media_urls = [_image_source_value(item) for item in images]
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        async def dispatch() -> Tuple[int, Dict[str, Any]]:
            source = self.build_source(
                chat_id=chat_id,
                chat_name=thread_id or chat_id,
                chat_type="thread" if thread_id else "dm",
                user_id=user_id,
                user_name=user_name,
                thread_id=thread_id,
                message_id=message_id,
            )
            event = MessageEvent(
                text=content,
                message_type=MessageType.TEXT,
                source=source,
                raw_message=payload,
                message_id=message_id,
                media_urls=media_urls,
                media_types=["image"] * len(images),
                metadata={
                    "requestId": request_id,
                    "threadId": thread_id,
                    "t3agent": True,
                },
            )
            session_key = build_session_key(
                source,
                group_sessions_per_user=self.config.extra.get(
                    "group_sessions_per_user", True
                ),
                thread_sessions_per_user=self.config.extra.get(
                    "thread_sessions_per_user", False
                ),
            )
            gateway_runner = getattr(self, "gateway_runner", None)
            if model is not None and model_provider is not None:
                if gateway_runner is None:
                    return 202, _ack(
                        request_id,
                        "rejected",
                        "Hermes model controls are unavailable. The message was not sent.",
                    )
                model_event = MessageEvent(
                    text=f"/model {model} --session --provider {model_provider}",
                    message_type=MessageType.TEXT,
                    source=source,
                    raw_message=payload,
                    message_id=f"{message_id}:model",
                    metadata={"t3agent": True},
                )
                model_error = await _apply_gateway_model_selection(
                    gateway_runner,
                    model_event,
                    session_key,
                    model,
                    model_provider,
                )
                if model_error is not None:
                    return 202, _ack(request_id, "rejected", model_error)
            if gateway_runner is not None and reasoning_effort is not None:
                _apply_gateway_reasoning_selection(
                    gateway_runner,
                    session_key,
                    source.platform,
                    reasoning_effort,
                )
            await self.handle_message(event)
            return 202, _ack(request_id, "accepted")

        return await self._run_once(request_id, dispatch, accepted_status=202)

    async def _interrupt_turn(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        try:
            payload = await self._read_frame(request, "turn.interrupt")
            request_id = _require_string(payload, "requestId")
            session_key = _optional_string(payload, "sessionKey")
            chat_id = _optional_string(payload, "chatId")
            thread_id = _optional_string(payload, "threadId")
            if session_key is None:
                if chat_id is None:
                    raise ValueError("sessionKey or chatId must be provided")
                source = self.build_source(
                    chat_id=chat_id,
                    chat_name=thread_id or chat_id,
                    chat_type="thread" if thread_id else "dm",
                    thread_id=thread_id,
                )
                session_key = build_session_key(
                    source,
                    group_sessions_per_user=self.config.extra.get(
                        "group_sessions_per_user", True
                    ),
                    thread_sessions_per_user=self.config.extra.get(
                        "thread_sessions_per_user", False
                    ),
                )
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        async def interrupt() -> Tuple[int, Dict[str, Any]]:
            await self.cancel_session_processing(session_key)
            return 200, _ack(request_id, "accepted")

        return await self._run_once(request_id, interrupt)

    async def _respond_approval(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        try:
            payload = await self._read_frame(request, "approval.respond")
            request_id = _require_string(payload, "requestId")
            session_key = _require_string(payload, "sessionKey")
            _require_string(payload, "approvalId")
            _require_string(payload, "providerRequestId")
            choice = _require_string(payload, "choice")
            if choice not in {"once", "session", "always", "deny"}:
                raise ValueError("choice must be once, session, always, or deny")
            reason = _optional_string(payload, "reason")
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        async def resolve() -> Tuple[int, Dict[str, Any]]:
            from tools.approval import resolve_gateway_approval

            count = resolve_gateway_approval(session_key, choice, reason=reason)
            return (
                (200, _ack(request_id, "accepted"))
                if count
                else (404, _ack(request_id, "rejected", "No pending approval matched"))
            )

        return await self._run_once(request_id, resolve)

    async def _respond_clarification(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        try:
            payload = await self._read_frame(request, "clarification.respond")
            request_id = _require_string(payload, "requestId")
            _require_string(payload, "sessionKey")
            clarify_id = _require_string(payload, "clarifyId")
            _require_string(payload, "providerRequestId")
            response_value = payload.get("response")
            if isinstance(response_value, str):
                response = response_value
            elif response_value is None:
                response = ""
            else:
                response = json.dumps(response_value, ensure_ascii=False, sort_keys=True)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        async def resolve() -> Tuple[int, Dict[str, Any]]:
            from tools.clarify_gateway import resolve_gateway_clarify

            found = resolve_gateway_clarify(clarify_id, response)
            return (
                (200, _ack(request_id, "accepted"))
                if found
                else (404, _ack(request_id, "rejected", "No pending clarification matched"))
            )

        return await self._run_once(request_id, resolve)

    async def _respond_slash_confirmation(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        try:
            payload = await self._read_frame(request, "slash-confirmation.respond")
            request_id = _require_string(payload, "requestId")
            session_key = _require_string(payload, "sessionKey")
            confirm_id = _require_string(payload, "confirmId")
            choice = _require_string(payload, "choice")
            if choice not in {"once", "always", "cancel"}:
                raise ValueError("choice must be once, always, or cancel")
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        async def resolve() -> Tuple[int, Dict[str, Any]]:
            from tools import slash_confirm

            result = await slash_confirm.resolve(session_key, confirm_id, choice)
            found = result is not None
            return (
                (200, _ack(request_id, "accepted"))
                if found
                else (
                    404,
                    _ack(request_id, "rejected", "No pending slash confirmation matched"),
                )
            )

        return await self._run_once(request_id, resolve)

    def _event_ids(
        self, event_type: str, fields: Dict[str, Any], metadata: Optional[Dict[str, Any]] = None
    ) -> Tuple[str, str]:
        delivery_id = _metadata_value(metadata, "deliveryId", "delivery_id", "obligation_id")
        if delivery_id is None:
            delivery_id = _canonical_id("delivery", {"type": event_type, **fields})
        request_id = _metadata_value(metadata, "requestId", "request_id")
        if request_id is None:
            request_id = _canonical_id(
                "request",
                {
                    "instanceId": self.instance_id,
                    "deliveryId": delivery_id,
                    "type": event_type,
                },
            )
        return request_id, delivery_id

    async def _post_event(
        self,
        event_type: str,
        fields: Dict[str, Any],
        *,
        metadata: Optional[Dict[str, Any]] = None,
        client: Optional[ClientSession] = None,
    ) -> Tuple[bool, Dict[str, Any], Optional[str]]:
        request_id, delivery_id = self._event_ids(event_type, fields, metadata)
        frame: Dict[str, Any] = {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "deliveryId": delivery_id,
            "type": event_type,
            **fields,
        }
        target = f"{self.bridge_url}/api/hermes/{quote(self.instance_id, safe='')}/events"
        headers = {
            "Authorization": f"Bearer {self.bridge_token}",
            "Content-Type": "application/json",
            "Idempotency-Key": request_id,
        }
        active_client = client or self._client
        if active_client is None:
            return False, {}, "T3 Agent bridge is not connected"
        try:
            async with active_client.post(target, json=frame, headers=headers) as response:
                if not 200 <= response.status < 300:
                    return False, {}, f"T3 Agent bridge returned HTTP {response.status}"
                try:
                    body = await response.json()
                except Exception:
                    return False, {}, "T3 Agent bridge returned invalid JSON"
        except asyncio.CancelledError:
            raise
        except (ClientError, asyncio.TimeoutError):
            return False, {}, "T3 Agent bridge request failed"
        if not isinstance(body, dict):
            return False, {}, "T3 Agent bridge returned invalid JSON"
        if body.get("protocolVersion") != PROTOCOL_VERSION:
            return False, body, "T3 Agent bridge returned a mismatched protocol version"
        if body.get("requestId") != request_id:
            return False, body, "T3 Agent bridge returned a mismatched request ID"
        if body.get("deliveryId") != delivery_id:
            return False, body, "T3 Agent bridge returned a mismatched delivery ID"
        status = body.get("status")
        if status is not None and status not in {"accepted", "duplicate"}:
            return False, body, "T3 Agent bridge rejected delivery"
        return True, body, None

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        message_id = _metadata_value(metadata, "messageId", "message_id") or _canonical_id(
            "message", {"chatId": chat_id, "replyTo": reply_to, "content": content}
        )
        send_metadata = metadata or {}
        turn_complete = bool(
            send_metadata.get("turn_complete", send_metadata.get("notify", False))
        )
        fields: Dict[str, Any] = {
            "chatId": str(chat_id),
            "messageId": message_id,
            "content": content,
            # ``final`` closes this individual message bubble. Hermes sends
            # commentary/tool progress without ``expect_edits``; those are
            # complete messages, but they do not complete the whole turn.
            "final": bool(
                send_metadata.get("final")
                if "final" in send_metadata
                else turn_complete or not send_metadata.get("expect_edits", False)
            ),
        }
        thread_id = _metadata_value(metadata, "threadId", "thread_id")
        if thread_id:
            fields["threadId"] = thread_id
        source_message_id = self._source_message_id(chat_id, metadata, reply_to)
        if source_message_id:
            fields["sourceMessageId"] = source_message_id
        self._message_destinations[message_id] = {
            "chatId": str(chat_id),
            **({"threadId": thread_id} if thread_id else {}),
            **({"sourceMessageId": source_message_id} if source_message_id else {}),
        }
        images = (metadata or {}).get("images")
        if isinstance(images, list) and images:
            fields["images"] = images
        ok, body, error = await self._post_event("message.send", fields, metadata=metadata)
        return SendResult(
            success=ok,
            message_id=str(body.get("messageId") or message_id) if ok else None,
            error=error,
            raw_response=body if ok else None,
            retryable=not ok,
        )

    async def send_image_file(
        self,
        chat_id: str,
        image_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> SendResult:
        """Deliver a Hermes-generated local image as an inline T3 attachment."""
        del kwargs
        try:
            attachment = _local_image_attachment(image_path)
        except ValueError as exc:
            return SendResult(success=False, error=str(exc), retryable=False)
        send_metadata = dict(metadata or {})
        send_metadata["images"] = [attachment]
        send_metadata["final"] = True
        send_metadata["turn_complete"] = True
        send_metadata.setdefault(
            "messageId",
            _canonical_id(
                "message",
                {
                    "chatId": chat_id,
                    "replyTo": reply_to,
                    "imageId": attachment["id"],
                },
            ),
        )
        return await self.send(
            chat_id=chat_id,
            content=caption or "",
            reply_to=reply_to,
            metadata=send_metadata,
        )

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Fetch a safe remote image through Hermes' SSRF-guarded cache."""
        suffix = Path(urlparse(image_url).path).suffix.lower()
        extension = suffix if suffix in {".png", ".jpg", ".jpeg", ".gif", ".webp"} else ".jpg"
        try:
            image_path = await cache_image_from_url(image_url, ext=extension)
        except Exception as exc:
            return SendResult(success=False, error=str(exc), retryable=False)
        return await self.send_image_file(
            chat_id=chat_id,
            image_path=image_path,
            caption=caption,
            reply_to=reply_to,
            metadata=metadata,
        )

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        destination = self._message_destinations.get(str(message_id), {})
        thread_id = _metadata_value(metadata, "threadId", "thread_id") or destination.get(
            "threadId"
        )
        source_message_id = (
            self._source_message_id(chat_id, metadata) or destination.get("sourceMessageId")
        )
        fields = {
            "chatId": str(chat_id),
            "messageId": str(message_id),
            "content": content,
            "final": bool(finalize),
        }
        if thread_id:
            fields["threadId"] = thread_id
        if source_message_id:
            fields["sourceMessageId"] = source_message_id
        ok, body, error = await self._post_event("message.edit", fields)
        return SendResult(
            success=ok,
            message_id=str(body.get("messageId") or message_id) if ok else None,
            error=error,
            raw_response=body if ok else None,
            retryable=not ok,
        )

    async def delete_message(self, chat_id: str, message_id: str) -> bool:
        ok, _, _ = await self._post_event(
            "message.delete", {"chatId": str(chat_id), "messageId": str(message_id)}
        )
        return ok

    async def send_typing(
        self, chat_id: str, metadata: Optional[Dict[str, Any]] = None
    ) -> None:
        fields: Dict[str, Any] = {"chatId": str(chat_id), "active": True}
        thread_id = _metadata_value(metadata, "threadId", "thread_id")
        if thread_id:
            fields["threadId"] = thread_id
        source_message_id = self._source_message_id(chat_id, metadata)
        if source_message_id:
            fields["sourceMessageId"] = source_message_id
        await self._post_event("typing.set", fields, metadata=metadata)

    async def on_processing_complete(self, event: MessageEvent, outcome: Any) -> None:
        """Signal the true end of a Hermes turn after all response delivery.

        Message ``finalize`` only closes a streaming bubble and is also used at
        tool/segment boundaries. BasePlatformAdapter invokes this lifecycle
        hook after the handler and every response/attachment send has finished,
        making it the authoritative turn-completion seam.
        """
        source = event.source
        outcome_value = getattr(outcome, "value", str(outcome)).lower()
        if outcome_value not in {"success", "failure", "cancelled"}:
            outcome_value = "failure"
        fields: Dict[str, Any] = {
            "chatId": str(source.chat_id),
            "sourceMessageId": str(event.message_id),
            "outcome": outcome_value,
        }
        thread_id = getattr(source, "thread_id", None)
        if thread_id:
            fields["threadId"] = str(thread_id)
        await self._enqueue_turn_completion(fields)
        processing_key = self._destination_key(
            source.chat_id, {"thread_id": thread_id}
        )
        if self._processing_sources.get(processing_key) == str(event.message_id):
            self._processing_sources.pop(processing_key, None)

    async def send_exec_approval(
        self,
        chat_id: str,
        command: str,
        session_key: str,
        description: str = "dangerous command",
        metadata: Optional[Dict[str, Any]] = None,
        allow_permanent: bool = True,
        smart_denied: bool = False,
    ) -> SendResult:
        approval_id = _metadata_value(metadata, "approvalId", "approval_id") or _canonical_id(
            "approval", {"sessionKey": session_key, "command": command, "description": description}
        )
        provider_request_id = _metadata_value(
            metadata, "providerRequestId", "provider_request_id"
        ) or approval_id
        choices: List[Dict[str, Any]] = [{"id": "once", "label": "Allow once"}]
        if not smart_denied:
            choices.append({"id": "session", "label": "Allow for this session"})
            if allow_permanent:
                choices.append({"id": "always", "label": "Always allow"})
        choices.append({"id": "deny", "label": "Deny"})
        fields: Dict[str, Any] = {
            "chatId": str(chat_id),
            "sessionKey": session_key,
            "approvalId": approval_id,
            "providerRequestId": provider_request_id,
            "title": "Command approval required",
            "message": f"{description}\n\n{command}",
            "choices": choices,
        }
        thread_id = _metadata_value(metadata, "threadId", "thread_id")
        if thread_id:
            fields["threadId"] = thread_id
        source_message_id = self._source_message_id(chat_id, metadata)
        if source_message_id:
            fields["sourceMessageId"] = source_message_id
        ok, body, error = await self._post_event("approval.request", fields, metadata=metadata)
        return SendResult(
            success=ok,
            message_id=str(body.get("messageId")) if ok and body.get("messageId") else None,
            error=error,
            raw_response=body if ok else None,
        )

    async def send_clarify(
        self,
        chat_id: str,
        question: str,
        choices: Optional[list],
        clarify_id: str,
        session_key: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        fields: Dict[str, Any] = {
            "chatId": str(chat_id),
            "sessionKey": session_key,
            "clarifyId": clarify_id,
            "providerRequestId": _metadata_value(
                metadata, "providerRequestId", "provider_request_id"
            )
            or clarify_id,
            "question": question,
            "choices": [_choice(choice, index) for index, choice in enumerate(choices or [])],
        }
        thread_id = _metadata_value(metadata, "threadId", "thread_id")
        if thread_id:
            fields["threadId"] = thread_id
        source_message_id = self._source_message_id(chat_id, metadata)
        if source_message_id:
            fields["sourceMessageId"] = source_message_id
        ok, body, error = await self._post_event(
            "clarification.request", fields, metadata=metadata
        )
        return SendResult(
            success=ok,
            message_id=str(body.get("messageId")) if ok and body.get("messageId") else None,
            error=error,
            raw_response=body if ok else None,
        )

    async def send_slash_confirm(
        self,
        chat_id: str,
        title: str,
        message: str,
        session_key: str,
        confirm_id: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        fields: Dict[str, Any] = {
            "chatId": str(chat_id),
            "sessionKey": session_key,
            "confirmId": confirm_id,
            "title": title,
            "message": message,
        }
        thread_id = _metadata_value(metadata, "threadId", "thread_id")
        if thread_id:
            fields["threadId"] = thread_id
        source_message_id = self._source_message_id(chat_id, metadata)
        if source_message_id:
            fields["sourceMessageId"] = source_message_id
        ok, body, error = await self._post_event(
            "slash-confirmation.request", fields, metadata=metadata
        )
        return SendResult(
            success=ok,
            message_id=str(body.get("messageId")) if ok and body.get("messageId") else None,
            error=error,
            raw_response=body if ok else None,
        )

    async def create_handoff_thread(self, parent_chat_id: str, name: str) -> Optional[str]:
        fields = {
            "parentChatId": str(parent_chat_id),
            "name": name,
            "occurrenceId": secrets.token_hex(16),
        }
        body: Dict[str, Any] = {}
        ok = False
        for attempt in range(3):
            ok, body, _ = await self._post_event("thread.create", fields)
            if ok:
                break
            if attempt < 2:
                await asyncio.sleep(0.25 * (2**attempt))
        if not ok or not body.get("threadId"):
            return None
        return str(body["threadId"])

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": str(chat_id), "type": "thread"}


async def _standalone_send(
    pconfig: PlatformConfig,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[List[str]] = None,
    force_document: bool = False,
) -> Dict[str, Any]:
    """Deliver cron/proactive output without a live gateway process."""
    if not AIOHTTP_AVAILABLE:
        return {"error": "T3 Agent standalone send requires aiohttp"}
    adapter = T3AgentAdapter(pconfig)
    if not validate_config(pconfig):
        return {"error": "T3 Agent standalone send is not configured"}
    if str(chat_id) != CANONICAL_CHAT_ID:
        return {"error": f"T3 Agent chat ID must be {CANONICAL_CHAT_ID}"}
    occurrence_id = secrets.token_hex(16)
    message_id = _canonical_id(
        "message",
        {
            "chatId": chat_id,
            "threadId": thread_id,
            "content": message,
            "mediaFiles": media_files or [],
            "occurrenceId": occurrence_id,
        },
    )
    fields: Dict[str, Any] = {
        "chatId": str(chat_id),
        "messageId": message_id,
        "content": message,
        "final": True,
    }
    if thread_id:
        fields["threadId"] = str(thread_id)
    if media_files:
        if force_document:
            return {"error": "T3 Agent does not support document delivery"}
        try:
            fields["images"] = [_local_image_attachment(str(path)) for path in media_files]
        except ValueError as exc:
            return {"error": str(exc)}
    timeout = ClientTimeout(total=adapter.timeout_seconds)
    async with ClientSession(timeout=timeout) as client:
        body: Dict[str, Any] = {}
        error: Optional[str] = None
        ok = False
        for attempt in range(3):
            ok, body, error = await adapter._post_event("message.send", fields, client=client)
            if ok:
                break
            if attempt < 2:
                await asyncio.sleep(0.25 * (2**attempt))
    if not ok:
        return {"error": error or "T3 Agent standalone send failed"}
    return {"success": True, "message_id": str(body.get("messageId") or message_id)}


def check_requirements() -> bool:
    return AIOHTTP_AVAILABLE


def validate_config(config: PlatformConfig) -> bool:
    instance_id = str(_env_or_extra(config, _INSTANCE_ID_ENV, "instance_id", "")).strip()
    ingress_token = str(_env_or_extra(config, _INGRESS_TOKEN_ENV, "ingress_token", ""))
    bridge_token = str(_env_or_extra(config, _BRIDGE_TOKEN_ENV, "bridge_token", ""))
    bridge_url = str(_env_or_extra(config, _BRIDGE_URL_ENV, "bridge_url", "")).rstrip("/")
    host = str(_env_or_extra(config, "T3_AGENT_INGRESS_HOST", "ingress_host", DEFAULT_HOST))
    home_chat = os.getenv(_HOME_CHAT_ENV, "").strip()
    home_thread = os.getenv(_HOME_THREAD_ENV, "").strip()
    return bool(
        AIOHTTP_AVAILABLE
        and instance_id
        and ingress_token
        and bridge_token
        and _bridge_url_is_valid(bridge_url)
        and _is_loopback_host(host)
        and (not home_chat or (home_chat == CANONICAL_CHAT_ID and home_thread))
    )


def is_connected(config: PlatformConfig) -> bool:
    return validate_config(config)


def _env_enablement() -> Optional[dict]:
    instance_id = os.getenv(_INSTANCE_ID_ENV, "").strip()
    bridge_url = os.getenv(_BRIDGE_URL_ENV, "").strip()
    ingress_token = os.getenv(_INGRESS_TOKEN_ENV, "")
    bridge_token = os.getenv(_BRIDGE_TOKEN_ENV, "")
    if not (instance_id and bridge_url and ingress_token and bridge_token):
        return None
    seed: Dict[str, Any] = {
        "instance_id": instance_id,
        "bridge_url": bridge_url,
        "ingress_host": os.getenv("T3_AGENT_INGRESS_HOST", DEFAULT_HOST),
        "ingress_port": _positive_int(os.getenv("T3_AGENT_INGRESS_PORT"), DEFAULT_PORT),
    }
    home_chat = os.getenv(_HOME_CHAT_ENV, "").strip()
    home_thread = os.getenv(_HOME_THREAD_ENV, "").strip()
    if home_chat:
        seed["home_channel"] = {
            "chat_id": home_chat,
            "name": os.getenv("T3_AGENT_HOME_CHAT_NAME", "T3 Agent Home"),
        }
        if home_thread:
            seed["home_channel"]["thread_id"] = home_thread
    return seed


def register(ctx: Any) -> None:
    ctx.register_platform(
        name="t3agent",
        label="T3 Agent",
        adapter_factory=lambda cfg: T3AgentAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=[
            _INSTANCE_ID_ENV,
            _BRIDGE_URL_ENV,
            _INGRESS_TOKEN_ENV,
            _BRIDGE_TOKEN_ENV,
        ],
        install_hint="Install Hermes with the messaging extra (aiohttp)",
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var=_HOME_CHAT_ENV,
        standalone_sender_fn=_standalone_send,
        emoji="🪽",
        pii_safe=True,
        allow_update_command=True,
        platform_hint=(
            "You are chatting through T3 Agent, a thread-native Hermes surface. "
            "Replies support Markdown and may arrive asynchronously in the same thread."
        ),
    )
