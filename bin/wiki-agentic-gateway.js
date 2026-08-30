#!/usr/bin/env node
import { startGateway } from '../src/server.js';
import { loadGatewayConfig } from '../src/config.js';

const port = Number(process.env.GATEWAY_PORT ?? 7789);
const config = loadGatewayConfig();
const server = startGateway({ port, config });

console.log(`wiki-agentic-gateway listening on ${port}`);
console.log(`  capabilities: ${config.capabilities.map((capability) => capability.name).join(', ') || 'none'}`);
