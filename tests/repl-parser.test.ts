import { describe, it } from 'node:test';
import * as assert from 'node:assert';

function parseCommandLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // Match command
  const firstSpaceIdx = trimmed.search(/\s/);
  if (firstSpaceIdx === -1) {
    return [trimmed];
  }

  const command = trimmed.substring(0, firstSpaceIdx).trim();
  const rest = trimmed.substring(firstSpaceIdx).trim();

  if (command.toLowerCase() === 'create' || command.toLowerCase() === 'update') {
    // For create/update: parse command, entityType, entityId, and rest as payload
    const parts = rest.split(/\s+/);
    if (parts.length >= 2) {
      const entityType = parts[0];
      const entityId = parts[1];
      // Find where entityId ends in rest
      const entityIdPos = rest.indexOf(entityId);
      let payload = rest.substring(entityIdPos + entityId.length).trim();
      // If payload is wrapped in outer quotes ('...' or "..."), unwrap it
      if (
        (payload.startsWith("'") && payload.endsWith("'")) ||
        (payload.startsWith('"') && payload.endsWith('"'))
      ) {
        payload = payload.slice(1, -1);
      }
      return [command, entityType, entityId, payload];
    }
  }

  // Fallback / standard token parser
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  const args: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(trimmed)) !== null) {
    args.push(match[1] ?? match[2] ?? match[0]);
  }
  return args;
}

describe('REPL Command Parser', () => {
  it('parses unquoted JSON payload correctly', () => {
    const args = parseCommandLine('create task task-001 {"title": "Learn Distributed Systems"}');
    assert.strictEqual(args[0], 'create');
    assert.strictEqual(args[1], 'task');
    assert.strictEqual(args[2], 'task-001');
    assert.strictEqual(args[3], '{"title": "Learn Distributed Systems"}');
    assert.deepStrictEqual(JSON.parse(args[3]), { title: 'Learn Distributed Systems' });
  });

  it('parses single-quoted JSON payload correctly', () => {
    const args = parseCommandLine("create task task-001 '{\"title\": \"Learn Distributed Systems\"}'");
    assert.strictEqual(args[0], 'create');
    assert.strictEqual(args[1], 'task');
    assert.strictEqual(args[2], 'task-001');
    assert.strictEqual(args[3], '{"title": "Learn Distributed Systems"}');
    assert.deepStrictEqual(JSON.parse(args[3]), { title: 'Learn Distributed Systems' });
  });

  it('parses standard commands correctly', () => {
    const args = parseCommandLine('delete task task-001');
    assert.deepStrictEqual(args, ['delete', 'task', 'task-001']);

    const recordsArgs = parseCommandLine('records task');
    assert.deepStrictEqual(recordsArgs, ['records', 'task']);

    const nodeArgs = parseCommandLine('node-id');
    assert.deepStrictEqual(nodeArgs, ['node-id']);
  });
});
