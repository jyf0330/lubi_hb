"""Stateless MCP adapter. Business state remains owned by app.call_tool."""
from __future__ import annotations

import json

PROTOCOL_VERSION = "2025-03-26"


def error(request_id, code, message):
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def validate(value, schema):
    """Validate the JSON Schema subset used by the board's tool registry."""
    kind = schema.get("type")
    valid = {
        "object": isinstance(value, dict), "array": isinstance(value, list),
        "string": isinstance(value, str), "integer": type(value) is int,
        "number": type(value) in (int, float), "boolean": type(value) is bool,
    }
    if kind and not valid.get(kind, False):
        raise ValueError("工具参数类型不正确。")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError("工具参数不在可选范围内。")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        if any(key not in value for key in schema.get("required", [])):
            raise ValueError("缺少必填工具参数。")
        if schema.get("additionalProperties") is False and value.keys() - properties.keys():
            raise ValueError("包含未声明的工具参数。")
        for key, item in value.items():
            if key in properties:
                validate(item, properties[key])
    if isinstance(value, (str, list)):
        minimum, maximum = ("minLength", "maxLength") if isinstance(value, str) else ("minItems", "maxItems")
        if len(value) < schema.get(minimum, 0) or len(value) > schema.get(maximum, float("inf")):
            raise ValueError("工具参数长度不正确。")
    if isinstance(value, list):
        for item in value:
            validate(item, schema.get("items", {}))
    if type(value) in (int, float):
        if value < schema.get("minimum", -float("inf")) or value > schema.get("maximum", float("inf")):
            raise ValueError("工具参数数值超出范围。")


def dispatch(request, member, tools, call_tool):
    if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
        return error(None, -32600, "Invalid Request")
    request_id = request.get("id")
    if "id" in request and type(request_id) not in (str, int):
        return error(None, -32600, "Invalid Request")
    # Notifications must never cause task writes or produce JSON-RPC responses.
    if "id" not in request:
        return None
    params = request.get("params", {})
    if not isinstance(params, dict):
        return error(request_id, -32602, "Invalid params")
    method = request["method"]
    if method == "initialize":
        result = {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {"listChanged": False}},
                  "serverInfo": {"name": "game-team-work", "version": "1.1.0"},
                  "instructions": "todo is private preparation and never writes. work requires employee confirmation. Explicit hb status authorizes one report. Server timestamps and authenticated identity are authoritative."}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": tools}
    elif method == "tools/call":
        tool = next((item for item in tools if item["name"] == params.get("name")), None)
        if tool is None:
            return error(request_id, -32602, "Unknown tool")
        args = params.get("arguments", {})
        try:
            validate(args, tool["inputSchema"])
        except ValueError as exc:
            return error(request_id, -32602, str(exc))
        try:
            result = call_tool(member, tool["name"], args)
        except ValueError as exc:
            result = {"isError": True, "content": [{"type": "text", "text": str(exc)}], "structuredContent": {"ok": False}}
    else:
        return error(request_id, -32601, "Method not found")
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def handle_post(handler, member, tools, call_tool):
    # Native MCP clients do not send Origin. Browser callers are denied here;
    # the employee website has a separate authenticated API.
    if handler.headers.get("Origin") is not None:
        handler.send_json(403, {"error": "Origin not allowed"})
        return
    try:
        length = int(handler.headers.get("Content-Length", "0"))
        if not 0 < length <= 1_048_576:
            handler.send_json(400, {"error": "Invalid request size"})
            return
        request = json.loads(handler.rfile.read(length))
    except (ValueError, UnicodeDecodeError):
        handler.send_json(400, error(None, -32700, "Parse error"))
        return
    try:
        if isinstance(request, list) and request:
            replies = [dispatch(item, member, tools, call_tool) for item in request]
            reply = [item for item in replies if item is not None] or None
        else:
            reply = dispatch(request, member, tools, call_tool)
        if reply is None:
            handler.send_bytes(202, b"", "text/plain")
        else:
            handler.send_json(200, reply)
    except Exception:
        handler.send_json(500, error(None, -32603, "Internal server error"))
