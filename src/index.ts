import * as readline from 'node:readline';
import * as path from 'node:path';
import { DatabaseManager } from './database/db.js';
import { NodeConfig } from './config/node.js';
import { OperationManager } from './operations/operation-manager.js';
import { MeshVaultError } from './errors.js';

export interface MeshVaultApp {
  db: DatabaseManager;
  nodeConfig: NodeConfig;
  opManager: OperationManager;
  dbPath: string;
}

export function initMeshVault(customDbPath?: string, preferredNodeId?: string): MeshVaultApp {
  const dbPath = customDbPath ?? path.resolve(process.cwd(), 'data', 'meshvault.db');
  const db = new DatabaseManager({ dbPath });
  const nodeConfig = new NodeConfig(db, preferredNodeId);
  const opManager = new OperationManager(db, nodeConfig);

  return { db, nodeConfig, opManager, dbPath };
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

export function parseCommandLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const firstSpaceIdx = trimmed.search(/\s/);
  if (firstSpaceIdx === -1) {
    return [trimmed];
  }

  const command = trimmed.substring(0, firstSpaceIdx).trim();
  const rest = trimmed.substring(firstSpaceIdx).trim();

  if (command.toLowerCase() === 'create' || command.toLowerCase() === 'update') {
    const parts = rest.split(/\s+/);
    if (parts.length >= 2) {
      const entityType = parts[0];
      const entityId = parts[1];
      const entityIdPos = rest.indexOf(entityId);
      let payload = rest.substring(entityIdPos + entityId.length).trim();
      if (
        (payload.startsWith("'") && payload.endsWith("'")) ||
        (payload.startsWith('"') && payload.endsWith('"'))
      ) {
        payload = payload.slice(1, -1);
      }
      return [command, entityType, entityId, payload];
    }
  }

  // Token parser preserving quotes for other commands
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  const args: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(trimmed)) !== null) {
    args.push(match[1] ?? match[2] ?? match[0]);
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

export function executeCommand(app: MeshVaultApp, args: string[]): boolean {
  if (args.length === 0) return true;

  const command = args[0].toLowerCase();

  try {
    switch (command) {
      case 'node-id':
      case 'node': {
        console.log(`Node ID: ${app.nodeConfig.getNodeId()}`);
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

export function startRepl(app: MeshVaultApp): void {
  printHeader(app);
  printHelp();
  console.log('\nEnter a command:');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'meshvault> ',
  });

  rl.prompt();

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (trimmed) {
      const args = parseCommandLine(trimmed);

      if (args[0] === 'exit' || args[0] === 'quit') {
        rl.close();
        return;
      }

      executeCommand(app, args);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nExiting MeshVault node...');
    app.db.close();
    process.exit(0);
  });
}

// Main execution when invoked directly
if (process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'))) {
  const cliArgs = process.argv.slice(2);
  const app = initMeshVault();

  if (cliArgs.length > 0) {
    printHeader(app);
    executeCommand(app, cliArgs);
    app.db.close();
  } else {
    startRepl(app);
  }
}
