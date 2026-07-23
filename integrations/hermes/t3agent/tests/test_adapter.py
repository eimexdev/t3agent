from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any, Dict, List

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestClient, TestServer
from gateway.stream_consumer import GatewayStreamConsumer, StreamConsumerConfig
from gateway.session import SessionSource, build_session_key
import pytest

from integrations.hermes import t3agent as plugin_package
from integrations.hermes.t3agent import adapter as adapter_module


def make_config(**extra: Any) -> SimpleNamespace:
    defaults = {
        "instance_id": "hermes-test",
        "ingress_token": "ingress-secret",
        "bridge_token": "bridge-secret",
        "bridge_url": "http://127.0.0.1:1",
        "ingress_host": "127.0.0.1",
        "ingress_port": 8789,
        "outbox_path": ":memory:",
        "ingress_ledger_path": ":memory:",
    }
    defaults.update(extra)
    return SimpleNamespace(extra=defaults)


@pytest.fixture
def fake_platform(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    platform = SimpleNamespace(value="t3agent")
    monkeypatch.setattr(adapter_module, "Platform", lambda _: platform)
    return platform


async def make_ingress_client(
    adapter: adapter_module.T3AgentAdapter,
) -> TestClient:
    app = web.Application(client_max_size=adapter.max_body_bytes)
    app.router.add_get("/v1/health", adapter._health)
    app.router.add_get("/v1/capabilities", adapter._capabilities)
    app.router.add_post("/v1/messages", adapter._submit_message)
    app.router.add_post("/v1/interrupt", adapter._interrupt_turn)
    app.router.add_post("/v1/approvals", adapter._respond_approval)
    app.router.add_post("/v1/clarifications", adapter._respond_clarification)
    app.router.add_post("/v1/slash-confirmations", adapter._respond_slash_confirmation)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client


def auth_headers() -> Dict[str, str]:
    return {"Authorization": "Bearer ingress-secret"}


def test_plugin_package_exports_register() -> None:
    assert plugin_package.register is adapter_module.register


async def wait_until(predicate: Any, *, timeout: float = 2.0) -> None:
    async def poll() -> None:
        while not predicate():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout=timeout)


@pytest.mark.asyncio
async def test_connect_binds_authenticated_loopback_ingress(
    fake_platform: SimpleNamespace,
    unused_tcp_port: int,
) -> None:
    adapter = adapter_module.T3AgentAdapter(make_config(ingress_port=unused_tcp_port))
    assert await adapter.connect() is True
    assert adapter.bound_port is not None
    try:
        async with ClientSession() as client:
            response = await client.get(
                f"http://127.0.0.1:{adapter.bound_port}/v1/health"
                "?protocolVersion=1&requestId=health-connect",
                headers=auth_headers(),
            )
            assert response.status == 200
            assert (await response.json())["status"] == "healthy"
    finally:
        await adapter.disconnect()


def test_config_rejects_non_loopback_ingress(fake_platform: SimpleNamespace) -> None:
    assert adapter_module.validate_config(make_config(ingress_host="0.0.0.0")) is False


@pytest.mark.asyncio
async def test_message_submit_builds_normal_event_and_is_idempotent(
    fake_platform: SimpleNamespace,
) -> None:
    adapter = adapter_module.T3AgentAdapter(make_config())
    events: List[Any] = []

    async def capture(event: Any) -> None:
        events.append(event)

    adapter.handle_message = capture  # type: ignore[method-assign]
    client = await make_ingress_client(adapter)
    frame = {
        "protocolVersion": 1,
        "requestId": "request-1",
        "type": "message.submit",
        "messageId": "message-1",
        "chatId": "chat-1",
        "threadId": "thread-1",
        "user": {"id": "user-1", "name": "Ada"},
        "content": "hello",
        "images": [
            {
                "type": "image",
                "id": "image-1",
                "name": "example.png",
                "mimeType": "image/png",
                "source": {"type": "local-path", "path": "/tmp/example.png"},
            }
        ],
    }
    try:
        first = await client.post("/v1/messages", headers=auth_headers(), json=frame)
        duplicate = await client.post("/v1/messages", headers=auth_headers(), json=frame)
        assert first.status == duplicate.status == 202
        assert (await first.json())["status"] == "accepted"
        assert (await duplicate.json())["status"] == "duplicate"
        assert len(events) == 1
        event = events[0]
        assert event.text == "hello"
        assert event.message_id == "message-1"
        assert event.source.chat_id == "chat-1"
        assert event.source.thread_id == "thread-1"
        assert event.source.user_id == "user-1"
        assert event.media_urls == ["/tmp/example.png"]
        assert event.internal is False
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_message_submit_applies_model_and_reasoning_before_dispatch(
    fake_platform: SimpleNamespace,
) -> None:
    adapter = adapter_module.T3AgentAdapter(make_config())
    calls: List[Any] = []

    class FakeRunner:
        async def _handle_model_command(self, event: Any) -> None:
            calls.append(("model", event.text))

        def _apply_reasoning_selection(
            self, session_key: str, platform_key: str, value: str
        ) -> None:
            calls.append(("reasoning", session_key, platform_key, value))

    adapter.gateway_runner = FakeRunner()  # type: ignore[attr-defined]

    async def capture(event: Any) -> None:
        calls.append(("message", event.text))

    adapter.handle_message = capture  # type: ignore[method-assign]
    client = await make_ingress_client(adapter)
    try:
        response = await client.post(
            "/v1/messages",
            headers=auth_headers(),
            json={
                "protocolVersion": 1,
                "requestId": "model-request",
                "type": "message.submit",
                "messageId": "model-message",
                "chatId": "t3agent",
                "threadId": "thread-model",
                "user": {"id": "owner", "name": "Owner"},
                "content": "hello",
                "model": "gpt-5.6-sol",
                "modelProvider": "openai-codex",
                "reasoningEffort": "high",
            },
        )
        assert response.status == 202
        assert calls[0] == (
            "model",
            "/model gpt-5.6-sol --session --provider openai-codex",
        )
        assert calls[1][0] == "reasoning"
        assert calls[1][-1] == "high"
        assert calls[2] == ("message", "hello")
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_ingress_idempotency_survives_adapter_restart(
    fake_platform: SimpleNamespace,
    tmp_path: Any,
) -> None:
    ledger_path = tmp_path / "ingress-ledger.json"
    frame = {
        "protocolVersion": 1,
        "requestId": "durable-request-1",
        "type": "message.submit",
        "messageId": "durable-message-1",
        "chatId": "t3agent",
        "threadId": "thread-1",
        "user": {"id": "owner", "name": "Owner"},
        "content": "run once",
    }
    first_events: List[Any] = []
    first = adapter_module.T3AgentAdapter(
        make_config(ingress_ledger_path=str(ledger_path))
    )

    async def first_capture(event: Any) -> None:
        first_events.append(event)

    first.handle_message = first_capture  # type: ignore[method-assign]
    first_client = await make_ingress_client(first)
    try:
        response = await first_client.post("/v1/messages", headers=auth_headers(), json=frame)
        assert response.status == 202
        assert len(first_events) == 1
        assert json.loads(ledger_path.read_text(encoding="utf-8"))[0]["state"] == "completed"
    finally:
        await first_client.close()

    second_events: List[Any] = []
    second = adapter_module.T3AgentAdapter(
        make_config(ingress_ledger_path=str(ledger_path))
    )

    async def second_capture(event: Any) -> None:
        second_events.append(event)

    second.handle_message = second_capture  # type: ignore[method-assign]
    second_client = await make_ingress_client(second)
    try:
        replay = await second_client.post("/v1/messages", headers=auth_headers(), json=frame)
        assert replay.status == 202
        assert (await replay.json())["status"] == "duplicate"
        assert second_events == []
    finally:
        await second_client.close()


@pytest.mark.asyncio
async def test_pending_ingress_claim_becomes_terminal_after_restart(
    fake_platform: SimpleNamespace,
    tmp_path: Any,
) -> None:
    ledger_path = tmp_path / "ingress-ledger.json"
    ledger_path.write_text(
        json.dumps(
            [
                {
                    "requestId": "pending-request",
                    "statusCode": 202,
                    "body": {
                        "protocolVersion": 1,
                        "requestId": "pending-request",
                        "status": "accepted",
                    },
                    "state": "pending",
                }
            ]
        ),
        encoding="utf-8",
    )
    adapter = adapter_module.T3AgentAdapter(
        make_config(ingress_ledger_path=str(ledger_path))
    )
    events: List[Any] = []

    async def capture(event: Any) -> None:
        events.append(event)

    adapter.handle_message = capture  # type: ignore[method-assign]
    client = await make_ingress_client(adapter)
    try:
        response = await client.post(
            "/v1/messages",
            headers=auth_headers(),
            json={
                "protocolVersion": 1,
                "requestId": "pending-request",
                "type": "message.submit",
                "messageId": "pending-message",
                "chatId": "t3agent",
                "threadId": "thread-1",
                "user": {"id": "owner", "name": "Owner"},
                "content": "must not replay",
            },
        )
        assert response.status == 409
        assert "cannot be replayed safely" in (await response.json())["error"]
        assert events == []
        assert json.loads(ledger_path.read_text(encoding="utf-8"))[0]["state"] == "failed"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_failed_ingress_operation_is_terminal_across_restart(
    fake_platform: SimpleNamespace,
    tmp_path: Any,
) -> None:
    ledger_path = tmp_path / "ingress-ledger.json"
    frame = {
        "protocolVersion": 1,
        "requestId": "failed-operation-request",
        "type": "message.submit",
        "messageId": "failed-operation-message",
        "chatId": "t3agent",
        "threadId": "thread-1",
        "user": {"id": "owner", "name": "Owner"},
        "content": "fail once without replay",
    }
    first = adapter_module.T3AgentAdapter(
        make_config(ingress_ledger_path=str(ledger_path))
    )

    async def fail(_: Any) -> None:
        raise RuntimeError("dispatch failed")

    first.handle_message = fail  # type: ignore[method-assign]
    first_client = await make_ingress_client(first)
    try:
        response = await first_client.post("/v1/messages", headers=auth_headers(), json=frame)
        assert response.status == 500
        assert json.loads(ledger_path.read_text(encoding="utf-8"))[0]["state"] == "failed"
    finally:
        await first_client.close()

    replayed: List[Any] = []
    second = adapter_module.T3AgentAdapter(
        make_config(ingress_ledger_path=str(ledger_path))
    )

    async def capture(event: Any) -> None:
        replayed.append(event)

    second.handle_message = capture  # type: ignore[method-assign]
    second_client = await make_ingress_client(second)
    try:
        retry = await second_client.post("/v1/messages", headers=auth_headers(), json=frame)
        assert retry.status == 500
        assert "failed while executing" in (await retry.json())["error"]
        assert replayed == []
    finally:
        await second_client.close()


@pytest.mark.asyncio
async def test_ingress_fails_closed_when_ledger_cannot_be_persisted(
    fake_platform: SimpleNamespace,
    tmp_path: Any,
) -> None:
    blocked_parent = tmp_path / "not-a-directory"
    blocked_parent.write_text("blocked", encoding="utf-8")
    adapter = adapter_module.T3AgentAdapter(
        make_config(ingress_ledger_path=str(blocked_parent / "ledger.json"))
    )
    events: List[Any] = []

    async def capture(event: Any) -> None:
        events.append(event)

    adapter.handle_message = capture  # type: ignore[method-assign]
    client = await make_ingress_client(adapter)
    try:
        response = await client.post(
            "/v1/messages",
            headers=auth_headers(),
            json={
                "protocolVersion": 1,
                "requestId": "unpersisted-request",
                "type": "message.submit",
                "messageId": "unpersisted-message",
                "chatId": "t3agent",
                "threadId": "thread-1",
                "user": {"id": "owner", "name": "Owner"},
                "content": "must not be durably acknowledged",
            },
        )
        assert response.status == 500
        assert events == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_ingress_requires_bearer_and_exact_protocol(
    fake_platform: SimpleNamespace,
) -> None:
    adapter = adapter_module.T3AgentAdapter(make_config())
    client = await make_ingress_client(adapter)
    try:
        unauthorized = await client.get(
            "/v1/health?protocolVersion=1&requestId=health-1"
        )
        assert unauthorized.status == 401

        health = await client.get(
            "/v1/health?protocolVersion=1&requestId=health-1", headers=auth_headers()
        )
        assert await health.json() == {
            "protocolVersion": 1,
            "requestId": "health-1",
            "status": "healthy",
            "instanceId": "hermes-test",
        }

        capabilities = await client.get(
            "/v1/capabilities?protocolVersion=1&requestId=provider-capabilities",
            headers=auth_headers(),
        )
        capabilities_body = await capabilities.json()
        assert capabilities_body["requestId"] == "provider-capabilities"
        assert capabilities_body["capabilities"]["asynchronousDelivery"] is True
        assert capabilities_body["capabilities"]["commandCatalog"] is True
        command_names = {command["name"] for command in capabilities_body["commands"]}
        assert {"new", "restart", "model", "stop", "commands"} <= command_names
        assert len(command_names) >= 40

        bad_version = await client.post(
            "/v1/messages",
            headers=auth_headers(),
            json={"protocolVersion": 2, "requestId": "r", "type": "message.submit"},
        )
        assert bad_version.status == 400
        assert "protocolVersion" in (await bad_version.json())["error"]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_interrupt_can_resolve_session_from_chat_and_thread(
    fake_platform: SimpleNamespace,
) -> None:
    adapter = adapter_module.T3AgentAdapter(make_config())
    interrupted: List[str] = []

    async def capture(session_key: str, **_: Any) -> None:
        interrupted.append(session_key)

    adapter.cancel_session_processing = capture  # type: ignore[method-assign]
    client = await make_ingress_client(adapter)
    try:
        response = await client.post(
            "/v1/interrupt",
            headers=auth_headers(),
            json={
                "protocolVersion": 1,
                "requestId": "interrupt-1",
                "type": "turn.interrupt",
                "chatId": "chat-1",
                "threadId": "thread-1",
            },
        )
        assert response.status == 200
        assert interrupted == ["agent:main:t3agent:thread:chat-1:thread-1"]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_send_posts_direct_tagged_union_with_stable_ids(
    fake_platform: SimpleNamespace,
) -> None:
    received: List[Dict[str, Any]] = []
    headers: List[Dict[str, str]] = []

    async def receive(request: web.Request) -> web.Response:
        received.append(await request.json())
        headers.append(dict(request.headers))
        return web.json_response(
            {
                "protocolVersion": 1,
                "requestId": "request-1",
                "deliveryId": "delivery-1",
                "status": "accepted",
            }
        )

    app = web.Application()
    app.router.add_post("/api/hermes/hermes-test/events", receive)
    server = TestServer(app)
    await server.start_server()
    adapter = adapter_module.T3AgentAdapter(make_config(bridge_url=str(server.make_url("/"))))
    adapter.bridge_url = adapter.bridge_url.rstrip("/")
    adapter._client = ClientSession()
    try:
        first = await adapter.send(
            "chat-1",
            "full cumulative content",
            metadata={
                "threadId": "thread-1",
                "deliveryId": "delivery-1",
                "requestId": "request-1",
                "messageId": "hermes-message-1",
                "final": False,
            },
        )
        assert first.success is True
        assert first.message_id == "hermes-message-1"
        assert received == [
            {
                "protocolVersion": 1,
                "requestId": "request-1",
                "deliveryId": "delivery-1",
                "type": "message.send",
                "chatId": "chat-1",
                "threadId": "thread-1",
                "messageId": "hermes-message-1",
                "content": "full cumulative content",
                "final": False,
            }
        ]
        assert headers[0]["Authorization"] == "Bearer bridge-secret"
        assert headers[0]["Idempotency-Key"] == "request-1"
    finally:
        await adapter._client.close()
        adapter._client = None
        await server.close()


@pytest.mark.asyncio
async def test_stream_metadata_marks_preview_then_routes_final_edit(
    fake_platform: SimpleNamespace,
) -> None:
    received: List[Dict[str, Any]] = []

    async def receive(request: web.Request) -> web.Response:
        frame = await request.json()
        received.append(frame)
        return web.json_response(
            {
                "protocolVersion": 1,
                "requestId": frame["requestId"],
                "deliveryId": frame["deliveryId"],
                "status": "accepted",
            }
        )

    app = web.Application()
    app.router.add_post("/api/hermes/hermes-test/events", receive)
    server = TestServer(app)
    await server.start_server()
    adapter = adapter_module.T3AgentAdapter(make_config(bridge_url=str(server.make_url("/"))))
    adapter.bridge_url = adapter.bridge_url.rstrip("/")
    adapter._client = ClientSession()
    try:
        preview = await adapter.send(
            "chat-1",
            "partial",
            metadata={"threadId": "thread-1", "expect_edits": True},
        )
        assert preview.success is True
        assert preview.message_id is not None

        final = await adapter.edit_message(
            "chat-1",
            preview.message_id,
            "partial answer",
            finalize=True,
        )
        assert final.success is True
        assert received[0]["type"] == "message.send"
        assert received[0]["final"] is False
        assert received[0]["threadId"] == "thread-1"
        assert received[1]["type"] == "message.edit"
        assert received[1]["final"] is True
        assert received[1]["threadId"] == "thread-1"

        await adapter.on_processing_complete(
            SimpleNamespace(
                source=SimpleNamespace(chat_id="chat-1", thread_id="thread-1"),
                message_id="hermes-user:hermes-turn-1",
            ),
            SimpleNamespace(value="success"),
        )
        await wait_until(lambda: len(received) >= 3)
        assert received[2]["type"] == "turn.complete"
        assert received[2]["sourceMessageId"] == "hermes-user:hermes-turn-1"
        assert received[2]["outcome"] == "success"
        assert received[2]["threadId"] == "thread-1"
    finally:
        await adapter.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_real_stream_consumer_does_not_complete_turn_at_segment_boundaries(
    fake_platform: SimpleNamespace,
) -> None:
    received: List[Dict[str, Any]] = []

    async def receive(request: web.Request) -> web.Response:
        frame = await request.json()
        received.append(frame)
        return web.json_response(
            {
                "protocolVersion": 1,
                "requestId": frame["requestId"],
                "deliveryId": frame["deliveryId"],
                "status": "accepted",
            }
        )

    app = web.Application()
    app.router.add_post("/api/hermes/hermes-test/events", receive)
    server = TestServer(app)
    await server.start_server()
    adapter = adapter_module.T3AgentAdapter(make_config(bridge_url=str(server.make_url("/"))))
    adapter.bridge_url = adapter.bridge_url.rstrip("/")
    adapter._client = ClientSession()
    consumer = GatewayStreamConsumer(
        adapter=adapter,
        chat_id="chat-1",
        config=StreamConsumerConfig(edit_interval=0, buffer_threshold=1, cursor=""),
        metadata={"threadId": "thread-1"},
    )
    try:
        task = asyncio.create_task(consumer.run())
        consumer.on_delta("I will inspect that first.")
        await asyncio.sleep(0.1)
        consumer.on_segment_break()
        await asyncio.sleep(0.1)
        consumer.on_commentary("Inspecting the repository")
        await asyncio.sleep(0.1)
        consumer.on_delta("The final answer")
        consumer.finish()
        await asyncio.wait_for(task, timeout=2)

        assert sum(frame["type"] == "message.send" for frame in received) >= 2
        assert any(
            frame["type"] in {"message.send", "message.edit"} and frame["final"]
            for frame in received
        )
        assert all(frame["type"] != "turn.complete" for frame in received)

        await adapter.on_processing_complete(
            SimpleNamespace(
                source=SimpleNamespace(chat_id="chat-1", thread_id="thread-1"),
                message_id="hermes-user:hermes-stream-turn-1",
            ),
            SimpleNamespace(value="success"),
        )
        await wait_until(lambda: any(frame["type"] == "turn.complete" for frame in received))
        assert received[-1]["type"] == "turn.complete"
        assert received[-1]["sourceMessageId"] == "hermes-user:hermes-stream-turn-1"
    finally:
        await adapter.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_busy_slash_command_uses_its_own_source_and_completes(
    fake_platform: SimpleNamespace,
) -> None:
    received: List[Dict[str, Any]] = []

    async def receive(request: web.Request) -> web.Response:
        frame = await request.json()
        received.append(frame)
        return web.json_response(
            {
                "protocolVersion": 1,
                "requestId": frame["requestId"],
                "deliveryId": frame["deliveryId"],
                "status": "accepted",
            }
        )

    app = web.Application()
    app.router.add_post("/api/hermes/hermes-test/events", receive)
    server = TestServer(app)
    await server.start_server()
    adapter = adapter_module.T3AgentAdapter(make_config(bridge_url=str(server.make_url("/"))))
    adapter.bridge_url = adapter.bridge_url.rstrip("/")
    adapter._client = ClientSession()
    source = SessionSource(
        platform=fake_platform,
        chat_id="t3agent",
        chat_type="thread",
        user_id="owner",
        thread_id="thread-1",
    )
    active_event = adapter_module.MessageEvent(
        text="work",
        source=source,
        message_id="hermes-user:turn-a",
    )
    command_event = adapter_module.MessageEvent(
        text="/status",
        source=source,
        message_id="hermes-user:turn-b",
    )
    session_key = build_session_key(
        source,
        group_sessions_per_user=adapter.config.extra.get("group_sessions_per_user", True),
        thread_sessions_per_user=adapter.config.extra.get("thread_sessions_per_user", False),
    )
    adapter._active_sessions[session_key] = asyncio.Event()
    await adapter.on_processing_start(active_event)

    async def handle(_: Any) -> str:
        return "Hermes is busy"

    adapter._message_handler = handle
    try:
        await adapter.handle_message(command_event)
        await wait_until(lambda: len(received) >= 2)
        assert received[0]["type"] == "message.send"
        assert received[0]["sourceMessageId"] == "hermes-user:turn-b"
        assert received[1]["type"] == "turn.complete"
        assert received[1]["sourceMessageId"] == "hermes-user:turn-b"
        assert adapter._processing_sources[("t3agent", "thread-1")] == "hermes-user:turn-a"
    finally:
        await adapter.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_busy_slash_command_reports_handler_failure(
    fake_platform: SimpleNamespace,
) -> None:
    received: List[Dict[str, Any]] = []

    async def receive(request: web.Request) -> web.Response:
        frame = await request.json()
        received.append(frame)
        return web.json_response(
            {
                "protocolVersion": 1,
                "requestId": frame["requestId"],
                "deliveryId": frame["deliveryId"],
                "status": "accepted",
            }
        )

    app = web.Application()
    app.router.add_post("/api/hermes/hermes-test/events", receive)
    server = TestServer(app)
    await server.start_server()
    adapter = adapter_module.T3AgentAdapter(make_config(bridge_url=str(server.make_url("/"))))
    adapter.bridge_url = adapter.bridge_url.rstrip("/")
    adapter._client = ClientSession()
    source = SessionSource(
        platform=fake_platform,
        chat_id="t3agent",
        chat_type="thread",
        user_id="owner",
        thread_id="thread-1",
    )
    command_event = adapter_module.MessageEvent(
        text="/status",
        source=source,
        message_id="hermes-user:failed-command",
    )
    session_key = build_session_key(
        source,
        group_sessions_per_user=adapter.config.extra.get("group_sessions_per_user", True),
        thread_sessions_per_user=adapter.config.extra.get("thread_sessions_per_user", False),
    )
    adapter._active_sessions[session_key] = asyncio.Event()

    async def fail(_: Any) -> str:
        raise RuntimeError("command failed")

    adapter._message_handler = fail
    try:
        await adapter.handle_message(command_event)
        await wait_until(lambda: len(received) == 1)
        assert received[0]["type"] == "turn.complete"
        assert received[0]["sourceMessageId"] == "hermes-user:failed-command"
        assert received[0]["outcome"] == "failure"
    finally:
        await adapter.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_completion_outbox_recovers_after_t3_restart(
    fake_platform: SimpleNamespace,
    tmp_path: Any,
    unused_tcp_port: int,
) -> None:
    outbox_path = tmp_path / "completion-outbox.json"
    first = adapter_module.T3AgentAdapter(
        make_config(outbox_path=str(outbox_path), bridge_url="http://127.0.0.1:1")
    )
    first._client = ClientSession()
    event = SimpleNamespace(
        source=SimpleNamespace(chat_id="t3agent", thread_id="thread-1"),
        message_id="hermes-user:durable-turn",
    )
    await first.on_processing_complete(event, SimpleNamespace(value="success"))
    assert json.loads(outbox_path.read_text(encoding="utf-8")) == [
        {
            "chatId": "t3agent",
            "sourceMessageId": "hermes-user:durable-turn",
            "outcome": "success",
            "threadId": "thread-1",
        }
    ]
    await first.disconnect()

    received: List[Dict[str, Any]] = []

    async def receive(request: web.Request) -> web.Response:
        frame = await request.json()
        received.append(frame)
        return web.json_response(
            {
                "protocolVersion": 1,
                "requestId": frame["requestId"],
                "deliveryId": frame["deliveryId"],
                "status": "accepted",
            }
        )

    app = web.Application()
    app.router.add_post("/api/hermes/hermes-test/events", receive)
    server = TestServer(app)
    await server.start_server()
    second = adapter_module.T3AgentAdapter(
        make_config(
            outbox_path=str(outbox_path),
            bridge_url=str(server.make_url("/")),
            ingress_port=unused_tcp_port,
        )
    )
    try:
        assert await second.connect() is True
        await wait_until(lambda: len(received) == 1)
        assert received[0]["type"] == "turn.complete"
        assert received[0]["sourceMessageId"] == "hermes-user:durable-turn"
        await wait_until(
            lambda: json.loads(outbox_path.read_text(encoding="utf-8")) == []
        )
    finally:
        await second.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_completion_fails_closed_when_outbox_cannot_be_persisted(
    fake_platform: SimpleNamespace,
    tmp_path: Any,
) -> None:
    received: List[Dict[str, Any]] = []

    async def receive(request: web.Request) -> web.Response:
        frame = await request.json()
        received.append(frame)
        return web.json_response(
            {
                "protocolVersion": 1,
                "requestId": frame["requestId"],
                "deliveryId": frame["deliveryId"],
                "status": "accepted",
            }
        )

    app = web.Application()
    app.router.add_post("/api/hermes/hermes-test/events", receive)
    server = TestServer(app)
    await server.start_server()
    blocked_parent = tmp_path / "not-a-directory"
    blocked_parent.write_text("blocked", encoding="utf-8")
    adapter = adapter_module.T3AgentAdapter(
        make_config(
            outbox_path=str(blocked_parent / "outbox.json"),
            bridge_url=str(server.make_url("/")),
        )
    )
    adapter.bridge_url = adapter.bridge_url.rstrip("/")
    adapter._client = ClientSession()
    event = SimpleNamespace(
        source=SimpleNamespace(chat_id="t3agent", thread_id="thread-1"),
        message_id="hermes-user:unpersisted-completion",
    )
    try:
        with pytest.raises(OSError):
            await adapter.on_processing_complete(event, SimpleNamespace(value="success"))
        await wait_until(lambda: len(received) >= 1)
        assert received[0]["type"] == "turn.complete"
    finally:
        await adapter.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_repeated_handoff_names_create_distinct_threads(
    fake_platform: SimpleNamespace,
) -> None:
    received: List[Dict[str, Any]] = []

    async def receive(request: web.Request) -> web.Response:
        frame = await request.json()
        received.append(frame)
        return web.json_response(
            {
                "protocolVersion": 1,
                "requestId": frame["requestId"],
                "deliveryId": frame["deliveryId"],
                "status": "accepted",
                "threadId": f"thread-{len(received)}",
            }
        )

    app = web.Application()
    app.router.add_post("/api/hermes/hermes-test/events", receive)
    server = TestServer(app)
    await server.start_server()
    adapter = adapter_module.T3AgentAdapter(make_config(bridge_url=str(server.make_url("/"))))
    adapter.bridge_url = adapter.bridge_url.rstrip("/")
    adapter._client = ClientSession()
    try:
        assert await adapter.create_handoff_thread("t3agent", "Research") == "thread-1"
        assert await adapter.create_handoff_thread("t3agent", "Research") == "thread-2"
        assert received[0]["name"] == received[1]["name"] == "Research"
        assert received[0]["occurrenceId"] != received[1]["occurrenceId"]
        assert received[0]["deliveryId"] != received[1]["deliveryId"]
    finally:
        await adapter.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_send_image_file_posts_inline_attachment(
    fake_platform: SimpleNamespace,
    tmp_path: Any,
) -> None:
    received: List[Dict[str, Any]] = []
    image_path = tmp_path / "generated.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\n")

    async def receive(request: web.Request) -> web.Response:
        frame = await request.json()
        received.append(frame)
        return web.json_response(
            {
                "protocolVersion": 1,
                "requestId": frame["requestId"],
                "deliveryId": frame["deliveryId"],
                "status": "accepted",
            }
        )

    app = web.Application()
    app.router.add_post("/api/hermes/hermes-test/events", receive)
    server = TestServer(app)
    await server.start_server()
    adapter = adapter_module.T3AgentAdapter(make_config(bridge_url=str(server.make_url("/"))))
    adapter.bridge_url = adapter.bridge_url.rstrip("/")
    adapter._client = ClientSession()
    try:
        result = await adapter.send_image_file(
            "t3agent",
            str(image_path),
            caption="Generated image",
            metadata={"thread_id": "thread-1"},
        )
        assert result.success is True
        assert received[0]["content"] == "Generated image"
        assert received[0]["threadId"] == "thread-1"
        assert received[0]["images"][0]["source"] == {
            "type": "data-url",
            "dataUrl": "data:image/png;base64,iVBORw0KGgo=",
        }
        second_path = tmp_path / "generated-second.png"
        second_path.write_bytes(b"\x89PNG\r\n\x1a\nsecond")
        second = await adapter.send_image_file(
            "t3agent",
            str(second_path),
            caption="Generated image",
            metadata={"thread_id": "thread-1"},
        )
        assert second.success is True
        assert received[0]["messageId"] != received[1]["messageId"]
    finally:
        await adapter._client.close()
        adapter._client = None
        await server.close()


@pytest.mark.asyncio
async def test_send_image_fetches_remote_media_through_hermes_safe_cache(
    fake_platform: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    received: List[Dict[str, Any]] = []
    image_path = tmp_path / "remote.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\nremote")

    async def cache_remote(url: str, ext: str = ".jpg", retries: int = 2) -> str:
        assert url == "https://images.example/result.png"
        assert ext == ".png"
        assert retries == 2
        return str(image_path)

    async def receive(request: web.Request) -> web.Response:
        frame = await request.json()
        received.append(frame)
        return web.json_response(
            {
                "protocolVersion": 1,
                "requestId": frame["requestId"],
                "deliveryId": frame["deliveryId"],
                "status": "accepted",
            }
        )

    monkeypatch.setattr(adapter_module, "cache_image_from_url", cache_remote)
    app = web.Application()
    app.router.add_post("/api/hermes/hermes-test/events", receive)
    server = TestServer(app)
    await server.start_server()
    adapter = adapter_module.T3AgentAdapter(make_config(bridge_url=str(server.make_url("/"))))
    adapter.bridge_url = adapter.bridge_url.rstrip("/")
    adapter._client = ClientSession()
    try:
        result = await adapter.send_image(
            "t3agent",
            "https://images.example/result.png",
            caption="Remote result",
            metadata={"thread_id": "thread-1"},
        )
        assert result.success is True
        assert received[0]["content"] == "Remote result"
        assert received[0]["images"][0]["source"]["type"] == "data-url"
    finally:
        await adapter._client.close()
        adapter._client = None
        await server.close()


@pytest.mark.asyncio
async def test_slash_confirmation_response_uses_public_resolver(
    fake_platform: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tools import slash_confirm

    calls: List[tuple[str, str, str]] = []

    async def resolve(session_key: str, confirm_id: str, choice: str) -> str:
        calls.append((session_key, confirm_id, choice))
        return "confirmed"

    monkeypatch.setattr(slash_confirm, "resolve", resolve)
    adapter = adapter_module.T3AgentAdapter(make_config())
    client = await make_ingress_client(adapter)
    try:
        response = await client.post(
            "/v1/slash-confirmations",
            headers=auth_headers(),
            json={
                "protocolVersion": 1,
                "requestId": "confirm-response-1",
                "type": "slash-confirmation.respond",
                "sessionKey": "session-1",
                "confirmId": "confirm-1",
                "choice": "always",
            },
        )
        assert response.status == 200
        assert calls == [("session-1", "confirm-1", "always")]
    finally:
        await client.close()


def test_validate_config_rejects_non_loopback_ingress(
    fake_platform: SimpleNamespace,
) -> None:
    assert adapter_module.validate_config(make_config()) is True
    assert adapter_module.validate_config(make_config(ingress_host="0.0.0.0")) is False


@pytest.mark.asyncio
async def test_standalone_cron_send_uses_final_message_event(
    fake_platform: SimpleNamespace,
) -> None:
    received: List[Dict[str, Any]] = []

    async def receive(request: web.Request) -> web.Response:
        frame = await request.json()
        received.append(frame)
        return web.json_response(
            {
                "protocolVersion": 1,
                "requestId": frame["requestId"],
                "deliveryId": frame["deliveryId"],
                "status": "accepted",
            }
        )

    app = web.Application()
    app.router.add_post("/api/hermes/hermes-test/events", receive)
    server = TestServer(app)
    await server.start_server()
    try:
        result = await adapter_module._standalone_send(
            make_config(bridge_url=str(server.make_url("/"))),
            "t3agent",
            "scheduled result",
            thread_id="thread-1",
        )
        assert result["success"] is True
        assert received[0]["type"] == "message.send"
        assert received[0]["chatId"] == "t3agent"
        assert received[0]["threadId"] == "thread-1"
        assert received[0]["content"] == "scheduled result"
        assert received[0]["final"] is True

        repeated = await adapter_module._standalone_send(
            make_config(bridge_url=str(server.make_url("/"))),
            "t3agent",
            "scheduled result",
            thread_id="thread-1",
        )
        assert repeated["success"] is True
        assert received[1]["messageId"] != received[0]["messageId"]
        assert received[1]["deliveryId"] != received[0]["deliveryId"]
    finally:
        await server.close()
