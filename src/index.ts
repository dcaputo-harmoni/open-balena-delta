import express from 'express';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { once } from 'events';
import dockerDelta = require('docker-delta');
import Docker = require('dockerode');
import * as dt from 'docker-toolbelt';
import * as jwt from 'jsonwebtoken';

const PORT = 80;
const DEBUG = true;

const deltaRsyncPath = '/delta-rsync';

// Pull environment variables
const balenaTld = String(process.env.BALENA_TLD);
const regHost = String(process.env.REGISTRY_HOST ?? `registry.${balenaTld}`);
const builderToken = String(process.env.TOKEN_AUTH_BUILDER_TOKEN);

// Load public certificate and enable authentication
const alg = (process.env.JWT_ALGO ?? 'ES256') as jwt.Algorithm;
const pubFile = `/certs/private/api.${balenaTld}.pem`;
let pub: Buffer;
let authEnabled = false;
if (fs.existsSync(pubFile)) {
  authEnabled = true;
  pub = fs.readFileSync(pubFile);
}

// Authentication settings for dockerode
const authOpts = {
  authconfig: {
    username: 'builder',
    password: builderToken,
    serveraddress: regHost,
  },
};

// Authentication settings for docker-cli
const authFile = JSON.stringify({
  auths: {
    [regHost]: {
      auth: Buffer.from(`builder:${builderToken}`).toString('base64'),
    },
  },
});

const docker = new Docker();

// Debug healper function
const log = (msg: string) => {
  if (DEBUG) console.log(`[open-balena-delta] ${msg}`);
};

// Heper function to parse query params
const parseQueryParams = (query: any, headers: any) => {
  // src = old image which we are transitioning from
  // dest = new image which we are transitioning to
  log(`Parsing delta params: ${JSON.stringify({ query, headers })}`);
  if (!query.src || !query.dest)
    throw new Error('src and dest url params must be provided');
  const src = String(query.src);
  const dest = String(query.dest);
  // Parse input params
  const token = headers.authorization?.split(' ')?.[1];
  const wait = query.wait === 'true';
  return { src, dest, token, wait };
};

// Helper function to parse image tags into delta image tag and path
const parseDeltaParams = (src: string, dest: string) => {
  const IMG_REGEX = /^.*?\/v([0-9]+)\/([0-9a-f]+)(@sha256:([0-9a-f]+))?$/;
  const srcMatch = IMG_REGEX.exec(src);
  const destMatch = IMG_REGEX.exec(dest);

  // Validate input params
  if (!srcMatch || !destMatch)
    throw new Error('src and dest url params must be provided');
  const [, srcRegVer, srcImgBase] = srcMatch;
  const [, destRegVer, destImgBase] = destMatch;
  if (srcRegVer !== destRegVer) {
    throw new Error('src and dest image registry versions must match');
  }

  // Generate delta image name and path
  const deltaTag = `delta-${String(srcImgBase).substring(0, 16)}`;
  const deltaBase = `${destImgBase}:${deltaTag}`;
  const deltaFull = `v${destRegVer}/${deltaBase}`;
  const delta = `${regHost}/${deltaFull}`;

  return { deltaBase, deltaFull, delta };
};

// Helper function to wait for dockerode stream to finish
const waitForStream = async (stream: NodeJS.ReadableStream) => {
  if (DEBUG) stream.pipe(process.stdout);
  return new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (e) => {
      if (e) return reject(e);
      resolve();
    });
  });
};

// Helper function to handle detection of concurrent delta processes
const building = async (buildingFile: string, retryDelay: number) => {
  let buildingNow = fs.existsSync(buildingFile);
  if (buildingNow) {
    let waitTime = 0;
    const waitASec = () => new Promise((resolve) => setTimeout(resolve, 1000));
    while (buildingNow && waitTime < retryDelay) {
      await waitASec();
      waitTime += 1;
      buildingNow = fs.existsSync(buildingFile);
    }
  }
  return buildingNow;
};

// Helper function to check if image exists in registry using manifest inspect
const deltaExists = async (delta: string) => {
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
  return exists;
};

async function createHttpServer(listenPort: number) {
  const app = express();

  app.get('/api/v3/delta', async (req, res) => {
    let buildingFile;
    log('V3 delta request received');

    try {
      const { src, dest, token, wait } = parseQueryParams(
        req.query,
        req.headers
      );

      if (authEnabled) {
        if (!token) {
          throw new Error('authorization header must be provided');
        }
        jwt.verify(token, pub, { algorithms: [alg] });
      }

      const { deltaBase, delta } = parseDeltaParams(src, dest);

      buildingFile = `/tmp/${deltaBase}`;

      // Check if someone is building delta image in a parallel process
      if (await building(buildingFile, wait ? 15 * 60 : 45)) {
        if (wait) throw new Error('Delta image failed to build!');
        // send 504 if not waiting for build to complete
        res.sendStatus(504);
        return;
      }

      const success = () => {
        log(`Sending image name in response body: { name: "${delta}"}`);
        res.set('content-type', 'text/plain');
        res.send(JSON.stringify({ name: delta }));
      };

      // Return delta image if it exists
      if (await deltaExists(delta)) {
        success();
      } else {
        // If delta doesn't exist, send 504 (but keep building)
        if (!wait) res.sendStatus(504);

        // Check again if someone started building delta image in a parallel process
        if (!(await building(buildingFile, wait ? 15 * 60 : 0))) {
          // touch building file to indicate that we are currently building delta image
          fs.closeSync(fs.openSync(buildingFile, 'w'));

          // Continue executing delta process in background
          const srcStream = await docker.pull(src, authOpts);
          const destStream = await docker.pull(dest, authOpts);
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
          const pushStream = await docker.getImage(delta).push(authOpts);
          await waitForStream(pushStream);

          // Remove delta image (not needed)
          await docker.getImage(delta).remove(authOpts);

          // Consider removing src and dest images

          // Remove building file
          if (fs.existsSync(buildingFile)) fs.rmSync(buildingFile);

          // If we are waiting, and we got to this point, delta image was built successfully
          if (wait) success();
        } else if (wait) {
          // Parallel build was started, and we waited 15 minutes, so check again if build was successful
          if (await deltaExists(delta)) {
            success();
          } else {
            throw new Error('Delta image failed to build!');
          }
        }
      }
    } catch (err) {
      log(`V3 delta error: ${err.message}`);
      res.sendStatus(400);
      // Remove building file
      if (buildingFile && fs.existsSync(buildingFile)) fs.rmSync(buildingFile);
    }
  });

  app.get('/api/v2/delta', async (req, res) => {
    let buildingFile;

    log('V2 delta request received');

    try {
      const { src, dest, token, wait } = parseQueryParams(
        req.query,
        req.headers
      );

      if (authEnabled) {
        if (!token) {
          throw new Error('authorization header must be provided');
        }
        jwt.verify(token, pub, { algorithms: [alg] });
      }

      const { deltaBase } = parseDeltaParams(src, dest);

      buildingFile = `/tmp/${deltaBase}`;

      // Check if we are currently building delta image in a parallel process
      if (await building(buildingFile, wait ? 15 * 60 : 45)) {
        if (wait) throw new Error('Delta image failed to build!');
        // send 504 if not waiting for build to complete
        res.sendStatus(504);
        return;
      }

      const success = () => {
        const downloadUrl = `https://${req.hostname}/api/v2/delta/download?delta=${deltaBase}`;
        log(`Sending download url via location header: ${downloadUrl}`);
        // Set status to 300, which informs supervisor that delta is ready
        res.status(300);
        res.set('location', downloadUrl);
      };

      // Return delta image if it exists
      if (fs.existsSync(`${deltaRsyncPath}/${deltaBase}`)) {
        success();
      } else {
        // Send 504, which informs supervisor that delta is in process
        if (!wait) res.sendStatus(504);

        // Make sure someone else didn't start building delta image while we checked for existence
        if (!(await building(buildingFile, wait ? 15 * 60 : 0))) {
          // touch building file to indicate that we are currently building delta image
          fs.closeSync(fs.openSync(buildingFile, 'w'));

          // Continue executing delta process in background
          const srcStream = await docker.pull(src, authOpts);
          const destStream = await docker.pull(dest, authOpts);
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

          // Consider removing src and dest images

          // Remove building file
          if (fs.existsSync(buildingFile)) fs.rmSync(buildingFile);

          // If we are waiting, and we got to this point, delta image was built successfully
          if (wait) success();
        } else if (wait) {
          // Parallel build was started, and we waited 15 minutes, so check again if build was successful
          if (fs.existsSync(`${deltaRsyncPath}/${deltaBase}`)) {
            success();
          } else {
            throw new Error('Delta image failed to build!');
          }
        }
      }
    } catch (err) {
      log(`V2 delta error: ${err.message}`);
      res.sendStatus(400);
      // Remove building file
      if (buildingFile && fs.existsSync(buildingFile)) fs.rmSync(buildingFile);
    }
  });

  app.get('/api/v2/delta/download', async (req, res) => {
    try {
      if (!req.query.delta) throw new Error('delta url param must be provided');
      const delta = String(req.query.delta);
      log(`V2 delta download request received for delta: ${delta}`);

      const deltaRsyncFile = `${deltaRsyncPath}/${delta}`;
      if (!fs.existsSync(deltaRsyncFile))
        throw new Error('Requested delta does not exist!');

      // Set content-length header which is required by supervisor
      res.set('content-length', String(fs.statSync(deltaRsyncFile).size));

      // Stream delta file to response
      fs.createReadStream(deltaRsyncFile).pipe(res);
    } catch (err) {
      log(`V2 delta download error: ${err.message}}`);
      res.sendStatus(400);
    }
  });

  app.listen(listenPort, () => {
    log(`Listening on port: ${listenPort}`);
  });
}

createHttpServer(PORT);
