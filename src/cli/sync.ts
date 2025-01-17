import chalk from 'chalk';
import chokidar from 'chokidar';
import { Argv, Arguments } from 'yargs';

import { env, cwd } from 'node:process';
import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';

import log from '../logger.js';
import { callHandler } from '../process.js';
import { createAsset, getAsset } from '../assets.js';
import { getNextVideoVersion } from './lib/json-configs.js';

export const command = 'sync';
export const desc =
  'Checks for new video files in the videos directory, uploads them, and checks any existing assets for updates.';

export function builder(yargs: Argv) {
  return yargs.options({
    dir: {
      alias: 'd',
      describe: 'The directory you initialized next-video with.',
      type: 'string',
      default: 'videos',
    },
    watch: {
      alias: 'w',
      describe: 'Watch the videos directory for changes.',
      type: 'boolean',
      default: false,
    },
  });
}

function watcher(dir: string) {
  const watcher = chokidar.watch(dir, {
    ignored: /(^|[\/\\])\..*|\.json$/,
    persistent: true,
  });

  watcher.on('add', async (filePath, stats) => {
    const relativePath = path.relative(cwd(), filePath);
    const newAsset = await createAsset(relativePath, {
      size: stats?.size,
    });

    if (newAsset) {
      log.add(`New file found: ${filePath}`);
      return callHandler('local.video.added', newAsset, getCallHandlerConfig());
    }
  });
}

function getCallHandlerConfig() {
  return JSON.parse(env['__NEXT_VIDEO_OPTS'] ?? '{}');
}

export async function handler(argv: Arguments) {
  const directoryPath = path.join(cwd(), argv.dir as string);

  try {
    const files = await readdir(directoryPath);

    const jsonFiles = files.filter((file) => file.endsWith('.json'));
    const otherFiles = files.filter((file) => !file.match(/(^|[\/\\])\..*|\.json$/));

    if (argv.watch) {
      const version = await getNextVideoVersion();
      const relativePath = path.relative(cwd(), directoryPath);
      log.space(log.label(`▶︎ next-video ${version}`));
      log.base('log', ' ', `- Watching for file changes in ./${relativePath}`);
      log.space();
      watcher(directoryPath);
    }

    const newFileProcessor = async (file: string) => {
      log.info(log.label('Processing file:'), file);

      const absolutePath = path.join(directoryPath, file);
      const relativePath = path.relative(cwd(), absolutePath);
      const stats = await stat(absolutePath);

      const newAsset = await createAsset(relativePath, {
        size: stats.size,
      });

      if (newAsset) {
        return callHandler('local.video.added', newAsset, getCallHandlerConfig());
      }
    };

    const existingFileProcessor = async (file: string) => {
      const filePath = path.join(directoryPath, file);
      const parsedPath = path.parse(filePath);
      const assetPath = path.join(parsedPath.dir, parsedPath.name);
      const existingAsset = await getAsset(assetPath);

      // If the existing asset is 'pending', 'uploading', or 'processing', run
      // it back through the local video handler.
      const assetStatus = existingAsset?.status;
      if (assetStatus && ['sourced', 'pending', 'uploading', 'processing'].includes(assetStatus)) {
        return callHandler('local.video.added', existingAsset, getCallHandlerConfig());
      }
    };

    const unprocessedFilter = (file: string) => {
      const jsonFile = `${file}.json`;
      return !jsonFiles.includes(jsonFile);
    };

    const unprocessedVideos = otherFiles.filter(unprocessedFilter);

    if (unprocessedVideos.length > 0) {
      const s = unprocessedVideos.length === 1 ? '' : 's';
      log.add(`Found ${unprocessedVideos.length} unprocessed video${s}`);
    }

    const processing = await Promise.all([
      ...unprocessedVideos.map(newFileProcessor),
      ...jsonFiles.map(existingFileProcessor),
    ]);

    const processed = processing.flat().filter((asset) => asset);

    if (processed.length > 0) {
      const s = processed.length === 1 ? '' : 's';
      log.success(`Processed (or resumed processing) ${processed.length} video${s}`);
    }
  } catch (err: any) {
    if (err.code === 'ENOENT' && err.path === directoryPath) {
      log.warning(`Directory does not exist: ${directoryPath}`);
      log.info(
        `Did you forget to run ${chalk.bold.magenta('next-video init')}? You can also use the ${chalk.bold(
          '--dir'
        )} flag to specify a different directory.`
      );
      return;
    }

    if (err.code === 'ENOENT') {
      log.warning(`Source video file does not exist: ${err.path}`);
      return;
    }

    log.error('An unknown error occurred', err);
  }
}
