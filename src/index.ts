import * as readline from 'node:readline';
import * as path from 'node:path';
import { DatabaseManager } from './database/db.js';
import { NodeConfig } from './config/node.js';
import { OperationManager } from './operations/operation-manager.js';
import { MeshVaultError } from './errors.js';
import { SyncManager } from './sync/sync-manager.js';
import { createSyncHttpServer, type SyncHttpServer } from './sync/http-server.js';

export interface MeshVaultApp {
  db: DatabaseManager;
  nodeConfig: NodeConfig;
  opManager: OperationManager;
  syncManager: SyncManager;
  syncServer: SyncHttpServer;
  dbPath: string;
}

export function initMeshVault(customDbPath?: string, preferredNodeId?: string): MeshVaultApp {
  const dbPath =
    customDbPath ??
    process.env.MESHVAULT_DB_PATH ??
    path.resolve(process.cwd(), 'data', 'meshvault.db');
  const db = new DatabaseManager({ dbPath });
  const nodeConfig = new NodeConfig(db, preferredNodeId);
  const opManager = new OperationManager(db, nodeConfig);
  const syncManager = new SyncManager(opManager, nodeConfig.getNodeId());
  const syncServer = createSyncHttpServer(opManager, nodeConfig.getNodeId(), syncManager);

  return { db, nodeConfig, opManager, syncManager, syncServer, dbPath };
}

function printHeader(app: MeshVaultApp): void {
  console.log('========================================');
  console.log('         MeshVault Node Started         ');
  console.log('========================================');
  console.log(`Node ID:  ${app.nodeConfig.getNodeId()}`);
  console.log(`Database: ${app.dbPath}`);
  console.log('========================================\n');
}

function printHelp(): void {
  console.log('Available Commands:');
  console.log('  node-id                                      Display current node ID');
  console.log('  sync-status                                  Display synchronization status');
  console.log('  sync <peer_url>                              Synchronize with a peer');
  console.log('  records [entity_type]                        Display local records');
  console.log('  operations                                   Display all logged operations');
  console.log('  operation <operation_id>                     Display full details of an operation');
  console.log('  pending                                      Display pending operations');
  console.log('  applied                                      Display applied operations');
  console.log('  failed                                       Display failed operations');
  console.log('  verify <operation_id>                        Verify cryptographic checksum of an operation');
  console.log('  create <type> <id> <json_payload>            Create a new record');
  console.log('  update <type> <id> <json_payload>            Update an existing record');
  console.log('  delete <type> <id>                           Delete an existing record');
  console.log('  help                                         Show this help message');
  console.log('  exit / quit                                  Exit MeshVault CLI');
}

function readNextToken(input: string, startIndex = 0): { token: string; endIndex: number } {
  let index = startIndex;

  while (index < input.length && /\s/.test(input[index])) {
    index += 1;
  }

  let token = '';
  let quoteChar: string | null = null;

  while (index < input.length) {
    const char = input[index];

    if (quoteChar) {
      if (char === '\\' && index + 1 < input.length) {
        token += input[index + 1];
        index += 2;
        continue;
      }

      if (char === quoteChar) {
        quoteChar = null;
        index += 1;
        continue;
      }

      token += char;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quoteChar = char;
      index += 1;
      continue;
    }

    if (/\s/.test(char)) {
      break;
    }

    token += char;
    index += 1;
  }

  return { token, endIndex: index };
}

export function parseCommandLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const commandToken = readNextToken(trimmed);
  const command = commandToken.token;
  const rest = trimmed.slice(commandToken.endIndex).trim();

  if (command.toLowerCase() === 'create' || command.toLowerCase() === 'update') {
    if (!rest) return [command];

    const entityTypeToken = readNextToken(rest);
    const entityType = entityTypeToken.token;
    const afterEntityType = rest.slice(entityTypeToken.endIndex).trim();

    if (!entityType || !afterEntityType) {
      return [command, entityType].filter(Boolean);
    }

    const entityIdToken = readNextToken(afterEntityType);
    const entityId = entityIdToken.token;
    let payload = afterEntityType.slice(entityIdToken.endIndex).trim();

    if (payload.length >= 2) {
      const firstChar = payload[0];
      const lastChar = payload[payload.length - 1];
      if ((firstChar === '"' && lastChar === '"') || (firstChar === "'" && lastChar === "'")) {
        payload = payload.slice(1, -1);
      }
    }

    return [command, entityType, entityId, payload].filter((part) => part !== undefined && part !== '');
  }

  const args: string[] = [];
  let cursor = 0;

  while (cursor < trimmed.length) {
    const nextToken = readNextToken(trimmed, cursor);
    if (!nextToken.token) {
      break;
    }
    args.push(nextToken.token);
    cursor = nextToken.endIndex;
  }

  return args;
}

function cleanPayload(rawPayload: string): string {
  let cleaned = rawPayload.trim();
  if (
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith('"') && cleaned.endsWith('"'))
  ) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned;
}

export async function executeCommand(app: MeshVaultApp, args: string[]): Promise<boolean> {
  if (args.length === 0) return true;

  const command = args[0].toLowerCase();

  try {
    switch (command) {
      case 'node-id':
      case 'node': {
        console.log(`Node ID: ${app.nodeConfig.getNodeId()}`);
        break;
      }

      case 'sync-status': {
        if (args.length !== 1) {
          console.error('Usage: sync-status');
          return true;
        }
        const status = app.syncManager.getSyncStatus();
        console.log(`Node ID: ${status.nodeId}`);
        console.log('Sequences:');
        const origins = Object.entries(status.sequences);
        if (origins.length === 0) {
          console.log('  (none)');
        } else {
          for (const [nodeId, sequence] of origins) {
            console.log(`  ${nodeId}: ${sequence}`);
          }
        }
        break;
      }

      case 'sync': {
        if (args.length !== 2 || !args[1]) {
          console.error('Usage: sync <peer_url>');
          return true;
        }

        let peerUrl: URL;
        try {
          peerUrl = new URL(args[1]);
          if (peerUrl.protocol !== 'http:' && peerUrl.protocol !== 'https:') {
            throw new Error('unsupported protocol');
          }
        } catch {
          console.error(`Invalid peer URL: ${args[1]}`);
          return true;
        }

        console.log(`Synchronizing with peer: ${peerUrl.toString()}`);
        try {
          const result = await app.syncManager.syncWithPeer(peerUrl.toString());
          console.log(
            `Operations pulled: ${result.pulled.results.length} ` +
              `(applied: ${result.pulled.summary.applied}, ` +
              `duplicates: ${result.pulled.summary.duplicates}, ` +
              `rejected: ${result.pulled.summary.rejected})`
          );
          console.log(
            `Operations pushed: ${result.pushed.results.length} ` +
              `(applied: ${result.pushed.summary.applied}, ` +
              `duplicates: ${result.pushed.summary.duplicates}, ` +
              `rejected: ${result.pushed.summary.rejected})`
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Synchronization failed: ${message}`);
        }
        break;
      }

      case 'records': {
        const entityType = args[1];
        const records = app.opManager.getAllRecords(entityType);
        if (records.length === 0) {
          console.log('(no records found)');
        } else {
          console.log(`Found ${records.length} record(s):`);
          for (const rec of records) {
            console.log(`- [${rec.entityType}] ID: ${rec.id}`);
            console.log(`  Data: ${JSON.stringify(rec.data, null, 2)}`);
            console.log(`  Created: ${rec.createdAt} | Updated: ${rec.updatedAt}`);
          }
        }
        break;
      }

      case 'operations': {
        const ops = app.opManager.getAllOperations();
        if (ops.length === 0) {
          console.log('(operation log is empty)');
        } else {
          console.log(`Operation Log (${ops.length} operations):`);
          for (const op of ops) {
            console.log(
              `  Seq #${op.sequenceNumber} [${op.operationType}] ID: ${op.operationId} | Entity: ${op.entityType}/${op.entityId} | Status: ${op.status}`
            );
            console.log(`    Checksum: ${op.checksum.slice(0, 16)}...`);
            console.log(`    Payload:  ${JSON.stringify(op.payload)}`);
          }
        }
        break;
      }

      case 'operation': {
        const operationId = args[1];
        if (!operationId) {
          console.error('Usage: operation <operation_id>');
          return false;
        }

        const op = app.opManager.getOperation(operationId);
        if (!op) {
          console.log(`Operation '${operationId}' not found.`);
        } else {
          console.log(`Operation Details:`);
          console.log(`  ID:              ${op.operationId}`);
          console.log(`  Node ID:         ${op.nodeId}`);
          console.log(`  Sequence:        ${op.sequenceNumber}`);
          console.log(`  Type:            ${op.operationType}`);
          console.log(`  Entity:          ${op.entityType} / ${op.entityId}`);
          console.log(`  Status:          ${op.status}`);
          console.log(`  Created At:      ${op.createdAt}`);
          console.log(`  Applied At:      ${op.appliedAt ?? 'none'}`);
          console.log(`  Checksum:        ${op.checksum}`);
          console.log(`  Payload:         ${JSON.stringify(op.payload, null, 2)}`);
          if (op.errorMessage) {
            console.log(`  Error:           ${op.errorMessage}`);
          }
        }
        break;
      }

      case 'pending': {
        const pending = app.opManager.getPendingOperations();
        if (pending.length === 0) {
          console.log('(no pending operations)');
        } else {
          console.log(`Pending Operations (${pending.length}):`);
          for (const op of pending) {
            console.log(
              `  Seq #${op.sequenceNumber} [${op.operationType}] ID: ${op.operationId} | Entity: ${op.entityType}/${op.entityId}`
            );
          }
        }
        break;
      }

      case 'applied': {
        const applied = app.opManager.getAppliedOperations();
        if (applied.length === 0) {
          console.log('(no applied operations)');
        } else {
          console.log(`Applied Operations (${applied.length}):`);
          for (const op of applied) {
            console.log(
              `  Seq #${op.sequenceNumber} [${op.operationType}] ID: ${op.operationId} | Applied: ${op.appliedAt}`
            );
          }
        }
        break;
      }

      case 'failed': {
        const failed = app.opManager.getFailedOperations();
        if (failed.length === 0) {
          console.log('(no failed operations)');
        } else {
          console.log(`Failed Operations (${failed.length}):`);
          for (const op of failed) {
            console.log(
              `  Seq #${op.sequenceNumber} [${op.operationType}] ID: ${op.operationId} | Error: ${op.errorMessage}`
            );
          }
        }
        break;
      }

      case 'verify': {
        const operationId = args[1];
        if (!operationId) {
          console.error('Usage: verify <operation_id>');
          return false;
        }

        const verification = app.opManager.verifyOperation(operationId);
        if (verification.valid) {
          console.log(`[PASS] Operation '${operationId}' integrity verified.`);
          console.log(`  SHA-256 Checksum: ${verification.checksum}`);
        } else {
          console.log(`[FAIL] Operation '${operationId}' integrity verification failed!`);
          console.log(`  Reason: ${verification.error}`);
        }
        break;
      }

      case 'create': {
        const entityType = args[1];
        const entityId = args[2];
        const rawPayloadStr = args.slice(3).join(' ');

        if (!entityType || !entityId) {
          console.error('Usage: create <entity_type> <entity_id> <json_payload>');
          return false;
        }

        let payload: Record<string, unknown> = {};
        if (rawPayloadStr) {
          const payloadStr = cleanPayload(rawPayloadStr);
          try {
            payload = JSON.parse(payloadStr);
          } catch {
            console.error(`Invalid JSON payload: ${payloadStr}`);
            return false;
          }
        }

        const op = app.opManager.createOperation({
          operationType: 'CREATE',
          entityType,
          entityId,
          payload,
        });

        console.log(`${op.operationId}`);
        console.log(`Node:     ${op.nodeId}`);
        console.log(`Sequence: ${op.sequenceNumber}`);
        console.log(`Type:     ${op.operationType}`);
        console.log(`Entity:   ${op.entityId}`);
        console.log(`Status:   ${op.status}`);
        console.log(`Checksum: ${op.checksum.slice(0, 16)}...`);
        break;
      }

      case 'update': {
        const entityType = args[1];
        const entityId = args[2];
        const rawPayloadStr = args.slice(3).join(' ');

        if (!entityType || !entityId || !rawPayloadStr) {
          console.error('Usage: update <entity_type> <entity_id> <json_payload>');
          return false;
        }

        const payloadStr = cleanPayload(rawPayloadStr);
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(payloadStr);
        } catch {
          console.error(`Invalid JSON payload: ${payloadStr}`);
          return false;
        }

        const op = app.opManager.createOperation({
          operationType: 'UPDATE',
          entityType,
          entityId,
          payload,
        });

        console.log(`${op.operationId}`);
        console.log(`Node:     ${op.nodeId}`);
        console.log(`Sequence: ${op.sequenceNumber}`);
        console.log(`Type:     ${op.operationType}`);
        console.log(`Entity:   ${op.entityId}`);
        console.log(`Status:   ${op.status}`);
        console.log(`Checksum: ${op.checksum.slice(0, 16)}...`);
        break;
      }

      case 'delete': {
        const entityType = args[1];
        const entityId = args[2];

        if (!entityType || !entityId) {
          console.error('Usage: delete <entity_type> <entity_id>');
          return false;
        }

        const op = app.opManager.createOperation({
          operationType: 'DELETE',
          entityType,
          entityId,
          payload: {},
        });

        console.log(`${op.operationId}`);
        console.log(`Node:     ${op.nodeId}`);
        console.log(`Sequence: ${op.sequenceNumber}`);
        console.log(`Type:     ${op.operationType}`);
        console.log(`Entity:   ${op.entityId}`);
        console.log(`Status:   ${op.status}`);
        console.log(`Checksum: ${op.checksum.slice(0, 16)}...`);
        break;
      }

      case 'help': {
        printHelp();
        break;
      }

      case 'exit':
      case 'quit': {
        return false;
      }

      default: {
        console.error(`Unknown command: '${command}'. Type 'help' for available commands.`);
        return false;
      }
    }
    return true;
  } catch (error) {
    if (error instanceof MeshVaultError) {
      console.error(`Error: ${error.message}`);
    } else if (error instanceof Error) {
      console.error(`Unexpected Error: ${error.message}`);
    } else {
      console.error('Unknown error occurred:', error);
    }
    return false;
  }
}

export function resolveSyncPort(): number {
  const configuredValue = process.env.MESHVAULT_PORT ?? process.env.MESHVAULT_SYNC_PORT ?? '3000';
  const configuredPort = Number(configuredValue);

  if (
    process.env.MESHVAULT_PORT !== undefined &&
    (!/^(0|[1-9]\d*)$/.test(configuredValue) ||
      !Number.isSafeInteger(configuredPort) ||
      configuredPort > 65535)
  ) {
    throw new Error(`Invalid MESHVAULT_PORT: ${configuredValue}. Expected an integer from 0 to 65535.`);
  }

  const port = Number.isSafeInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65535
    ? configuredPort
    : 3000;
  return port;
}

async function startSyncServer(app: MeshVaultApp): Promise<number> {
  return app.syncServer.start(resolveSyncPort(), process.env.MESHVAULT_SYNC_HOST ?? '127.0.0.1');
}

export async function startRepl(app: MeshVaultApp): Promise<void> {
  let syncPort: number;
  try {
    syncPort = await startSyncServer(app);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unable to start sync server: ${message}`);
    app.db.close();
    return;
  }
  printHeader(app);
  console.log(`Sync server: http://127.0.0.1:${syncPort}`);
  printHelp();
  console.log('\nEnter a command:');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'meshvault> ',
  });

  rl.prompt();

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (trimmed) {
      const args = parseCommandLine(trimmed);

      if (args[0] === 'exit' || args[0] === 'quit') {
        rl.close();
        return;
      }

      await executeCommand(app, args);
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    console.log('\nExiting MeshVault node...');
    await app.syncServer.stop();
    app.db.close();
    process.exit(0);
  });
}

// Main execution when invoked directly
if (process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'))) {
  const cliArgs = process.argv.slice(2);
  const app = initMeshVault();

  if (cliArgs.length > 0) {
    void (async () => {
      try {
        if (cliArgs[0].toLowerCase() === 'sync') {
          const syncPort = await startSyncServer(app);
          printHeader(app);
          console.log(`Sync server: http://127.0.0.1:${syncPort}`);
        } else {
          printHeader(app);
        }
        await executeCommand(app, cliArgs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Unable to start MeshVault CLI: ${message}`);
      } finally {
        await app.syncServer.stop();
        app.db.close();
      }
    })();
  } else {
    void startRepl(app);
  }
}
