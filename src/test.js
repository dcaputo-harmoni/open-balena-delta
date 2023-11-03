const util = require('node:util');
const requestLib = require('request');
const request = util.promisify(requestLib);

function getRegistryAndName(image) {
  // Matches (registry)/(repo)(optional :tag or @digest)
  // regex adapted from Docker's source code:
  // https://github.com/docker/distribution/blob/release/2.7/reference/normalize.go#L62
  // https://github.com/docker/distribution/blob/release/2.7/reference/regexp.go#L44
  const match = image.match(
    /^(?:(localhost|.*?[.:].*?)\/)?(.+?)(?::(.*?))?(?:@(.*?))?$/
  );
  if (match == null) {
    throw new Error(`Could not parse the image: ${image}`);
  }
  const registry = match[match.length - 4];
  const imageName = match[match.length - 3];
  let tagName = match[match.length - 2];
  const digest = match[match.length - 1];
  if (digest == null && tagName == null) {
    tagName = 'latest';
  }
  const digestMatch =
    digest != null
      ? digest.match(
          /^[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-f-A-F]{32,}$/
        )
      : undefined;
  if (!imageName || (digest && !digestMatch)) {
    throw new Error(
      'Invalid image name, expected [domain.tld/]repo/image[:tag][@digest] format'
    );
  }
  return { registry, imageName, tagName, digest };
}

const getAuthToken = async (
  srcInfo,
  dstInfo,
  deltaOpts
) => {
  const tokenOpts = {
    auth: {
      user: `d_${deltaOpts.uuid}`,
      pass: deltaOpts.currentApiKey,
      sendImmediately: true,
    },
    json: true,
  };
  const tokenUrl = `${deltaOpts.apiEndpoint}/auth/v1/token?service=${dstInfo.registry}&scope=repository:${dstInfo.imageName}:pull&scope=repository:${srcInfo.imageName}:pull`;
  const tokenResponseBody = (
    await request(tokenUrl, tokenOpts)
  )[1];
  const token = tokenResponseBody?.token;

  if (token == null) {
    throw new Error('Authentication error');
  }

  return token;
};

async function fetchDeltaWithProgress(
  imgDest,
  deltaOpts
) {
  const logFn = (str) =>
    console.log(`delta(${deltaOpts.deltaSource}): ${str}`);

  if (![2, 3].includes(deltaOpts.deltaVersion)) {
    logFn(
      `Unsupported delta version: ${deltaOpts.deltaVersion}. Falling back to regular pull`
    );
    console.log('fetchImageWithProgress(imgDest, deltaOpts, onProgress)');
    return Promise.resolve('');
  }

  // Since the supevisor never calls this function with a source anymore,
  // this should never happen, but w ehandle it anyway
  if (deltaOpts.deltaSource == null) {
    logFn('Falling back to regular pull due to lack of a delta source');
    console.log('fetchImageWithProgress(imgDest, deltaOpts, onProgress)');
    return Promise.resolve('');
  }

  logFn(`Starting delta to ${imgDest}`);

  const [dstInfo, srcInfo] = await Promise.all([
    getRegistryAndName(imgDest),
    getRegistryAndName(deltaOpts.deltaSource),
  ]);

  const token = await getAuthToken(srcInfo, dstInfo, deltaOpts);

  const opts = {
    followRedirect: false,
    auth: {
      bearer: token,
      sendImmediately: true,
    },
  };

  const url = `${deltaOpts.deltaEndpoint}/api/v${deltaOpts.deltaVersion}/delta?src=${deltaOpts.deltaSource}&dest=${imgDest}`;

  const [res, data] = await request(url, opts);
  if (res.statusCode === 502 || res.statusCode === 504) {
    throw new Error();
  }
  try {
    if (res.statusCode !== 200) {
      throw new Error(
        `Got ${res.statusCode} when requesting v3 delta from delta server.`
      );
    }
    let name;
    try {
      name = JSON.parse(data).name;
    } catch (e) {
      throw new Error(
        `Got an error when parsing delta server response for v3 delta: ${e}`
      );
    }
    // applyBalenaDelta(name, token, onProgress, logFn);
    console.log(name);
  } catch (e) {
    logFn(`Delta failed with ${e}`);
    throw e;
  }

  logFn(`Delta applied successfully`);
}

// old
const imgDest = 'registry.openbalena.harmoni.io/v2/06d0d02c61e4a797653693543daf6994@sha256:5a108b0a715d94c7b4764c5f922432a68c4040b0256e8208387c9a64d935f78b'
const deltaOpts = {
  uuid: 'f162440e6ea8ffe5986b4a90a57da553',
  currentApiKey: '933fbf397bf8fde377f8c7dee7585497',
  apiEndpoint: 'https://delta.openbalena.harmoni.io',
  deltaEndpoint: 'https://delta.openbalena.harmoni.io',
  deltaVersion: 3,
  deltaSource: 'registry.openbalena.harmoni.io/v2/5a31b94a8fb42bd4d5c91a731695d566@sha256:59c007a8e4a1e9d08d57fb74232ec69506a9b18ff69cf3bbe2822637a24bdec0'
};

fetchDeltaWithProgress(imgDest, deltaOpts).then(() => console.log('done!'));
