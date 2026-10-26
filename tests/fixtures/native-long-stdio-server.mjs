import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
    executeNativeCommand,
    reconcileNativeCommand,
} from '../../dist/native-command-execution.js';

// This executable is test-only: trusted fixture paths never enter public tool arguments.
const [root, cliEntry] = process.argv.slice(2);
const server = new Server(
    { name: 'native-long-stdio-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } }
);
let settled;
let signalObserved = false;
const content = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const mode = request.params.arguments?.mode;
    if (request.params.name === 'status') {
        return content({
            settled,
            signalObserved,
            ready: fs.existsSync(path.join(root, 'cancel-ready')),
            descendantCompleted: fs.existsSync(path.join(root, 'descendant-completed')),
        });
    }
    if (request.params.name === 'reconcile') {
        if (request.params.arguments?.operatorReconciled !== true)
            return content({ released: false });
        return content(reconcileNativeCommand(root));
    }
    if (request.params.name !== 'run' || !['long', 'cancel', 'quick'].includes(mode))
        throw new Error('Invalid fixture request');
    if (mode === 'cancel')
        extra.signal.addEventListener(
            'abort',
            () => {
                signalObserved = true;
            },
            { once: true }
        );
    const result = await executeNativeCommand(
        { workspaceRoot: root, command: 'retrieve', args: ['fixture/BU', 'query', mode] },
        {
            signal: extra.signal,
            progress: (elapsedSeconds) => {
                const progressToken = extra._meta?.progressToken;
                if (progressToken !== undefined)
                    void extra
                        .sendNotification({
                            method: 'notifications/progress',
                            params: { progressToken, progress: elapsedSeconds },
                        })
                        .catch(() => {});
            },
        },
        { cliEntry }
    );
    if (mode === 'cancel') settled = result;
    return content(result);
});
await server.connect(new StdioServerTransport());
