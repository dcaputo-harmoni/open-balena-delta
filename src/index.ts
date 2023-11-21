import express from 'express';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { once } from 'events';
import dockerDelta = require('docker-delta');
import Docker = require('dockerode');
import * as dt from 'docker-toolbelt';

const PORT = 80;
const DEBUG = true;

const deltaRsyncPath = '/delta-rsync';

// Pull environment variables
const balenaTld = String(process.env.BALENA_TLD);
const registryHost = String(
  process.env.REGISTRY_HOST ?? `registry.${balenaTld}`
);
const builderToken = String(process.env.TOKEN_AUTH_BUILDER_TOKEN);

const auth = {
  authconfig: {
    username: 'builder',
    password: builderToken,
    serveraddress: registryHost,
  },
};
const authFile = JSON.stringify({
  auths: {
    [registryHost]: {
      auth: Buffer.from(`builder:${builderToken}`).toString('base64'),
    },
  },
});

const docker = new Docker();

// debug healper function
const debug = (msg: string) => {
  if (DEBUG) console.log(`[open-balena-delta] ${msg}`);
};

// Heper function to parse query params
const parseQueryParams = (srcParam: any, destParam: any, jwtHeader: any) => {
  // src = old image which we are transitioning from
  // dest = new image which we are transitioning to
  debug(
    `Parsing delta params: ${JSON.stringify({
      srcParam,
      destParam,
      jwtHeader,
    })}`
  );
  if (!srcParam || !destParam)
    throw new Error('src and dest url params must be provided');
  const src = String(srcParam);
  const dest = String(destParam);
  // Parse input params
  const jwt = jwtHeader?.split(' ')?.[1];
  if (!jwt) throw new Error('authorization header must be provided');
  return { src, dest, jwt };
};

// Helper function to parse src / dest image tags into delta image tag and path
const parseDeltaParams = (src: string, dest: string) => {
  const IMG_REGEX = /^.*?\/v([0-9]+)\/([0-9a-f]+)(@sha256:([0-9a-f]+))?$/;
  const srcMatch = IMG_REGEX.exec(src);
  const destMatch = IMG_REGEX.exec(dest);

  // Validate input params
  if (!srcMatch || !destMatch)
    throw new Error('src and dest url params must be provided');
  const [, srcImgVer, srcImgBase] = srcMatch;
  const [, destImgVer, destImgBase] = destMatch;
  if (srcImgVer !== destImgVer) {
    throw new Error('src and dest image versions must match');
  }

  // Generate delta image name and path
  const deltaTag = `delta-${String(srcImgBase).substring(0, 16)}`;
  const deltaBase = `${destImgBase}:${deltaTag}`;
  const deltaFull = `v${destImgVer}/${deltaBase}`;
  const delta = `${registryHost}/${deltaFull}`;

  return { deltaBase, deltaFull, delta };
};

const waitForStream = async (stream: NodeJS.ReadableStream) => {
  if (DEBUG) stream.pipe(process.stdout);
  return new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (e) => {
      if (e) return reject(e);
      resolve();
    });
  });
};

async function createHttpServer(listenPort: number) {
  const app = express();

  app.get('/api/v3/delta', async (req, res) => {
    let buildingFile;
    debug('V3 delta request received');

    try {
      const { src, dest } = parseQueryParams(
        req.query.src,
        req.query.dest,
        req.headers.authorization
      );
      const { deltaBase, delta } = parseDeltaParams(src, dest);

      buildingFile = `/tmp/${deltaBase}`;

      // Check if we are currently building delta image in a parallel process
      if (fs.existsSync(buildingFile)) {
        // Send 504, which informs supervisor that delta is in process
        res.sendStatus(504);
        return;
      }

      // Check if image exists in registry using manifest inspect (not available in dockerode)
      const tmpWorkdir = `/tmp/${crypto.randomUUID()}`;
      fs.mkdirSync(`${tmpWorkdir}/.docker`, { recursive: true });
      fs.writeFileSync(`${tmpWorkdir}/.docker/config.json`, authFile);
      const inspectStream = spawn('docker', ['manifest', 'inspect', delta], {
        cwd: tmpWorkdir,
        env: {
          DOCKER_CONFIG: `${tmpWorkdir}/.docker`,
        },
      });
      const exists = (await once(inspectStream, 'close'))?.[0] === 0;
      fs.rmSync(tmpWorkdir, { recursive: true });

      // Build delta image only if it doesn't already exist in the registry
      if (!exists) {
        // touch building file to indicate that we are currently building delta image
        fs.closeSync(fs.openSync(buildingFile, 'w'));

        // Send 504, which informs supervisor that delta is in process
        res.sendStatus(504);

        // Continue executing delta process in background
        const srcStream = await docker.pull(src, auth);
        const destStream = await docker.pull(dest, auth);
        await Promise.all([
          waitForStream(srcStream),
          waitForStream(destStream),
        ]);

        // Create delta image
        const deltaStream = await dt.createDelta(docker, {
          src,
          dest,
        });
        if (DEBUG) deltaStream.pipe(process.stdout);
        const deltaId = await new Promise<string>((resolve, reject) => {
          let imageId: string;
          docker.modem.followProgress(
            deltaStream,
            (e) => {
              if (e) return reject(e);
              if (!imageId) {
                return reject(new Error('Failed to parse delta image ID!'));
              }
              resolve(imageId);
            },
            (e) => {
              const match = /^Created delta: (sha256:\w+)$/.exec(e.status);
              if (match && !imageId) imageId = match[1];
            }
          );
        });

        // Tag delta image
        await docker.getImage(deltaId).tag({
          repo: delta.split(':')[0],
          tag: delta.split(':')[1],
        });

        // Push delta image
        const pushStream = await docker.getImage(delta).push(auth);
        await waitForStream(pushStream);

        // Remove delta image
        await docker.getImage(delta).remove(auth);

        // Remove building file
        if (fs.existsSync(buildingFile)) fs.rmSync(buildingFile);
      } else {
        // If delta image exists, return it
        debug(`V3 delta image being sent to device: ${delta}`);
        res.set('content-type', 'text/plain');
        res.send(JSON.stringify({ name: delta }));
      }
    } catch (err) {
      debug(`V3 delta error: ${err.message}}`);
      res.sendStatus(400);
      // Remove building file
      if (buildingFile && fs.existsSync(buildingFile)) fs.rmSync(buildingFile);
    }
  });

  app.get('/api/v2/delta', async (req, res) => {
    let buildingFile;

    debug('V2 delta request received');

    try {
      const { src, dest } = parseQueryParams(
        req.query.src,
        req.query.dest,
        req.headers.authorization
      );
      const { deltaBase } = parseDeltaParams(src, dest);

      buildingFile = `/tmp/${deltaBase}`;

      // Check if we are currently building delta image in a parallel process
      if (fs.existsSync(buildingFile)) {
        // Send 504, which informs supervisor that delta is in process
        res.sendStatus(504);
        return;
      }

      // Build delta rsync only if it doesn't already exist
      if (!fs.existsSync(`${deltaRsyncPath}/${deltaBase}`)) {
        // touch building file to indicate that we are currently building delta image
        fs.closeSync(fs.openSync(buildingFile, 'w'));

        // Send 504, which informs supervisor that delta is in process
        res.sendStatus(504);

        // Continue executing delta process in background
        const srcStream = await docker.pull(src, auth);
        const destStream = await docker.pull(dest, auth);
        await Promise.all([
          waitForStream(srcStream),
          waitForStream(destStream),
        ]);

        // Create rsync delta file
        const deltaStream = dockerDelta
          .createDelta(src, dest, true, { log: console.log })
          .pipe(fs.createWriteStream(buildingFile));
        await once(deltaStream, 'finish');

        // Copy rsync delta file to rsync path
        fs.cpSync(buildingFile, `${deltaRsyncPath}/${deltaBase}`);

        // Remove building file
        if (fs.existsSync(buildingFile)) fs.rmSync(buildingFile);
      } else {
        // Set status to 300, which informs supervisor that delta is ready
        res.status(300);
        const downloadUrl = `https://${req.hostname}/api/v2/delta/download?delta=${deltaBase}`;
        debug(`Sending download url via location header: ${downloadUrl}`);
        res.set('location', downloadUrl);
      }
    } catch (err) {
      debug(`V2 delta error: ${err.message}}`);
      res.sendStatus(400);
      // Remove building file
      if (buildingFile && fs.existsSync(buildingFile)) fs.rmSync(buildingFile);
    }
  });

  app.get('/api/v2/delta/download', async (req, res) => {
    try {
      if (!req.query.delta) throw new Error('delta url param must be provided');
      const delta = String(req.query.delta);
      debug(`V2 delta download request received for delta: ${delta}`);

      const deltaRsyncFile = `${deltaRsyncPath}/${delta}`;
      if (!fs.existsSync(deltaRsyncFile))
        throw new Error('Requested delta does not exist!');

      // Set content-length header which is required by supervisor
      res.set('content-length', String(fs.statSync(deltaRsyncFile).size));

      // Stream delta file to response
      fs.createReadStream(deltaRsyncFile).pipe(res);
    } catch (err) {
      debug(`V2 delta download error: ${err.message}}`);
      res.sendStatus(400);
    }
  });

  app.listen(listenPort, () => {
    debug(`Listening on port: ${listenPort}`);
  });
}

createHttpServer(PORT);
