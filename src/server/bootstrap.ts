import {existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const loadLocalEnvironment = () => {
  const environmentFile = path.join(process.cwd(), '.env');
  if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
};

export const bootstrapServer = async (loadServer: () => Promise<unknown> = () => import('./index.js')) => {
  loadLocalEnvironment();
  return loadServer();
};

const entryModuleUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (entryModuleUrl === import.meta.url) await bootstrapServer();
