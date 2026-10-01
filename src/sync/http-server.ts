import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { OperationManager } from '../operations/operation-manager.js';
import { SyncManager } from './sync-manager.js';

export interface SyncHttpServer {
  start(port?: number, host?: string): Promise<number>;
  stop(): Promise<void>;
  getPort(): number | null;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Content-Length', Buffer.byteLength(payload));
  response.end(payload);
}

function parseInteger(
  value: string | null,
  name: string,
  minimum: number,
  maximum?: number
): number | string {
  if (value === null || !/^\d+$/.test(value)) {
    return `${name} must be an integer${minimum === 0 ? ' >= 0' : ' between ' + minimum + ' and ' + maximum}`;
  }

  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    (maximum !== undefined && parsed > maximum)
  ) {
    return `${name} must be an integer${maximum === undefined ? ` >= ${minimum}` : ` between ${minimum} and ${maximum}`}`;
  }

  return parsed;
}

function requestPath(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://127.0.0.1');
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function readJsonBody(request: IncomingMessage): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    const contentLength = request.headers['content-length'];
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      request.pause();
      resolve(null);
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooLarge = false;
    let settled = false;
    request.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        settled = true;
        request.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      if (tooLarge) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

export function createSyncHttpServer(
  operationManager: OperationManager,
  localNodeId: string,
  syncManager = new SyncManager(operationManager, localNodeId)
): SyncHttpServer {
  let server: Server | null = null;
  let listeningPort: number | null = null;

  const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    let url: URL;
    try {
      url = requestPath(request);
    } catch {
      writeJson(response, 400, { error: 'Invalid request URL.' });
      return;
    }

    const isKnownPath = url.pathname === '/sync/status' || url.pathname === '/sync/operations';
    if (!isKnownPath) {
      writeJson(response, 404, { error: 'Route not found.' });
      return;
    }

    if (url.pathname === '/sync/status' && request.method !== 'GET') {
      writeJson(response, 405, { error: 'Method not allowed.' });
      return;
    }

    if (url.pathname === '/sync/operations' && request.method !== 'GET' && request.method !== 'POST') {
      writeJson(response, 405, { error: 'Method not allowed.' });
      return;
    }

    try {
      if (url.pathname === '/sync/status') {
        writeJson(response, 200, syncManager.getSyncStatus());
        return;
      }

      if (request.method === 'POST') {
        if (request.headers['content-length'] && Number(request.headers['content-length']) > MAX_BODY_BYTES) {
          request.pause();
          writeJson(response, 413, { error: 'Request body exceeds 5 MB.' });
          return;
        }
        readJsonBody(request)
          .then((body) => {
            if (body === null) {
              writeJson(response, 413, { error: 'Request body exceeds 5 MB.' });
              return;
            }
            if (body === null || typeof body !== 'object' || Array.isArray(body)) {
              writeJson(response, 400, { error: 'Request body must be a JSON object.' });
              return;
            }
            const operations = (body as { operations?: unknown }).operations;
            if (!Array.isArray(operations)) {
              writeJson(response, 400, { error: 'operations must be an array.' });
              return;
            }
            if (operations.length > 1000) {
              writeJson(response, 400, { error: 'operations must contain at most 1000 entries.' });
              return;
            }
            try {
              writeJson(response, 200, syncManager.receiveOperations(operations));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              writeJson(response, 500, { error: message });
            }
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            writeJson(response, error instanceof SyntaxError ? 400 : 500, { error: message });
          });
        return;
      }

      const nodeId = url.searchParams.get('nodeId');
      if (!nodeId) {
        writeJson(response, 400, { error: 'nodeId is required.' });
        return;
      }

      const afterSequenceValue = url.searchParams.get('afterSequence');
      const afterSequence = afterSequenceValue === null
        ? 0
        : parseInteger(afterSequenceValue, 'afterSequence', 0);
      if (typeof afterSequence === 'string') {
        writeJson(response, 400, { error: afterSequence });
        return;
      }

      const limitValue = url.searchParams.get('limit');
      const limit = limitValue === null
        ? 500
        : parseInteger(limitValue, 'limit', 1, 1000);
      if (typeof limit === 'string') {
        writeJson(response, 400, { error: limit });
        return;
      }

      const operations = operationManager
        .getOperationsAfterSequence(nodeId, afterSequence)
        .slice(0, limit);
      writeJson(response, 200, { operations });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 500, { error: message });
    }
  };

  return {
    start(port = 0, host = '127.0.0.1'): Promise<number> {
      if (server) {
        return Promise.reject(new Error('Sync HTTP server is already started.'));
      }

      server = createServer(handleRequest);
      return new Promise((resolve, reject) => {
        const activeServer = server as Server;
        const onError = (error: Error) => {
          activeServer.off('listening', onListening);
          server = null;
          reject(error);
        };
        const onListening = () => {
          activeServer.off('error', onError);
          const address = activeServer.address();
          if (!address || typeof address === 'string') {
            server = null;
            reject(new Error('Unable to determine the HTTP server port.'));
            return;
          }
          listeningPort = address.port;
          resolve(address.port);
        };

        activeServer.once('error', onError);
        activeServer.once('listening', onListening);
        activeServer.listen(port, host);
      });
    },

    stop(): Promise<void> {
      if (!server) {
        listeningPort = null;
        return Promise.resolve();
      }

      const activeServer = server;
      server = null;
      listeningPort = null;
      return new Promise((resolve, reject) => {
        activeServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },

    getPort(): number | null {
      return listeningPort;
    },
  };
}
