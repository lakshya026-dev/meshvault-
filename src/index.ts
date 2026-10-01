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
  console.log('  pending                                      Display pending operations');
  console.log('  create <type> <id> <json_payload>            Create a new record');
  console.log('  update <type> <id> <json_payload>            Update an existing record');
  console.log('  delete <type> <id>                           Delete an existing record');
  console.log('  help                                         Show this help message');
  console.log('  exit / quit                                  Exit MeshVault CLI');
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
            console.log(`    Payload: ${JSON.stringify(op.payload)}`);
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

      case 'create': {
        const entityType = args[1];
        const entityId = args[2];
        const payloadStr = args.slice(3).join(' ');

        if (!entityType || !entityId) {
          console.error('Usage: create <entity_type> <entity_id> <json_payload>');
          return false;
        }

        let payload: Record<string, unknown> = {};
        if (payloadStr) {
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
        break;
      }

      case 'update': {
        const entityType = args[1];
        const entityId = args[2];
        const payloadStr = args.slice(3).join(' ');

        if (!entityType || !entityId || !payloadStr) {
          console.error('Usage: update <entity_type> <entity_id> <json_payload>');
          return false;
        }

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
      // Split preserving quoted arguments
      const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
      const args: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = regex.exec(trimmed)) !== null) {
        args.push(match[1] ?? match[2] ?? match[0]);
      }

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
