import * as bodyParser from 'body-parser';
import * as express from 'express';

const PORT: number = 80;

async function createHttpServer(listenPort: number) {
	const app = express();
	
	app.use(bodyParser.json());

	app.listen(listenPort, () => {
		console.log('open-balena-delta is listening on port: ' + listenPort);
	});
}

createHttpServer(PORT);