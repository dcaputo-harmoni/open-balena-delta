import * as bodyParser from 'body-parser';
import * as express from 'express';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as crypto from 'crypto';

const PORT = 80;

async function createHttpServer(listenPort: number) {
	const app = express();
	
	app.use(bodyParser.json());

	app.get("/api/v3/delta", (req, res) => {
		const {src, dest} = req.query;
		const auth = req.headers["authorization"]?.split(' ')?.[1];
		if (!src || !dest || !auth) {
			return res.json({success: false, message: 'src and dest url params, and auth header, must be provided'});
		}
		const registry = process.env.OPEN_BALENA_REGISTRY;
		if (!registry) {
			return res.json({success: false, message: 'registry not configured!'});
		}

		const uuid = crypto.randomUUID();
		const workdir = `/tmp/${uuid}`;
		const authfile = `${workdir}/auth.json`;

		try {
			fs.mkdirSync(workdir);
			fs.writeFileSync(`${workdir}/auth.json`, {auths: {[registry]: {auth}}}.toString());
			fs.copyFileSync(`/usr/local/deltaimage`, `${workdir}/deltaimage`);
			const diff = execSync(`deltaimage docker-file diff ${src} ${dest}`).toString();
			fs.writeFileSync(`${workdir}/Dockerfie.diff`, diff.replace(/--from=deltaimage\/deltaimage:0.1.0 \/opt/g, '.'),'utf8');
			execSync(`buildah bud --authfile ${authfile} --no-cache -f ${workdir}/Dockerfie.diff -t ${uuid}-diff ${workdir}`);
			const delta = execSync(`deltaimage docker-file apply ${uuid}-diff`).toString();
			fs.writeFileSync(`${workdir}/Dockerfie.delta`, delta.replace(/--from=deltaimage\/deltaimage:0.1.0 \/opt/g, '.'),'utf8');
			execSync(`buildah bud --authfile ${authfile} --no-cache -f ${workdir}/Dockerfie.delta -t ${dest}:delta-XYZ ${workdir}`);
			execSync(`buildah push --authfile ${authfile} ${dest}:delta-XYZ`);
			execSync(`buildah rmi ${uuid}-diff`);
			fs.rmdirSync(workdir, {recursive: true}); 
			return res.json({success: true, name: `${dest}:delta`});
		} catch (err) {
			if (fs.existsSync(workdir)) fs.rmdirSync(workdir, {recursive: true}); 
			return res.json({success: false, message: err.message});
		}

	});	  

	app.listen(listenPort, () => {
		console.log(`open-balena-delta is listening on port: ${listenPort}`);
	});
}

createHttpServer(PORT);