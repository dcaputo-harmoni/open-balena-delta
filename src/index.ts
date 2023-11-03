import * as express from 'express';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as crypto from 'crypto';

const PORT = 80;
const DEBUG = true;

const exec = (cmd: string) => {
  if (DEBUG) console.log(`[open-balena-delta] EXECUTING COMMAND: ${cmd}`);
  const result = execSync(cmd);
  if (DEBUG) console.log(`[open-balena-delta] COMMAND RESULT: ${result}`);
  return result;
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
      const jwt = req.headers.authorization?.split(' ')?.[1];
      if (!src || !dest)
        throw new Error('src and dest url params must be provided');
      if (!jwt) throw new Error('authorization header must be provided');

      // Determine delta image tag
      const srcId = /^(.*)?\/v[0-9]+\/([0-9a-f]+)$/.exec(src as string)?.[2];
      const deltatag = `delta-${srcId}`;
      const deltaimg = `${dest}:${deltatag}`;
      const deltaimgId = /^(.*)?\/v[0-9]+\/([0-9a-f]+)$/.exec(deltaimg)?.[2];

      // Pull environment variables
      const registry = process.env.REGISTRY_HOST;
      const user = process.env.BALENAOS_USERNAME;
      const pass = process.env.BALENAOS_APIKEY;

      // Determine folders to work in
      const uuid = crypto.randomUUID();
      const tmpWorkdir = `/tmp/${uuid}`;
      const buildWorkdir = `/tmp/${deltaimgId}`;

      // set tmpWorkdir as active workdir and create it
      workdir = tmpWorkdir;
      fs.mkdirSync(tmpWorkdir);

      // Authenticate with registry and create auth.json
      exec(
        `buildah login --authfile ${tmpWorkdir}/auth.json -u ${user} -p ${pass} ${registry}`
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
      let exists = false;
      try {
        exec(
          `buildah manifest inspect --authfile ${tmpWorkdir}/auth.json ${deltaimg}`
        );
      } catch (err) {
        if (err.message.includes('application/vnd.oci.image.manifest.v1+json'))
          exists = true;
      }
      // Build delta image only if it doesn't already exist in the registry
      if (!exists) {
        // Move temp to build directory and populate with deltaimage binary
        fs.mkdirSync(buildWorkdir);
        fs.copyFileSync(`${tmpWorkdir}/auth.json`, `${buildWorkdir}/auth.json`);
        fs.rmSync(tmpWorkdir, { recursive: true });
        workdir = buildWorkdir;
        fs.copyFileSync(
          `/usr/local/bin/deltaimage`,
          `${buildWorkdir}/deltaimage`
        );

        // Setup buildah build params
        const auth = `--authfile ${buildWorkdir}/auth.json`;
        const stor = `--storage-driver vfs`;
        const quiet = DEBUG ? '' : '--quiet';

        // Generate diff image
        fs.writeFileSync(
          `${buildWorkdir}/Dockerfie.diff`,
          exec(`deltaimage docker-file diff ${src} ${dest}`)
            .toString()
            .replace(/--from=deltaimage\/deltaimage:0.1.0 \/opt/g, '.')
        );

        // Build diff dockerfile (--no-cache)
        exec(
          `buildah bud ${auth} ${stor} ${quiet} -f ${buildWorkdir}/Dockerfie.diff -t ${uuid} ${buildWorkdir}`
        );

        // Generate delta dockerfile
        fs.writeFileSync(
          `${buildWorkdir}/Dockerfie.delta`,
          exec(`deltaimage docker-file apply ${uuid}`)
            .toString()
            .replace(/--from=deltaimage\/deltaimage:0.1.0 \/opt/g, '.')
        );

        // Build delta image
        exec(
          `buildah bud ${auth} ${stor} ${quiet} -f ${buildWorkdir}/Dockerfie.delta -t ${deltaimg} ${buildWorkdir}`
        );

        // Push delta image
        exec(`buildah push ${auth} ${stor} ${dest}:${deltatag}`);

        // Delete diff and delta images (not needed locally)
        exec(`buildah rmi --storage-driver vfs ${uuid} ${dest}:${deltatag}`);
      }

      resp = JSON.stringify({ success: true, name: `${deltaimg}` });
    } catch (err) {
      resp = JSON.stringify({ success: false, message: err.message });
    }

    // Delete temp or build directory and all contents
    if (!DEBUG && workdir && fs.existsSync(workdir))
      fs.rmSync(workdir, { recursive: true });

    // Respond with result
    if (DEBUG) console.log(`[open-balena-delta] RESPONSE: ${resp}`);
    res.set('Content-Type', 'text/html');
    res.send(resp);
  });

  app.listen(listenPort, () => {
    console.log(`[open-balena-delta] Listening on port: ${listenPort}`);
  });
}

createHttpServer(PORT);
