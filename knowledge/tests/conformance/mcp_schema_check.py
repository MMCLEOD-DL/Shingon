"""Checks every kind of message the MCP adapter sends against the published MCP JSON schemas (not run in CI: it needs
the `jsonschema` package, which the knowledge service does not otherwise use).

  python tests/conformance/mcp_schema_check.py SCHEMA_2026_07_28.json SCHEMA_2025_11_25.json

The schemas are https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/<rev>/schema.json;
record their sha256 with the result. Exit 0 when every message validates.
"""
import hashlib
import json
import sys
from pathlib import Path

import jsonschema

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src'))
from shingon_knowledge.mcp import Adapter  # noqa: E402

META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}}
COLLECTIONS = {'viewRevision': 'a' * 64, 'collections': [
    {'collectionId': 'standards', 'kind': 'reference', 'destinations': ['local-model'], 'documents': 3, 'lastIngestedAt': None}]}
SEARCH = {'viewRevision': 'a' * 64, 'evidence': 'weak', 'results': [{
    'chunkId': 'c' * 64, 'documentId': 'd.md', 'versionId': 1, 'collectionId': 'standards', 'title': 't', 'excerpt': 'x',
    'locator': {'page': 1, 'sectionPath': None, 'sheet': None, 'cellRange': None, 'slide': None}, 'source': {},
    'scores': {'rank': 1}, 'flags': {'stale': False, 'supersededBy': None, 'conflictsWith': [], 'ocr': False,
                                     'ocrConfidence': None, 'instructionLike': False}}]}


def api(method, path, body):
    return (200, SEARCH) if path == '/search' else (429, {'error': {'code': 'rate-limit', 'message': 'm', 'retryAfter': 5}}) \
        if path.startswith('/passages') else (200, COLLECTIONS)


def validator(schema, name):
    return jsonschema.Draft202012Validator({'$ref': f'#/$defs/{name}', '$defs': schema['$defs']})


def send(adapter, method, params, rid=1):
    return json.loads(adapter.handle_line(json.dumps({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params}).encode()))


def main(modern_path, legacy_path):
    modern, legacy = (json.loads(Path(p).read_text(encoding='utf-8')) for p in (modern_path, legacy_path))
    for p in (modern_path, legacy_path):
        print(f'{p}: sha256 {hashlib.sha256(Path(p).read_bytes()).hexdigest()}')
    a = Adapter(api)
    checks = [
        (modern, 'DiscoverResult', send(a, 'server/discover', {'_meta': META})['result']),
        (modern, 'ListToolsResult', send(a, 'tools/list', {'_meta': META})['result']),
        (modern, 'CallToolResult', send(a, 'tools/call', {'name': 'kb_search', 'arguments': {'query': 'q'}, '_meta': META})['result']),
        (modern, 'CallToolResult', send(a, 'tools/call', {'name': 'kb_list_collections', 'arguments': {}, '_meta': META})['result']),
        (modern, 'CallToolResult', send(a, 'tools/call', {'name': 'kb_read_passage', 'arguments': {'chunkId': 'c'}, '_meta': META})['result']),
        (modern, 'UnsupportedProtocolVersionError', send(a, 'tools/list', {'_meta': {**META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01'}})),
        # These two schema types are the error object; the whole message is a JSONRPCErrorResponse.
        (modern, 'MethodNotFoundError', send(a, 'resources/list', {'_meta': META})['error']),
        (modern, 'JSONRPCErrorResponse', send(a, 'resources/list', {'_meta': META})),
        (modern, 'InvalidParamsError', send(a, 'tools/call', {'name': 'nope', '_meta': META})['error']),
        (modern, 'JSONRPCErrorResponse', send(a, 'tools/call', {'name': 'nope', '_meta': META})),
    ]
    b = Adapter(api)
    checks += [
        (legacy, 'InitializeResult', send(b, 'initialize', {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'c', 'version': '1'}})['result']),
        (legacy, 'ListToolsResult', send(b, 'tools/list', {})['result']),
        (legacy, 'CallToolResult', send(b, 'tools/call', {'name': 'kb_search', 'arguments': {'query': 'q'}})['result']),
        (legacy, 'EmptyResult', send(b, 'ping', {})['result']),
    ]
    failures = 0
    for schema, name, message in checks:
        errors = sorted(validator(schema, name).iter_errors(message), key=str)
        print(f'{"PASS" if not errors else "FAIL"} {name} ({"2026-07-28" if schema is modern else "2025-11-25"})')
        for e in errors:
            print('   ', e.message[:200])
        failures += bool(errors)
    print(f'{len(checks) - failures}/{len(checks)} messages conform')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main(*sys.argv[1:3]))
