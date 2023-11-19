import * as express from 'express';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { once } from 'events';
import dockerDelta = require('docker-delta');

const PORT = 80;
const DEBUG = true;

// Pull environment variables
const balenaTld = String(process.env.BALENA_TLD);
const registryHost = String(
  process.env.REGISTRY_HOST ?? `registry.${balenaTld}`
);
const builderToken = String(process.env.TOKEN_AUTH_BUILDER_TOKEN);

const exec = async (cmd: string[], cwd: string, noWait?: boolean) => {
  // remove any empty parameters
  cmd = cmd.filter((x) => x?.length > 0);
  if (DEBUG) console.log(`[open-balena-delta] Executing command: ${cmd}`);

  // set up execution environment
  const env = {
    DOCKER_CONFIG: `${cwd}/.docker`,
  };

  // split base command from args
  const baseCmd = cmd[0];
  const args = cmd.slice(1);

  const spawnStream = spawn(baseCmd, args, { cwd, env });
  let code = 0,
    stdout = '',
    stderr = '';
  spawnStream.stdout.on('data', (data) => {
    if (DEBUG) console.log(`[open-balena-delta] [${baseCmd}/stdout]: ${data}`);
    stdout += data;
  });
  spawnStream.stderr.on('data', (data) => {
    if (DEBUG) console.log(`[open-balena-delta] [${baseCmd}/stderr]: ${data}`);
    stderr += data;
  });
  spawnStream.on('close', (rc: number) => {
    if (DEBUG) console.log(`[open-balena-delta] [${baseCmd}/close]: ${code}`);
    code = rc;
  });
  if (!noWait) await once(spawnStream, 'close');
  return { code, stdout, stderr, spawnStream };
};

async function createHttpServer(listenPort: number) {
  const app = express();

  app.get('/api/v3/delta', async (req, res) => {
    let resp = '';

    // Set up build environment
    let workdir;

    try {
      // src = old image which we are transitioning from
      // dest = new image which we are transitioning to
      const { src, dest } = req.query;
      if (DEBUG)
        console.log(
          `[open-balena-delta] Delta request received: ${JSON.stringify({
            src,
            dest,
          })}`
        );
      // Parse input params
      const jwt = req.headers.authorization?.split(' ')?.[1];
      const IMG_REGEX = /^.*?\/v([0-9]+)\/([0-9a-f]+)(@sha256:([0-9a-f]+))?$/;
      const srcMatch = IMG_REGEX.exec(String(src));
      const destMatch = IMG_REGEX.exec(String(dest));

      // Validate input params
      if (!srcMatch || !destMatch)
        throw new Error('src and dest url params must be provided');
      if (!jwt) throw new Error('authorization header must be provided');
      const [, srcImgVer, srcImgBase] = srcMatch;
      const [, destImgVer, destImgBase] = destMatch;
      if (srcImgVer !== destImgVer) {
        throw new Error('src and dest image versions must match');
      }

      // Generate delta image name and path
      const deltaTag = `delta-${String(srcImgBase).substring(0, 16)}`;
      const deltaImgBase = `${destImgBase}:${deltaTag}`;
      const deltaImgFull = `v${destImgVer}/${deltaImgBase}`;
      const deltaImgPath = `${registryHost}/${deltaImgFull}`;

      // Determine folders to work in and diff image name
      const uuid = crypto.randomUUID();
      const tmpWorkdir = `/tmp/${uuid}`;
      const buildWorkdir = `/tmp/${deltaImgBase}`;

      // set tmpWorkdir as active workdir and create it
      workdir = tmpWorkdir;
      fs.mkdirSync(tmpWorkdir);

      // Authenticate with registry
      await exec(
        ['docker', 'login', '-u', 'builder', '-p', builderToken, registryHost],
        workdir
      );

      // Check if we are currently building delta image in a parallel process, if so, wait until complete
      if (fs.existsSync(buildWorkdir)) {
        let elapsedSecs = 0;
        const sec = () => new Promise((resolve) => setTimeout(resolve, 1000));
        do {
          await sec();
          elapsedSecs++;
        } while (fs.existsSync(buildWorkdir) && elapsedSecs < 60 * 20); // 20 min timeout
      }

      // Determine if delta image already exists in registry
      const exists =
        (await exec(['docker', 'manifest', 'inspect', deltaImgPath], workdir))
          .code === 0;

      // Build delta image only if it doesn't already exist in the registry
      if (!exists) {
        // Move temp to build directory and copy auth file
        fs.mkdirSync(buildWorkdir);
        fs.cpSync(`${tmpWorkdir}/.docker`, `${buildWorkdir}/.docker`, {
          recursive: true,
        });
        fs.rmSync(tmpWorkdir, { recursive: true });
        workdir = buildWorkdir;

        // Pull src image
        await exec(['docker', 'pull', String(src)], workdir);

        // Pull dest image
        await exec(['docker', 'pull', String(dest)], workdir);

        // Create delta image
        const deltaStream = dockerDelta.createDelta(src, dest, true, {
          log: console.log,
        });

        let imageId = '';

        deltaStream
          .pipe(dockerDelta.applyDelta(src, { log: console.log }))
          .on('id', (id: any) => {
            console.log('id', id);
            imageId = id;
          });

        // wait for delta to complete
        await once(deltaStream, 'close');

        // Tag imageId as delta image
        await exec(['docker', 'tag', imageId, deltaImgPath], workdir);

        // Push delta image
        await exec(['docker', 'push', deltaImgPath], workdir);

        // Delete delta image (not needed locally)
        await exec(['docker', 'rmi', deltaImgPath], workdir);
      }

      resp = JSON.stringify({ name: deltaImgPath });
    } catch (err) {
      // Do not return stringified object so that the JSON.parse in supervisor throws an error
      resp = err.message;
    }

    // Delete temp or build directory and all contents
    if (workdir && fs.existsSync(workdir))
      fs.rmSync(workdir, { recursive: true });

    // Respond with result
    if (DEBUG) console.log(`[open-balena-delta] RESPONSE: ${resp}`);
    res.set('content-type', 'text/plain');
    res.send(resp);
  });

  app.listen(listenPort, () => {
    console.log(`[open-balena-delta] Listening on port: ${listenPort}`);
  });
}

createHttpServer(PORT);
