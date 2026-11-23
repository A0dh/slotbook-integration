// Starts the integration service.   npm run app

import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { createDeps } from './deps.js';

const deps = createDeps();
const server = createServer(createApp(deps));

server.listen(config.port, () => {
  deps.logger.info('Integration service listening', { url: `http://localhost:${config.port}` });
});
